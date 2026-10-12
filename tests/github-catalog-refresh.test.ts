import { describe, expect, it, vi } from "vitest";
import { refreshGitHubInstallationCatalog } from "@/lib/preflight/github-installation-connection";

const addedRepository = {
  id: 5002,
  name: "auterim",
  full_name: "michelpronkk-oss/auterim",
  owner: { login: "michelpronkk-oss" },
  default_branch: "main",
  private: true,
  archived: false,
};

function fixture() {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const updates: Array<Record<string, unknown>> = [];
  const update = vi.fn((values: Record<string, unknown>) => {
    updates.push(values);
    const query: Record<string, unknown> = {
      eq: () => query,
      in: async () => ({ error: null }),
    };
    return query;
  });
  const accessDelete = vi.fn(() => {
    const query: Record<string, unknown> = {
      eq: () => query,
      in: async () => ({ error: null }),
    };
    return query;
  });
  const repositoriesQuery: Record<string, unknown> = {
    eq: () => repositoriesQuery,
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({
        data: [
          { id: "old-repo-row", external_id: 4001 },
          { id: "new-repo-row", external_id: 5002 },
        ],
        error: null,
      }).then(resolve),
  };
  const connectionFilters: Array<[string, unknown]> = [];
  const connectionQuery: Record<string, unknown> = {
    eq: (column: string, value: unknown) => {
      connectionFilters.push([column, value]);
      return connectionQuery;
    },
    maybeSingle: async () => ({
      data: connectionFilters.some(
        ([column, value]) => column === "workspace_id" && value === "workspace-1",
      )
        ? {
            id: "connection-1",
            workspace_id: "workspace-1",
            provider: "github",
            installation_id: 2001,
            account_login: "michelpronkk-oss",
            status: "connected",
          }
        : null,
      error: null,
    }),
  };
  const from = vi.fn((table: string) => {
    if (table === "repository_connections") return { select: () => connectionQuery };
    if (table === "repositories")
      return {
        upsert,
        select: () => repositoriesQuery,
        update,
      };
    if (table === "workspace_repository_access") return { delete: accessDelete };
    throw new Error("unexpected_table");
  });
  const service = {
    from,
    rpc: vi.fn(),
  };
  const provider = {
    verifyInstallation: vi.fn().mockResolvedValue({ accountLogin: "michelpronkk-oss" }),
    listInstallationRepositories: vi.fn().mockResolvedValue([addedRepository]),
  };
  return { service, provider, upsert, update, updates, accessDelete };
}

describe("existing GitHub installation catalog refresh", () => {
  it("imports newly permitted repositories and marks removed catalog entries unavailable without protection writes", async () => {
    const f = fixture();
    const result = await refreshGitHubInstallationCatalog({
      service: f.service as never,
      provider: f.provider as never,
      workspaceId: "workspace-1",
      connectionId: "connection-1",
    });

    expect(result).toEqual({ repositoriesImported: 1, repositoriesRevoked: 1 });
    expect(f.provider.verifyInstallation).toHaveBeenCalledWith(2001);
    expect(f.provider.listInstallationRepositories).toHaveBeenCalledWith(2001);
    expect(f.upsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          workspace_id: "workspace-1",
          connection_id: "connection-1",
          external_id: 5002,
          owner: "michelpronkk-oss",
          name: "auterim",
        }),
      ],
      { onConflict: "workspace_id,external_id" },
    );
    expect(f.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "access_revoked", selected_for_protection: false }),
    );
    expect(f.accessDelete).toHaveBeenCalledOnce();
    expect(f.service.rpc).not.toHaveBeenCalled();
    expect(f.service.from).not.toHaveBeenCalledWith("workspace_product_repositories");
  });

  it("does not call GitHub or query outside the requested workspace connection", async () => {
    const f = fixture();
    await expect(
      refreshGitHubInstallationCatalog({
        service: f.service as never,
        provider: f.provider as never,
        workspaceId: "workspace-B",
        connectionId: "connection-A",
      }),
    ).rejects.toThrow("github_connection_not_found");
    expect(f.provider.verifyInstallation).not.toHaveBeenCalled();
    expect(f.provider.listInstallationRepositories).not.toHaveBeenCalled();
  });
});
