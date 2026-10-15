import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  role: vi.fn(),
  selfLock: vi.fn(),
  run: vi.fn(),
}));

vi.mock("@/lib/onboarding/auth", () => ({
  authenticateOnboardingRequest: mocks.authenticate,
}));
vi.mock("@/lib/billing/server", () => ({ getWorkspaceRole: mocks.role }));
vi.mock("@/lib/m15/deployment-acceptance", () => ({
  isM157CurrentAcceptanceComplete: mocks.selfLock,
}));
vi.mock("@/lib/m15/internal-acceptance", () => ({
  runM157InternalAcceptance: mocks.run,
}));

import { POST } from "@/app/api/internal/m157/deployment-acceptance/route";
import { withM157AcceptanceStage } from "../src/lib/m15/acceptance-completion.ts";

const workspaceId = "e140d48e-9dc0-4552-a9a4-a81fe3872422";
const userId = "55555555-5555-4555-8555-555555555555";

function request(
  url = "https://auterim.com/api/internal/m157/deployment-acceptance",
  body?: string,
) {
  return new Request(url, { method: "POST", ...(body === undefined ? {} : { body }) });
}

describe("fixed-target M15.7 production acceptance route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: { id: userId },
      client: { marker: "user-scoped" },
    });
    mocks.role.mockResolvedValue("owner");
    mocks.selfLock.mockResolvedValue(false);
    mocks.run.mockResolvedValue({ status: "complete", target: { workspaceName: "Test" } });
  });

  it("requires a normally authenticated request before checking membership", async () => {
    mocks.authenticate.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "authentication_required" }, { status: 401 }),
    });

    const result = await POST(request());

    expect(result.status).toBe(401);
    expect(mocks.role).not.toHaveBeenCalled();
    expect(mocks.selfLock).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each(["member", null])("denies non-admin workspace role %s", async (role) => {
    mocks.role.mockResolvedValue(role);

    const result = await POST(request());

    expect(result.status).toBe(403);
    expect(mocks.role).toHaveBeenCalledWith({ marker: "user-scoped" }, workspaceId, userId);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("rejects target selectors in query strings or request bodies", async () => {
    const targetQuery = await POST(
      request(
        `https://auterim.com/api/internal/m157/deployment-acceptance?workspaceId=${workspaceId}&productId=22222222-2222-4222-8222-222222222222&installationId=33333333-3333-4333-8333-333333333333&resourceId=44444444-4444-4444-8444-444444444444&sha=${"a".repeat(40)}`,
      ),
    );
    const targetBody = await POST(
      request(
        "https://auterim.com/api/internal/m157/deployment-acceptance",
        JSON.stringify({
          workspaceId,
          productId: "22222222-2222-4222-8222-222222222222",
          installationId: "33333333-3333-4333-8333-333333333333",
          resourceId: "44444444-4444-4444-8444-444444444444",
          sha: "a".repeat(40),
        }),
      ),
    );

    expect(targetQuery.status).toBe(400);
    expect(targetBody.status).toBe(400);
    expect(mocks.selfLock).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("runs the fixed internal acceptance exactly once after the self-lock says incomplete", async () => {
    const result = await POST(request());

    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(await result.json()).toEqual({ status: "complete", target: { workspaceName: "Test" } });
    expect(mocks.selfLock).toHaveBeenCalledOnce();
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.run).toHaveBeenCalledWith(userId);
  });

  it("accepts an empty POST body stream from a bodyless browser fetch", async () => {
    const result = await POST(request(undefined, ""));

    expect(result.status).toBe(200);
    expect(mocks.selfLock).toHaveBeenCalledOnce();
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("self-locks when exact current evidence already exists", async () => {
    mocks.selfLock.mockResolvedValue(true);

    const result = await POST(request());

    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ status: "already_completed" });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("returns only a safe failure category and never provider exception text", async () => {
    mocks.selfLock.mockRejectedValue(new Error("m157_acceptance_self_lock_provider_unavailable"));

    const result = await POST(request());

    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({
      error: "m157_acceptance_failed",
      category: "self_lock_provider_unavailable",
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("does not expose arbitrary thrown values", async () => {
    mocks.run.mockRejectedValue(new Error("Bearer secret-that-must-not-leak"));

    const result = await POST(request());

    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({
      error: "m157_acceptance_failed",
      category: "unknown_safe",
    });
  });

  it("returns a stage-specific safe category for a raw post-first-sync failure", async () => {
    mocks.run.mockImplementation(() =>
      withM157AcceptanceStage("first_protection_graph_unavailable", async () => {
        throw new Error("private provider response must not be exposed");
      }),
    );

    const result = await POST(request());

    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({
      error: "m157_acceptance_failed",
      category: "first_protection_graph_unavailable",
    });
  });
});
