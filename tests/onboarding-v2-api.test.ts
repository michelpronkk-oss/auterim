import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  workspaceRole: vi.fn(),
  entitlements: vi.fn(),
  graph: vi.fn(),
  recordEvent: vi.fn(),
}));

vi.mock("@/lib/onboarding/auth", () => ({
  authenticateOnboardingRequest: mocks.authenticate,
  onboardingError: () => Response.json({ error: "onboarding_v2_unavailable" }, { status: 503 }),
  parseJsonBody: vi.fn(),
}));
vi.mock("@/lib/billing/server", () => ({
  getWorkspaceRole: mocks.workspaceRole,
  resolveWorkspaceEntitlementsForMember: mocks.entitlements,
}));
vi.mock("@/lib/onboarding/v2", () => ({
  deriveOnboardingRecommendations: vi.fn(),
  deriveProductBaselineStatus: vi.fn(),
  ONBOARDING_V2_STAGES: ["complete"],
}));
vi.mock("@/lib/protection/product-graph", () => ({
  getProductProtectionGraph: mocks.graph,
}));
vi.mock("@/lib/onboarding/dispatch-baselines", () => ({ dispatchOnboardingBaselines: vi.fn() }));
vi.mock("@/lib/growth-v2/feedback", () => ({ recordGrowthFirstPartyEvent: mocks.recordEvent }));

import { GET } from "@/app/api/onboarding/v2/route";
import { ProductProtectionReadError } from "@/lib/protection/read-stage";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";

function query(data: unknown) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    limit: async () => ({ data: [], error: null }),
    maybeSingle: async () => ({ data, error: null }),
  };
  return builder;
}

describe("onboarding v2 API diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: { id: "member-1" },
      client: {
        from: (table: string) =>
          query(
            table === "workspace_products"
              ? {
                  id: productId,
                  workspace_id: workspaceId,
                  name: "Test Product",
                  status: "protected",
                  is_default: false,
                  protected_at: "2026-01-01T00:00:00Z",
                  created_at: "2026-01-01T00:00:00Z",
                }
              : null,
          ),
        rpc: async (name: string) => ({
          data:
            name === "get_onboarding_status"
              ? {
                  company: { id: "company-1", name: "Test" },
                  discovery: { status: "complete", candidates: [] },
                  notificationPreferences: null,
                }
              : [],
          error: null,
        }),
      },
    });
    mocks.workspaceRole.mockResolvedValue("owner");
    mocks.entitlements.mockResolvedValue({ capabilities: { automaticPreflight: true } });
    mocks.graph.mockResolvedValue({ coverage: { authoritativeSourcesAvailable: 0 } });
  });

  it("keeps successful reads quiet", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await GET(
      new Request(
        `https://auterim.com/api/onboarding/v2?workspaceId=${workspaceId}&productId=${productId}`,
      ),
    );
    expect(response.status).toBe(200);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("keeps the generic 503 response and emits only a fixed stage on read failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.graph.mockRejectedValue(new ProductProtectionReadError("baseline_evidence"));

    const response = await GET(
      new Request(
        `https://auterim.com/api/onboarding/v2?workspaceId=${workspaceId}&productId=${productId}`,
      ),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "onboarding_v2_unavailable" });
    expect(log).toHaveBeenCalledExactlyOnceWith("Product protection read failed.", {
      stage: "baseline_evidence",
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /database|secret|token|workspace|22222222|member-1/i,
    );
    log.mockRestore();
  });
});
