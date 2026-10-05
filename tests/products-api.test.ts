import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  workspaceRole: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/onboarding/auth", () => ({
  authenticateOnboardingRequest: mocks.authenticate,
  parseJsonBody: async (request: Request) => request.json(),
}));
vi.mock("@/lib/billing/server", () => ({ getWorkspaceRole: mocks.workspaceRole }));

import { GET, POST } from "@/app/api/products/route";
import { PATCH } from "@/app/api/products/[id]/route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";

function queryResult(data: unknown) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    order: vi.fn(() => query),
    then: (resolve: (value: { data: unknown; error: null }) => unknown) =>
      Promise.resolve(resolve({ data, error: null })),
  };
  return query;
}

describe("products API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspaceRole.mockResolvedValue("owner");
    mocks.from.mockImplementation((table: string) =>
      queryResult(
        table === "workspace_products"
          ? [{ id: productId, workspace_id: workspaceId, name: "Auterim", status: "protected" }]
          : [
              {
                id: "surface-id",
                product_id: productId,
                surface_type: "docs",
                url: "https://docs.example/",
              },
            ],
      ),
    );
    mocks.rpc.mockResolvedValue({ data: { product: { id: productId } }, error: null });
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: { id: "owner-id" },
      client: { from: mocks.from, rpc: mocks.rpc },
    });
  });

  it("returns workspace-authorized products and their associated surfaces", async () => {
    const response = await GET(
      new Request(`https://auterim.com/api/products?workspaceId=${workspaceId}`, {
        headers: { authorization: "Bearer test-token" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      products: [
        { id: productId, surfaces: [{ surface_type: "docs", url: "https://docs.example/" }] },
      ],
    });
  });

  it("requires an owner/admin before calling the server-enforced create/replace operation", async () => {
    mocks.workspaceRole.mockResolvedValue("member");
    const response = await POST(
      new Request("https://auterim.com/api/products", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          "idempotency-key": "create-console-001",
        },
        body: JSON.stringify({
          workspaceId,
          name: "Console",
          replaceProductId: productId,
          surfaces: [
            { surfaceType: "app", url: "https://app.example/" },
            { surfaceType: "docs", url: "https://docs.example/" },
          ],
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("passes multiple surfaces and an explicit replacement through one atomic RPC", async () => {
    const surfaces = [
      { surfaceType: "app", url: "https://app.example/" },
      { surfaceType: "docs", url: "https://docs.example/" },
    ];
    const response = await POST(
      new Request("https://auterim.com/api/products", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          "idempotency-key": "create-console-001",
        },
        body: JSON.stringify({
          workspaceId,
          name: "Console",
          surfaces,
          replaceProductId: productId,
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.rpc).toHaveBeenCalledWith("create_workspace_product_idempotent", {
      p_workspace_id: workspaceId,
      p_name: "Console",
      p_surfaces: surfaces,
      p_replace_product_id: productId,
      p_idempotency_key: "create-console-001",
    });
  });

  it("requires an idempotency key before product creation", async () => {
    const response = await POST(
      new Request("https://auterim.com/api/products", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, name: "Console", surfaces: [] }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "idempotency_key_required" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("maps last-default archive rejection to a conflict without deleting history", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "23514", message: "default_product_replacement_required" },
    });
    const response = await PATCH(
      new Request(`https://auterim.com/api/products/${productId}`, {
        method: "PATCH",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, action: "archive" }),
      }),
      { params: Promise.resolve({ id: productId }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "default_product_replacement_required" });
    expect(mocks.rpc).toHaveBeenCalledWith("archive_workspace_product", {
      p_workspace_id: workspaceId,
      p_product_id: productId,
    });
  });
});
