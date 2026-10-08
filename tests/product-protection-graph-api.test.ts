import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  workspaceRole: vi.fn(),
  entitlements: vi.fn(),
  graph: vi.fn(),
}));

vi.mock("@/lib/onboarding/auth", () => ({ authenticateOnboardingRequest: mocks.authenticate }));
vi.mock("@/lib/billing/server", () => ({
  getWorkspaceRole: mocks.workspaceRole,
  resolveWorkspaceEntitlementsForMember: mocks.entitlements,
}));
vi.mock("@/lib/protection/product-graph", () => ({
  getProductProtectionGraph: mocks.graph,
}));

import { GET } from "@/app/api/products/[id]/protection-graph/route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";

describe("product protection graph API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({ ok: true, user: { id: "member-1" }, client: {} });
    mocks.workspaceRole.mockResolvedValue("member");
    mocks.entitlements.mockResolvedValue({ capabilities: { automaticPreflight: true } });
    mocks.graph.mockResolvedValue({
      product: { id: productId },
      identity: { state: "workspace_confirmed_dependencies_only" },
      coverage: { authoritativeSourcesAvailable: 1 },
      dependencies: [],
      repositories: [],
      dependencyRepositoryEdges: [],
    });
  });

  it("requires a valid workspace and product identity", async () => {
    const response = await GET(
      new Request("https://auterim.com/api/products/not-a-uuid/protection-graph?workspaceId=bad"),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it("denies users outside the requested workspace before loading the graph", async () => {
    mocks.workspaceRole.mockResolvedValue(null);
    const response = await GET(
      new Request(
        `https://auterim.com/api/products/${productId}/protection-graph?workspaceId=${workspaceId}`,
      ),
      { params: Promise.resolve({ id: productId }) },
    );
    expect(response.status).toBe(403);
    expect(mocks.graph).not.toHaveBeenCalled();
  });

  it("returns only the server-built graph and prevents shared caching", async () => {
    const response = await GET(
      new Request(
        `https://auterim.com/api/products/${productId}/protection-graph?workspaceId=${workspaceId}`,
      ),
      { params: Promise.resolve({ id: productId }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      product: { id: productId },
      identity: { state: "workspace_confirmed_dependencies_only" },
    });
    expect(mocks.graph).toHaveBeenCalledWith(
      {},
      {
        workspaceId,
        productId,
        verificationCapabilityAvailable: true,
      },
    );
  });
});
