import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  workspaceRole: vi.fn(),
  getEnvironment: vi.fn(),
  productIds: vi.fn(),
}));

vi.mock("@/lib/onboarding/auth", () => ({
  authenticateOnboardingRequest: mocks.authenticate,
}));
vi.mock("@/lib/billing/server", () => ({
  getWorkspaceRole: mocks.workspaceRole,
}));
vi.mock("@/lib/env/schema", () => ({
  getEnvironment: mocks.getEnvironment,
}));
vi.mock("@/lib/billing/plan-catalog", () => ({
  planProductIds: mocks.productIds,
}));

import { GET } from "@/app/api/billing/runtime/route";

const workspaceId = "e140d48e-9dc0-4552-a9a4-a81fe3872422";

function request(id = workspaceId) {
  return new Request(`https://auterim.com/api/billing/runtime?workspaceId=${id}`);
}

describe("GET /api/billing/runtime", () => {
  beforeEach(() => {
    mocks.authenticate.mockReset();
    mocks.workspaceRole.mockReset();
    mocks.getEnvironment.mockReset();
    mocks.productIds.mockReset();
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: { id: "authenticated-user" },
      client: {},
    });
    mocks.workspaceRole.mockResolvedValue("owner");
    mocks.getEnvironment.mockReturnValue({
      DODO_PAYMENTS_ENVIRONMENT: "test_mode",
      DODO_PAYMENTS_API_KEY: "secret-fixture-only",
    });
    mocks.productIds.mockReturnValue({
      core: "core-fixture",
      pro: "pro-fixture",
      business: "business-fixture",
    });
  });

  it("preserves the unauthenticated response", async () => {
    mocks.authenticate.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
    });

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.workspaceRole).not.toHaveBeenCalled();
    expect(mocks.getEnvironment).not.toHaveBeenCalled();
  });

  it("rejects an invalid workspace before checking billing configuration", async () => {
    const response = await GET(request("not-a-uuid"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_workspace_id" });
    expect(mocks.workspaceRole).not.toHaveBeenCalled();
    expect(mocks.getEnvironment).not.toHaveBeenCalled();
  });

  it.each([null, "member"])("denies unrelated or non-admin roles (%s)", async (role) => {
    mocks.workspaceRole.mockResolvedValue(role);

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(mocks.getEnvironment).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"] as const)(
    "allows workspace %s to read only safe mode fields",
    async (role) => {
      mocks.workspaceRole.mockResolvedValue(role);
      mocks.getEnvironment.mockReturnValue({
        DODO_PAYMENTS_ENVIRONMENT: "live_mode",
        DODO_PAYMENTS_API_KEY: "never-return-this-fixture",
        DODO_PAYMENTS_WEBHOOK_KEY: "never-return-this-either",
      });

      const response = await GET(request());
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(payload).toEqual({ mode: "live_mode", checkoutConfigured: true });
      expect(JSON.stringify(payload)).not.toContain("never-return-this");
      expect(Object.keys(payload).sort()).toEqual(["checkoutConfigured", "mode"]);
      expect(mocks.workspaceRole).toHaveBeenCalledWith({}, workspaceId, "authenticated-user");
    },
  );

  it("reports test mode and an unconfigured Pro checkout without exposing configuration", async () => {
    mocks.getEnvironment.mockReturnValue({ DODO_PAYMENTS_ENVIRONMENT: "test_mode" });
    mocks.productIds.mockReturnValue({ core: undefined, pro: "pro-fixture", business: undefined });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: "test_mode", checkoutConfigured: false });
  });

  it("does not claim Pro checkout is configured when plan identifiers collide", async () => {
    mocks.getEnvironment.mockReturnValue({
      DODO_PAYMENTS_ENVIRONMENT: "test_mode",
      DODO_PAYMENTS_API_KEY: "fixture",
    });
    mocks.productIds.mockReturnValue({ core: "same", pro: "same", business: undefined });

    const response = await GET(request());

    expect(await response.json()).toEqual({ mode: "test_mode", checkoutConfigured: false });
  });
});
