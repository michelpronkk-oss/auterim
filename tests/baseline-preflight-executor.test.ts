import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env/schema", () => ({
  getEnvironment: () => ({ GITHUB_APP_ID: "app-id", GITHUB_APP_PRIVATE_KEY: "private-key" }),
}));
vi.mock("@/lib/preflight/github-provider", () => ({
  GitHubAppRepositoryProvider: class {},
}));

import {
  BaselinePreflightError,
  executeBaselinePreflight,
} from "@/lib/preflight/baseline-executor";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";
const repositoryId = "33333333-3333-4333-8333-333333333333";
const actorUserId = "55555555-5555-4555-8555-555555555555";
const head = "a".repeat(40);
const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  rpc: vi.fn(),
  provider: vi.fn(),
}));

function queryResult(data: unknown) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
  };
  return query;
}

describe("shared baseline Preflight executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rows = {
      workspace_members: { role: "owner" },
      workspace_products: { id: productId, status: "protected" },
      repositories: {
        id: repositoryId,
        workspace_id: workspaceId,
        connection_id: "44444444-4444-4444-8444-444444444444",
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
    state.rpc.mockResolvedValue({
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
    state.provider.mockResolvedValue(head);
  });

  function service() {
    return {
      from: vi.fn((table: string) => queryResult(state.rows[table])),
      rpc: state.rpc,
    } as never;
  }

  it("rechecks the protected tenant mapping, resolves authoritative HEAD, and persists canonical evidence", async () => {
    const result = await executeBaselinePreflight({
      service: service(),
      actorUserId,
      workspaceId,
      productId,
      repositoryId,
      repositoryProvider: { getHead: state.provider },
    });
    expect(result).toMatchObject({
      mode: "baseline",
      evidenceId: "77777777-7777-4777-8777-777777777777",
      repository: "michelpronkk-oss/auterim",
      verifiedCommitSha: head,
      verificationState: "verified",
      replayed: false,
    });
    expect(state.provider).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        id: repositoryId,
        owner: "michelpronkk-oss",
        name: "auterim",
        installationId: 9901,
      }),
    );
    expect(state.rpc).toHaveBeenCalledWith(
      "persist_baseline_preflight",
      expect.objectContaining({
        p_actor_id: actorUserId,
        p_workspace_id: workspaceId,
        p_product_id: productId,
        p_repository_id: repositoryId,
        p_commit_sha: head,
        p_preflight_version: "baseline-v1",
      }),
    );
    const rpcArgs = state.rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(rpcArgs.p_repository_set_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not read repositories or call GitHub for a non-admin member", async () => {
    state.rows.workspace_members = { role: "member" };
    const db = service() as { from: ReturnType<typeof vi.fn>; rpc: typeof state.rpc };
    await expect(
      executeBaselinePreflight({
        service: db as never,
        actorUserId,
        workspaceId,
        productId,
        repositoryId,
        repositoryProvider: { getHead: state.provider },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(db.from).toHaveBeenCalledTimes(1);
    expect(state.provider).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["unprotected product", "workspace_products", { id: productId, status: "draft" }],
    ["missing active mapping", "workspace_product_repositories", null],
    [
      "unavailable repository",
      "repositories",
      {
        ...{
          id: repositoryId,
          workspace_id: workspaceId,
          connection_id: "44444444-4444-4444-8444-444444444444",
          external_id: 9902,
          owner: "michelpronkk-oss",
          name: "auterim",
          default_branch: "main",
          status: "archived",
          selected_for_protection: true,
        },
      },
    ],
  ])("blocks %s before provider access", async (_label, table, row) => {
    state.rows[table] = row;
    await expect(
      executeBaselinePreflight({
        service: service(),
        actorUserId,
        workspaceId,
        productId,
        repositoryId,
        repositoryProvider: { getHead: state.provider },
      }),
    ).rejects.toBeInstanceOf(BaselinePreflightError);
    expect(state.provider).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("fails closed when connection is not usable or repository is cross-tenant", async () => {
    state.rows.repository_connections = null;
    await expect(
      executeBaselinePreflight({
        service: service(),
        actorUserId,
        workspaceId,
        productId,
        repositoryId,
        repositoryProvider: { getHead: state.provider },
      }),
    ).rejects.toMatchObject({ code: "repository_unavailable" });
    state.rows.repository_connections = { installation_id: 9901, status: "connected" };
    state.rows.repositories = {
      ...(state.rows.repositories as object),
      workspace_id: "88888888-8888-4888-8888-888888888888",
    };
    await expect(
      executeBaselinePreflight({
        service: service(),
        actorUserId,
        workspaceId,
        productId,
        repositoryId,
        repositoryProvider: { getHead: state.provider },
      }),
    ).rejects.toMatchObject({ code: "baseline_preflight_ineligible" });
    expect(state.provider).not.toHaveBeenCalled();
  });

  it("reconciles retries through the canonical RPC without duplicating baseline evidence", async () => {
    state.rpc.mockResolvedValueOnce({
      data: [
        {
          preflight_run_id: "66666666-6666-4666-8666-666666666666",
          baseline_evidence_id: "77777777-7777-4777-8777-777777777777",
          created: false,
          observed_at: "2026-10-12T12:00:00.000Z",
        },
      ],
      error: null,
    });
    const result = await executeBaselinePreflight({
      service: service(),
      actorUserId,
      workspaceId,
      productId,
      repositoryId,
      repositoryProvider: { getHead: state.provider },
    });
    expect(result.replayed).toBe(true);
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });
});
