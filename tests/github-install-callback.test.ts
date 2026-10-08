import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAccount: vi.fn(),
  listRepositories: vi.fn(),
  role: vi.fn(),
  entitlements: vi.fn(),
  getState: vi.fn(),
  getMembership: vi.fn(),
  consumeState: vi.fn(),
  upsertConnection: vi.fn(),
  upsertRepositories: vi.fn(),
}));

vi.mock("@/lib/env/schema", () => ({
  getEnvironment: () => ({
    GITHUB_APP_ID: "app-id-fixture",
    GITHUB_APP_PRIVATE_KEY: "private-key-fixture",
  }),
  isIntegrationConfigured: () => true,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: () => ({
    from(table: string) {
      let operation = "select";
      const query = {
        select: () => query,
        eq: () => query,
        is: () => query,
        gt: () => query,
        upsert(values: unknown, options?: unknown) {
          if (table === "repository_connections") mocks.upsertConnection(values, options);
          if (table === "repositories") mocks.upsertRepositories(values, options);
          return query;
        },
        update(values: unknown) {
          operation = "update";
          mocks.consumeState(values);
          return query;
        },
        async maybeSingle() {
          if (table === "repository_installation_states")
            return operation === "update" ? mocks.getState(true) : mocks.getState(false);
          if (table === "workspace_members") return mocks.getMembership();
          return { data: null, error: null };
        },
        async single() {
          return { data: { id: "connection-fixture" }, error: null };
        },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          return Promise.resolve({ error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  }),
}));

vi.mock("@/lib/billing/server", () => ({
  getWorkspaceRole: mocks.role,
  resolveWorkspaceEntitlementsForService: mocks.entitlements,
}));

vi.mock("@/lib/growth-v2/feedback", () => ({ recordGrowthFirstPartyEvent: vi.fn() }));

vi.mock("@/lib/preflight/github-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/preflight/github-provider")>();
  return {
    ...actual,
    GitHubAppRepositoryProvider: class {
      constructor() {}
      getInstallationAccount() {
        return mocks.getAccount();
      }
      listInstallationRepositories() {
        return mocks.listRepositories();
      }
    },
  };
});

import { GET } from "@/app/api/repositories/install/callback/route";
import { GitHubAppInstallationError } from "@/lib/preflight/github-provider";

const state = "oauth-state-test-sentinel";
const stateHash = createHash("sha256").update(state).digest("hex");
const workspaceId = "e140d48e-9dc0-4552-a9a4-a81fe3872422";
const stateRow = {
  workspace_id: workspaceId,
  actor_user_id: "user-fixture",
  state_hash: stateHash,
  github_login: "michelpronkk-oss",
  oauth_completed_at: "2026-10-08T00:00:00.000Z",
};
const repositories = [
  {
    id: 1001,
    owner: { login: "michelpronkk-oss" },
    name: "auterim-m15-github-qa",
    default_branch: "main",
    private: true,
    archived: false,
  },
];

function request() {
  return new Request(
    `https://auterim.com/api/repositories/install/callback?state=${state}&installation_id=2001&setup_action=install`,
  );
}

describe("GitHub App installation callback diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAccount.mockResolvedValue("michelpronkk-oss");
    mocks.listRepositories.mockResolvedValue(repositories);
    mocks.role.mockResolvedValue("owner");
    mocks.entitlements.mockResolvedValue({ capabilities: { repositoryConnections: true } });
    mocks.getState.mockImplementation((consuming: boolean) => ({
      data: consuming ? { state_hash: stateHash } : stateRow,
      error: null,
    }));
    mocks.getMembership.mockResolvedValue({ data: { workspace_id: workspaceId }, error: null });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("distinguishes App JWT rejection during installation metadata lookup", async () => {
    mocks.getAccount.mockRejectedValue(
      new GitHubAppInstallationError({
        stage: "installation_metadata",
        category: "app_jwt_rejected",
        upstreamStatus: 401,
      }),
    );

    const response = await GET(request());
    const diagnostic = JSON.parse(vi.mocked(console.warn).mock.calls[0]![1] as string);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "github_installation_unavailable" });
    expect(diagnostic).toMatchObject({
      stage: "installation_metadata",
      category: "app_jwt_rejected",
      upstreamStatus: 401,
    });
    expect(mocks.upsertConnection).not.toHaveBeenCalled();
    expect(mocks.consumeState).not.toHaveBeenCalled();
  });

  it("distinguishes installation token creation failure", async () => {
    mocks.listRepositories.mockRejectedValue(
      new GitHubAppInstallationError({
        stage: "installation_token",
        category: "permission_denied",
        upstreamStatus: 403,
      }),
    );

    const response = await GET(request());
    const diagnostic = JSON.parse(vi.mocked(console.warn).mock.calls[0]![1] as string);

    expect(response.status).toBe(503);
    expect(diagnostic).toMatchObject({ stage: "installation_token", upstreamStatus: 403 });
    expect(mocks.upsertConnection).not.toHaveBeenCalled();
    expect(mocks.consumeState).not.toHaveBeenCalled();
  });

  it("distinguishes repository enumeration failure", async () => {
    mocks.listRepositories.mockRejectedValue(
      new GitHubAppInstallationError({
        stage: "repository_list",
        category: "provider_unavailable",
        upstreamStatus: 502,
      }),
    );

    const response = await GET(request());
    const diagnostic = JSON.parse(vi.mocked(console.warn).mock.calls[0]![1] as string);

    expect(response.status).toBe(503);
    expect(diagnostic).toMatchObject({ stage: "repository_list", upstreamStatus: 502 });
    expect(mocks.upsertConnection).not.toHaveBeenCalled();
    expect(mocks.consumeState).not.toHaveBeenCalled();
  });

  it("persists the authorized connection and QA repository after successful provider checks", async () => {
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ connected: true, account: "michelpronkk-oss", repositoriesImported: 1 });
    expect(mocks.upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: workspaceId,
        provider: "github",
        installation_id: 2001,
        status: "connected",
      }),
      { onConflict: "workspace_id,provider,installation_id" },
    );
    expect(mocks.upsertRepositories).toHaveBeenCalledWith(
      [expect.objectContaining({ owner: "michelpronkk-oss", name: "auterim-m15-github-qa" })],
      { onConflict: "workspace_id,external_id" },
    );
    expect(mocks.consumeState).toHaveBeenCalledWith({ consumed_at: expect.any(String) });
  });

  it("leaves callback state reusable after a provider failure and permits a successful retry", async () => {
    mocks.listRepositories.mockRejectedValueOnce(
      new GitHubAppInstallationError({
        stage: "repository_list",
        category: "provider_unavailable",
        upstreamStatus: 503,
      }),
    );

    const failed = await GET(request());
    expect(failed.status).toBe(503);
    expect(mocks.consumeState).not.toHaveBeenCalled();
    expect(mocks.upsertConnection).not.toHaveBeenCalled();

    const retried = await GET(request());
    expect(retried.status).toBe(200);
    expect(mocks.consumeState).toHaveBeenCalledTimes(1);
    expect(mocks.upsertConnection).toHaveBeenCalledTimes(1);
  });

  it("keeps the failure response and server diagnostics free of state and credential material", async () => {
    const codeSentinel = "oauth-code-never-log";
    const tokenSentinel = "ghs_never_log_this";
    mocks.listRepositories.mockRejectedValue(
      new GitHubAppInstallationError({
        stage: "repository_list",
        category: "provider_unavailable",
      }),
    );

    const response = await GET(request());
    const output = `${JSON.stringify(await response.json())}\n${JSON.stringify([
      vi.mocked(console.info).mock.calls,
      vi.mocked(console.warn).mock.calls,
    ])}`;

    expect(output).not.toContain(state);
    expect(output).not.toContain(codeSentinel);
    expect(output).not.toContain(tokenSentinel);
    expect(output).not.toContain("private-key-fixture");
    expect(output).not.toContain("app-id-fixture");
  });

  it("rechecks workspace membership and entitlement before any provider or persistence work", async () => {
    mocks.getMembership.mockResolvedValueOnce({ data: null, error: null });
    const membershipDenied = await GET(request());
    expect(membershipDenied.status).toBe(403);
    expect(mocks.getAccount).not.toHaveBeenCalled();
    expect(mocks.upsertConnection).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.getState.mockImplementation((consuming: boolean) => ({
      data: consuming ? { state_hash: stateHash } : stateRow,
      error: null,
    }));
    mocks.getMembership.mockResolvedValue({ data: { workspace_id: workspaceId }, error: null });
    mocks.role.mockResolvedValue("owner");
    mocks.entitlements.mockResolvedValue({ capabilities: { repositoryConnections: false } });
    const entitlementDenied = await GET(request());
    expect(entitlementDenied.status).toBe(402);
    expect(mocks.getAccount).not.toHaveBeenCalled();
    expect(mocks.upsertConnection).not.toHaveBeenCalled();
  });
});
