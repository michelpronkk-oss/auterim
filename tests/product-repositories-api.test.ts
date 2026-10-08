import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  entitlements: vi.fn(),
  readModel: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/onboarding/auth", () => ({ authenticateOnboardingRequest: mocks.authenticate }));
vi.mock("@/lib/billing/server", () => ({
  resolveWorkspaceEntitlementsForMember: mocks.entitlements,
}));
vi.mock("@/lib/repositories/product-protection-read-model", () => ({
  getProductRepositoryProtection: mocks.readModel,
}));

import { GET } from "@/app/api/products/[id]/repositories/route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";

function query(data: unknown) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
  };
  return builder;
}

describe("Product repositories API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const tables: Record<string, unknown> = {
      workspace_members: { workspace_id: workspaceId },
      workspace_products: { id: productId },
    };
    mocks.from.mockImplementation((table: string) => query(tables[table]));
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: { id: "member-id" },
      client: { from: mocks.from },
    });
    mocks.entitlements.mockResolvedValue({
      capabilities: { automaticPreflight: true },
      usage: { repositories: 0 },
      limits: { repositories: 5 },
    });
    mocks.readModel.mockResolvedValue({
      product: { id: productId },
      mappedRepositories: [],
      accessibleUnmappedRepositories: [{ id: "qa-repository" }],
    });
  });

  it("returns the Product repository read model as private and non-cacheable", async () => {
    const response = await GET(
      new Request(
        `https://auterim.com/api/products/${productId}/repositories?workspaceId=${workspaceId}`,
      ),
      { params: Promise.resolve({ id: productId }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      product: { id: productId },
      accessibleUnmappedRepositories: [{ id: "qa-repository" }],
      protectionUsage: { protectedRepositories: 0, repositoryLimit: 5 },
    });
    expect(mocks.readModel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspaceId, productId }),
    );
  });

  it("denies an unrelated workspace member before loading repository data", async () => {
    mocks.from.mockImplementation((table: string) =>
      query(table === "workspace_members" ? null : { id: productId }),
    );

    const response = await GET(
      new Request(
        `https://auterim.com/api/products/${productId}/repositories?workspaceId=${workspaceId}`,
      ),
      { params: Promise.resolve({ id: productId }) },
    );

    expect(response.status).toBe(403);
    expect(mocks.readModel).not.toHaveBeenCalled();
  });
});
