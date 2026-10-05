import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/onboarding/auth", () => ({
  authenticateOnboardingRequest: mocks.authenticate,
  parseJsonBody: async (request: Request) => request.json(),
  onboardingError: (error: { code?: string } | Error) =>
    Response.json(
      { error: "dependency_operation_failed" },
      { status: "code" in error && error.code === "42501" ? 403 : 500 },
    ),
}));

import { GET, POST } from "@/app/api/products/[id]/dependencies/route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";

describe("product dependency API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: { id: "member-id" },
      client: { rpc: mocks.rpc },
    });
  });

  it("reads dependencies through the membership-checked product read model", async () => {
    const response = await GET(
      new Request(
        `https://auterim.com/api/products/${productId}/dependencies?workspaceId=${workspaceId}`,
        {
          headers: { authorization: "Bearer test-token" },
        },
      ),
      { params: Promise.resolve({ id: productId }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("get_product_dependencies", {
      p_workspace_id: workspaceId,
      p_product_id: productId,
    });
  });

  it("targets candidate confirmation to the selected product", async () => {
    const candidateId = "33333333-3333-4333-8333-333333333333";
    const response = await POST(
      new Request(`https://auterim.com/api/products/${productId}/dependencies`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({
          action: "decision",
          workspaceId,
          candidateId,
          decision: "confirmed",
        }),
      }),
      { params: Promise.resolve({ id: productId }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("decide_product_dependency_candidate", {
      p_workspace_id: workspaceId,
      p_product_id: productId,
      p_candidate_id: candidateId,
      p_decision: "confirmed",
    });
  });

  it("targets manual catalog additions to the selected product", async () => {
    const response = await POST(
      new Request(`https://auterim.com/api/products/${productId}/dependencies`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ action: "manual_add", workspaceId, dependencySlug: "openai" }),
      }),
      { params: Promise.resolve({ id: productId }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("add_product_dependency_manually", {
      p_workspace_id: workspaceId,
      p_product_id: productId,
      p_dependency_slug: "openai",
    });
  });
});
