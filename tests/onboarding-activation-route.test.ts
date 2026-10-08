import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  authRpc: vi.fn(),
  serviceRpc: vi.fn(),
  trigger: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@trigger.dev/sdk", () => ({
  idempotencyKeys: { create: vi.fn(async () => "safe-idempotency-key") },
  tasks: { trigger: mocks.trigger },
}));
vi.mock("@/lib/onboarding/auth", () => ({
  authenticateOnboardingRequest: mocks.authenticate,
  onboardingError: () => Response.json({ error: "safe_error" }, { status: 500 }),
  parseJsonBody: async (request: Request) => request.json(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: () => ({ rpc: mocks.serviceRpc, from: mocks.from }),
}));
vi.mock("@/lib/growth-v2/feedback", () => ({
  recordGrowthFirstPartyEvent: vi.fn(async () => undefined),
}));

import { POST } from "@/app/api/onboarding/activate/route";

const workspaceId = "e140d48e-9dc0-4552-a9a4-a81fe3872422";
const claim = {
  queue_id: "00000000-0000-4000-8000-000000000001",
  source_id: "00000000-0000-4000-8000-000000000002",
  dispatch_attempt: 1,
  lease_recovery_count: 0,
  recovered: false,
};

function request() {
  return new Request("https://auterim.test/api/onboarding/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
}

describe("onboarding activation baseline dispatch boundary", () => {
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    let statusCalls = 0;
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: { id: "00000000-0000-4000-8000-000000000010" },
      client: {
        rpc: vi.fn(async (name: string) => {
          if (name === "get_onboarding_status") {
            statusCalls++;
            return statusCalls === 1
              ? { data: { discovery: { candidates: [] } }, error: null }
              : { data: { activation: { baselineStatus: "in_progress" } }, error: null };
          }
          if (name === "activate_workspace_protection")
            return {
              data: {
                workspaceId,
                activatedAt: "2026-10-08T00:00:00.000Z",
                protection: {
                  dependencies: 1,
                  authoritativeSources: 1,
                  criticalDependencies: 0,
                  baselineStatus: "in_progress",
                },
              },
              error: null,
            };
          throw new Error("unexpected auth RPC");
        }),
      },
    });
    mocks.serviceRpc.mockImplementation(async (name: string) => {
      if (name === "claim_onboarding_baseline_sources") return { data: [], error: null };
      return { data: null, error: null };
    });
    mocks.trigger.mockResolvedValue({ id: "run-safe" });
    mocks.from.mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    });
    info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a claim RPC error distinctly and still completes activation", async () => {
    mocks.serviceRpc.mockImplementation(async (name: string) =>
      name === "claim_onboarding_baseline_sources"
        ? { data: null, error: { code: "XX000" } }
        : { data: null, error: null },
    );

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workspaceId });
    expect(warn).toHaveBeenCalledWith(
      "Onboarding baseline claim failed.",
      expect.objectContaining({ errorCategory: "claim_rpc_error", outcome: "error" }),
    );
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it("reports a successful empty claim separately", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(info).toHaveBeenCalledWith(
      "Onboarding baseline claim completed.",
      expect.objectContaining({ errorCategory: null, outcome: "empty" }),
    );
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it("keeps activation successful when Trigger dispatch temporarily fails", async () => {
    mocks.serviceRpc.mockImplementation(async (name: string) =>
      name === "claim_onboarding_baseline_sources"
        ? { data: [claim], error: null }
        : { data: null, error: null },
    );
    mocks.trigger.mockRejectedValue(new Error("raw provider details must not be logged"));

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(
      "Onboarding baseline dispatch observed.",
      expect.objectContaining({
        stage: "dispatch",
        errorCategory: "trigger_dispatch_failed",
        leaseRecoveryState: "lease_retained",
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("raw provider details");
    expect(mocks.serviceRpc).not.toHaveBeenCalledWith(
      "release_onboarding_baseline_claim",
      expect.anything(),
    );
  });
});
