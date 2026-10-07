import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  workspaceRole: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/onboarding/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/onboarding/auth")>();
  return {
    ...actual,
    authenticateOnboardingRequest: mocks.authenticate,
    parseJsonBody: async (request: Request) => request.json(),
  };
});
vi.mock("@/lib/billing/server", () => ({ getWorkspaceRole: mocks.workspaceRole }));

import { GET, PATCH } from "@/app/api/products/[id]/remediation-policy/route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";
const repositoryId = "33333333-3333-4333-8333-333333333333";

function queryResult(data: unknown) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
  };
  return query;
}

describe("product remediation policy API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspaceRole.mockResolvedValue("owner");
    mocks.from.mockImplementation((table: string) =>
      queryResult(table === "workspace_products" ? { id: productId } : null),
    );
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: { id: "owner-id" },
      client: { from: mocks.from, rpc: mocks.rpc },
    });
  });

  it("returns a conservative default without enabling automated handoff", async () => {
    const response = await GET(
      new Request(
        `https://auterim.com/api/products/${productId}/remediation-policy?workspaceId=${workspaceId}`,
        {
          headers: { authorization: "Bearer test-token" },
        },
      ),
      { params: Promise.resolve({ id: productId }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      policy: {
        workspaceId,
        productId,
        version: 0,
        enabled: false,
        humanReviewRequired: true,
        draftPrPreparationAllowed: false,
        automaticWorkflowHandoffAllowed: false,
        approvalRequired: true,
        allowedRepositoryIds: [],
        updatedAt: null,
      },
    });
  });

  it("requires owner/admin to persist policy through the server-checked RPC", async () => {
    mocks.workspaceRole.mockResolvedValue("member");
    const response = await PATCH(
      new Request(`https://auterim.com/api/products/${productId}/remediation-policy`, {
        method: "PATCH",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          enabled: true,
          draftPrPreparationAllowed: true,
          automaticWorkflowHandoffAllowed: true,
          approvalRequired: true,
          allowedRepositoryIds: [repositoryId],
        }),
      }),
      { params: Promise.resolve({ id: productId }) },
    );

    expect(response.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("persists allowed repositories and returns the server-incremented policy version", async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        workspace_id: workspaceId,
        product_id: productId,
        policy_version: 3,
        enabled: true,
        human_review_required: true,
        draft_pr_preparation_allowed: true,
        automatic_workflow_handoff_allowed: true,
        approval_required: true,
        allowed_repository_ids: [repositoryId],
        updated_at: "2026-10-06T12:00:00.000Z",
      },
      error: null,
    });
    const response = await PATCH(
      new Request(`https://auterim.com/api/products/${productId}/remediation-policy`, {
        method: "PATCH",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          enabled: true,
          draftPrPreparationAllowed: true,
          automaticWorkflowHandoffAllowed: true,
          approvalRequired: true,
          allowedRepositoryIds: [repositoryId],
        }),
      }),
      { params: Promise.resolve({ id: productId }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("set_product_remediation_policy", {
      p_workspace_id: workspaceId,
      p_product_id: productId,
      p_enabled: true,
      p_draft_pr_preparation_allowed: true,
      p_automatic_workflow_handoff_allowed: true,
      p_approval_required: true,
      p_allowed_repository_ids: [repositoryId],
    });
    expect(await response.json()).toMatchObject({
      policy: { version: 3, humanReviewRequired: true },
    });
  });
});
