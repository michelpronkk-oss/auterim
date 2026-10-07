import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  role: vi.fn(),
  entitlements: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/onboarding/auth", () => ({
  authenticateOnboardingRequest: mocks.authenticate,
  parseJsonBody: async (request: Request) => request.json(),
}));
vi.mock("@/lib/billing/server", () => ({
  getWorkspaceRole: mocks.role,
  resolveWorkspaceEntitlementsForMember: mocks.entitlements,
}));

import { POST } from "@/app/api/preflight/[id]/handoff/route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const preflightId = "22222222-2222-4222-8222-222222222222";
const repositoryId = "33333333-3333-4333-8333-333333333333";

function request() {
  return new Request(`https://auterim.com/api/preflight/${preflightId}/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId, repositoryId, idempotencyKey: "handoff-test-001" }),
  });
}

describe("Business handoff API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: { id: "member-id" },
      client: { rpc: mocks.rpc },
    });
    mocks.role.mockResolvedValue("member");
    mocks.entitlements.mockResolvedValue({
      effectivePlan: "business",
      capabilities: { automaticDraftPr: true },
    });
    mocks.rpc.mockResolvedValue({
      data: {
        id: "44444444-4444-4444-8444-444444444444",
        status: "queued",
        claim_token: "must-not-be-exposed",
      },
      error: null,
    });
  });

  it("queues a Business handoff through the canonical workspace RPC without creating a PR", async () => {
    const response = await POST(request(), { params: Promise.resolve({ id: preflightId }) });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      requestId: "44444444-4444-4444-8444-444444444444",
      status: "queued",
      externalPullRequestCreated: false,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("request_business_handoff", {
      p_workspace_id: workspaceId,
      p_preflight_run_id: preflightId,
      p_repository_id: repositoryId,
      p_idempotency_key: "handoff-test-001",
    });
  });

  it("rejects Pro/Core before queuing Business-only work", async () => {
    mocks.entitlements.mockResolvedValue({
      effectivePlan: "pro",
      capabilities: { automaticDraftPr: false },
    });
    const response = await POST(request(), { params: Promise.resolve({ id: preflightId }) });
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: "business_plan_required" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace members before invoking the privileged queue operation", async () => {
    mocks.role.mockResolvedValue(null);
    const response = await POST(request(), { params: Promise.resolve({ id: preflightId }) });
    expect(response.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
