import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  role: vi.fn(),
  entitlements: vi.fn(),
  providerHead: vi.fn(),
  rpc: vi.fn(),
  getEnvironment: vi.fn(),
  from: vi.fn(),
  serviceFrom: vi.fn(),
}));

vi.mock("@/lib/onboarding/auth", () => ({
  authenticateOnboardingRequest: mocks.authenticate,
}));
vi.mock("@/lib/billing/server", () => ({
  getWorkspaceRole: mocks.role,
  resolveWorkspaceEntitlementsForMember: mocks.entitlements,
}));
vi.mock("@/lib/preflight/github-provider", () => ({
  GitHubAppRepositoryProvider: class {
    getHead = mocks.providerHead;
  },
}));
vi.mock("@/lib/env/schema", () => ({ getEnvironment: mocks.getEnvironment }));
vi.mock("@/lib/connectors/service", () => ({
  serverConnectors: () => ({ from: mocks.serviceFrom, rpc: mocks.rpc }),
}));

import { POST } from "@/app/api/products/[id]/preflight/baseline/route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";
const repositoryId = "33333333-3333-4333-8333-333333333333";
const installationId = "44444444-4444-4444-8444-444444444444";
const commitSha = "a".repeat(40);

function queryResult(data: unknown) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
  };
  return query;
}

function request() {
  return new Request(`https://auterim.com/api/products/${productId}/preflight/baseline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId, repositoryId }),
  });
}

describe("baseline Preflight API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const byTable: Record<string, unknown> = {
      workspace_members: { role: "owner" },
      workspace_products: { id: productId, status: "protected" },
      repositories: {
        id: repositoryId,
        workspace_id: workspaceId,
        connection_id: installationId,
        external_id: 9902,
        owner: "michelpronkk-oss",
        name: "auterim",
        default_branch: "main",
        status: "available",
        selected_for_protection: true,
      },
      workspace_product_repositories: { repository_id: repositoryId },
      repository_connections: { installation_id: 9901, status: "connected" },
    };
    mocks.from.mockImplementation((table: string) => queryResult(byTable[table]));
    mocks.serviceFrom.mockImplementation((table: string) => queryResult(byTable[table]));
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: { id: "55555555-5555-4555-8555-555555555555" },
      client: { from: mocks.from },
    });
    mocks.role.mockResolvedValue("owner");
    mocks.entitlements.mockResolvedValue({
      capabilities: { automaticPreflight: true },
      usage: { preflightRuns: 0 },
      limits: { preflightRuns: 10 },
    });
    mocks.getEnvironment.mockReturnValue({
      GITHUB_APP_ID: "test-app",
      GITHUB_APP_PRIVATE_KEY: "test-key",
    });
    mocks.providerHead.mockResolvedValue(commitSha);
    mocks.rpc.mockResolvedValue({
      data: [
        {
          preflight_run_id: "66666666-6666-4666-8666-666666666666",
          baseline_evidence_id: "77777777-7777-4777-8777-777777777777",
          created: true,
          observed_at: "2026-10-12T12:00:00.000Z",
        },
      ],
      error: null,
    });
  });

  it("requires owner/admin before reading repository or calling GitHub", async () => {
    mocks.role.mockResolvedValue("member");
    const response = await POST(request(), { params: Promise.resolve({ id: productId }) });
    expect(response.status).toBe(403);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.providerHead).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("records a bounded exact repository-head baseline with no provider-change claims", async () => {
    const response = await POST(request(), { params: Promise.resolve({ id: productId }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toEqual({
      preflightRunId: "66666666-6666-4666-8666-666666666666",
      mode: "baseline",
      evidenceId: "77777777-7777-4777-8777-777777777777",
      repositoryId,
      repository: "michelpronkk-oss/auterim",
      verifiedCommitSha: commitSha,
      verificationState: "verified",
      observedAt: "2026-10-12T12:00:00.000Z",
      replayed: false,
    });
    expect(mocks.providerHead).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        id: repositoryId,
        installationId: 9901,
        owner: "michelpronkk-oss",
        name: "auterim",
      }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "persist_baseline_preflight",
      expect.objectContaining({
        p_workspace_id: workspaceId,
        p_product_id: productId,
        p_repository_id: repositoryId,
        p_commit_sha: commitSha,
        p_preflight_version: "baseline-v1",
      }),
    );
    const payload = JSON.stringify(body);
    expect(payload).not.toContain("test-key");
    expect(payload).not.toContain("impactAssessment");
    expect(payload).not.toContain("changeId");
  });

  it("rejects unprotected products before reading repository state", async () => {
    mocks.serviceFrom.mockImplementation((table: string) => {
      const data =
        table === "workspace_members"
          ? { role: "owner" }
          : table === "workspace_products"
            ? { id: productId, status: "draft" }
            : table === "repositories"
              ? { id: repositoryId }
              : table === "workspace_product_repositories"
                ? { repository_id: repositoryId }
                : null;
      return queryResult(data);
    });
    const response = await POST(request(), { params: Promise.resolve({ id: productId }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "baseline_preflight_ineligible" });
    expect(mocks.providerHead).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("keeps the public automaticPreflight entitlement gate enforced", async () => {
    mocks.entitlements.mockResolvedValue({
      capabilities: { automaticPreflight: false },
      usage: { preflightRuns: 0 },
      limits: { preflightRuns: 10 },
    });
    const response = await POST(request(), { params: Promise.resolve({ id: productId }) });
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: "preflight_not_entitled" });
    expect(mocks.serviceFrom).not.toHaveBeenCalled();
    expect(mocks.providerHead).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
