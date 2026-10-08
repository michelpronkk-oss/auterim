import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ accessibleRepositories: vi.fn() }));

vi.mock("@/lib/preflight/github-provider", () => ({
  GitHubAppInstallationError: class GitHubAppInstallationError extends Error {
    stage: string;
    category: string;
    constructor(input: { stage: string; category: string }) {
      super("safe_github_fixture_error");
      this.stage = input.stage;
      this.category = input.category;
    }
  },
  GitHubAppRepositoryProvider: class {},
  listUserAccessibleInstallationRepositories: mocks.accessibleRepositories,
}));

import { persistVerifiedGitHubInstallation } from "@/lib/preflight/github-installation-connection";

const installation = {
  id: 2001,
  appId: 1234,
  accountLogin: "acme-inc",
  targetType: "Organization" as const,
  repositorySelection: "selected" as const,
  permissions: { metadata: "read", contents: "read" },
  suspendedAt: null,
};
const repository = {
  id: 4001,
  name: "auterim-m15-github-qa",
  full_name: "michelpronkk-oss/auterim-m15-github-qa",
  owner: { login: "michelpronkk-oss" },
  default_branch: "main",
  private: true,
  archived: false,
};

function fixture() {
  const order: string[] = [];
  const upsertConnection = vi.fn(() => {
    order.push("connection");
    return {
      select: () => ({ single: async () => ({ data: { id: "connection-1" }, error: null }) }),
    };
  });
  const upsertRepositories = vi.fn(() => {
    order.push("repositories");
    return Promise.resolve({ error: null });
  });
  const consume = vi.fn(() => {
    order.push("consume");
    return {
      eq: () => ({
        is: () => ({
          gt: () => ({
            select: () => ({
              maybeSingle: async () => ({ data: { state_hash: "state-hash" }, error: null }),
            }),
          }),
        }),
      }),
    };
  });
  const service = {
    from(table: string) {
      if (table === "repository_connections") return { upsert: upsertConnection };
      if (table === "repositories") return { upsert: upsertRepositories };
      if (table === "repository_installation_states") return { update: consume };
      throw new Error("unexpected_table");
    },
  };
  const provider = {
    verifyInstallation: vi.fn().mockResolvedValue(installation),
    listInstallationRepositories: vi.fn().mockResolvedValue([repository]),
  };
  mocks.accessibleRepositories.mockResolvedValue([repository]);
  return { order, service, provider, upsertConnection, upsertRepositories, consume };
}

describe("persist verified GitHub installation", () => {
  it("persists idempotently after user and App authorization and consumes state last", async () => {
    const f = fixture();
    const result = await persistVerifiedGitHubInstallation({
      service: f.service as never,
      provider: f.provider as never,
      workspaceId: "workspace-1",
      actorUserId: "actor-1",
      stateHash: "state-hash",
      githubLogin: "alice",
      userAccessToken: "ephemeral-user-token",
      userInstallation: installation,
    });

    expect(result).toEqual({
      accountLogin: "acme-inc",
      repositoriesImported: 1,
      userAccessibleRepositoryCount: 1,
    });
    expect(f.provider.verifyInstallation).toHaveBeenCalledWith(2001);
    expect(f.provider.listInstallationRepositories).toHaveBeenCalledWith(2001);
    expect(f.upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: "workspace-1", installation_id: 2001 }),
      { onConflict: "workspace_id,provider,installation_id" },
    );
    expect(f.upsertRepositories).toHaveBeenCalledWith(
      [expect.objectContaining({ owner: "michelpronkk-oss", name: "auterim-m15-github-qa" })],
      { onConflict: "workspace_id,external_id" },
    );
    expect(f.order).toEqual(["connection", "repositories", "consume"]);
  });

  it("does not persist an installation if App authentication identifies a different installation", async () => {
    const f = fixture();
    vi.mocked(f.provider.verifyInstallation).mockResolvedValueOnce({
      ...installation,
      accountLogin: "other-org",
    });

    await expect(
      persistVerifiedGitHubInstallation({
        service: f.service as never,
        provider: f.provider as never,
        workspaceId: "workspace-1",
        actorUserId: "actor-1",
        stateHash: "state-hash",
        githubLogin: "alice",
        userAccessToken: "ephemeral-user-token",
        userInstallation: installation,
      }),
    ).rejects.toMatchObject({ category: "invalid_response" });
    expect(f.upsertConnection).not.toHaveBeenCalled();
    expect(f.consume).not.toHaveBeenCalled();
  });

  it("does not persist an installation if user-side repository authorization fails", async () => {
    const f = fixture();
    mocks.accessibleRepositories.mockRejectedValueOnce(new Error("user_access_denied"));

    await expect(
      persistVerifiedGitHubInstallation({
        service: f.service as never,
        provider: f.provider as never,
        workspaceId: "workspace-1",
        actorUserId: "actor-1",
        stateHash: "state-hash",
        githubLogin: "alice",
        userAccessToken: "ephemeral-user-token",
        userInstallation: installation,
      }),
    ).rejects.toMatchObject({ stage: "user_installation_authorization" });
    expect(f.provider.verifyInstallation).not.toHaveBeenCalled();
    expect(f.upsertConnection).not.toHaveBeenCalled();
  });
});
