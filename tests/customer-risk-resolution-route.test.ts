import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/onboarding/auth", () => ({
  authenticateOnboardingRequest: mocks.authenticate,
}));

import { POST } from "@/app/api/protection/[id]/resolve/route";

const impactAssessmentId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";

describe("customer risk resolution route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
      client: { rpc: mocks.rpc },
    });
  });

  it("records an authenticated, workspace-scoped resolution via the canonical RPC", async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        id: "resolution-1",
        workspace_id: workspaceId,
        impact_assessment_id: impactAssessmentId,
        resolution_kind: "reviewed",
      },
      error: null,
    });

    const response = await POST(
      new Request("https://auterim.com/api/protection/test/resolve", {
        method: "POST",
        body: JSON.stringify({ workspaceId, resolutionKind: "reviewed" }),
      }),
      { params: Promise.resolve({ id: impactAssessmentId }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("resolve_customer_risk", {
      p_workspace_id: workspaceId,
      p_impact_assessment_id: impactAssessmentId,
      p_resolution_kind: "reviewed",
    });
  });

  it("rejects unsupported resolution values before reaching the database", async () => {
    const response = await POST(
      new Request("https://auterim.com/api/protection/test/resolve", {
        method: "POST",
        body: JSON.stringify({ workspaceId, resolutionKind: "fixed_by_auterim" }),
      }),
      { params: Promise.resolve({ id: impactAssessmentId }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("does not expose internal database errors", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "XX000", message: "private detail" },
    });

    const response = await POST(
      new Request("https://auterim.com/api/protection/test/resolve", {
        method: "POST",
        body: JSON.stringify({ workspaceId, resolutionKind: "reviewed" }),
      }),
      { params: Promise.resolve({ id: impactAssessmentId }) },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "risk_resolution_unavailable" });
  });
});
