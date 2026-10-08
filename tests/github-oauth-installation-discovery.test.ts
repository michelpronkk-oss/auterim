import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exchange: vi.fn(),
  listInstallations: vi.fn(),
  persist: vi.fn(),
  role: vi.fn(),
  entitlements: vi.fn(),
  state: vi.fn(),
  membership: vi.fn(),
  updateState: vi.fn(),
  getEnvironment: vi.fn(),
}));

vi.mock("@/lib/env/schema", () => ({
  getEnvironment: mocks.getEnvironment,
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
        update(values: unknown) {
          operation = "update";
          mocks.updateState(values);
          return query;
        },
        async maybeSingle() {
          if (table === "repository_installation_states")
            return operation === "update" ? mocks.updateState() : mocks.state();
          if (table === "workspace_members") return mocks.membership();
          return { data: null, error: null };
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

vi.mock("@/lib/preflight/github-provider", () => ({
  exchangeGitHubAppOAuthCode: mocks.exchange,
  listUserAccessibleGitHubAppInstallations: mocks.listInstallations,
  GitHubAppInstallationError: class GitHubAppInstallationError extends Error {
    stage: string;
    category: string;
    upstreamStatus?: number;
    constructor(input: { stage: string; category: string; upstreamStatus?: number }) {
      super("safe_github_fixture_error");
      this.stage = input.stage;
      this.category = input.category;
      this.upstreamStatus = input.upstreamStatus;
    }
  },
  GitHubAppRepositoryProvider: class {},
}));

vi.mock("@/lib/preflight/github-installation-connection", () => ({
  persistVerifiedGitHubInstallation: mocks.persist,
}));

vi.mock("@/lib/growth-v2/feedback", () => ({ recordGrowthFirstPartyEvent: vi.fn() }));

import { GET } from "@/app/api/repositories/install/oauth-callback/route";

const state = "b".repeat(43);
const stateHash = createHash("sha256").update(state).digest("hex");
const workspaceId = "e140d48e-9dc0-4552-a9a4-a81fe3872422";
const tokenSentinel = "ghu_test_token_must_not_escape_server";
const install = {
  id: 2001,
  appId: 1234,
  accountLogin: "acme-inc",
  targetType: "Organization" as const,
  repositorySelection: "selected" as const,
  permissions: { contents: "read", metadata: "read" },
  suspendedAt: null,
};

function request(callbackState = state) {
  return new Request(
    `https://auterim.com/api/repositories/install/oauth-callback?state=${callbackState}&code=oauth-code-sentinel`,
  );
}

describe("GitHub OAuth installation discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnvironment.mockReturnValue({
      GITHUB_APP_ID: "1234",
      GITHUB_APP_PRIVATE_KEY: "private-key-fixture",
      GITHUB_APP_CLIENT_ID: "client-id-fixture",
      GITHUB_APP_CLIENT_SECRET: "client-secret-fixture",
      GITHUB_APP_SLUG: "auterim",
      NEXT_PUBLIC_APP_URL: "https://auterim.com",
    });
    mocks.exchange.mockResolvedValue({ login: "alice", accessToken: tokenSentinel });
    mocks.listInstallations.mockResolvedValue([install]);
    mocks.persist.mockResolvedValue({
      accountLogin: "acme-inc",
      repositoriesImported: 1,
      userAccessibleRepositoryCount: 1,
    });
    mocks.role.mockResolvedValue("owner");
    mocks.entitlements.mockResolvedValue({ capabilities: { repositoryConnections: true } });
    mocks.state.mockResolvedValue({
      data: {
        workspace_id: workspaceId,
        actor_user_id: "workspace-owner",
        state_hash: stateHash,
        github_login: null,
        oauth_completed_at: null,
      },
      error: null,
    });
    mocks.membership.mockResolvedValue({ data: { workspace_id: workspaceId }, error: null });
    mocks.updateState.mockImplementation((values?: unknown) =>
      values ? undefined : { data: { state_hash: stateHash }, error: null },
    );
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  function markOAuthCompleted() {
    mocks.state.mockResolvedValue({
      data: {
        workspace_id: workspaceId,
        actor_user_id: "workspace-owner",
        state_hash: stateHash,
        github_login: "alice",
        oauth_completed_at: "2026-10-08T00:00:00.000Z",
      },
      error: null,
    });
  }

  it("recognizes one existing installation and persists only after both authorization sides agree", async () => {
    const response = await GET(request());
    const location = new URL(response.headers.get("location")!);

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://auterim.com/app/settings");
    expect(location.searchParams.get("github")).toBe("connected");
    expect(mocks.exchange).toHaveBeenCalledWith(
      expect.objectContaining({ code: "oauth-code-sentinel" }),
    );
    expect(mocks.listInstallations).toHaveBeenCalledWith({
      accessToken: tokenSentinel,
      appId: "1234",
    });
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        actorUserId: "workspace-owner",
        stateHash,
        githubLogin: "alice",
        userAccessToken: tokenSentinel,
        userInstallation: install,
      }),
    );
    expect(location.toString()).not.toContain(tokenSentinel);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(tokenSentinel);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(tokenSentinel);
  });

  it("continues to normal installation only when the authorized user has no existing app installation", async () => {
    mocks.listInstallations.mockResolvedValue([]);
    const response = await GET(request());
    const location = new URL(response.headers.get("location")!);

    expect(location.origin + location.pathname).toBe(
      "https://github.com/apps/auterim/installations/new",
    );
    expect(location.searchParams.get("state")).toBe(state);
    expect(mocks.updateState).toHaveBeenCalledWith(
      expect.objectContaining({ github_login: "alice", oauth_completed_at: expect.any(String) }),
    );
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("returns a typed selection-required state rather than choosing the first installation", async () => {
    mocks.listInstallations.mockResolvedValue([
      install,
      { ...install, id: 2002, accountLogin: "alice", targetType: "User" },
    ]);
    const response = await GET(request());

    expect(new URL(response.headers.get("location")!).searchParams.get("github")).toBe(
      "installation_selection_required",
    );
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("requires the candidate installation to be present in the fresh user authorization result", async () => {
    markOAuthCompleted();
    const response = await GET(request(`${state}.i2002`));

    expect(new URL(response.headers.get("location")!).searchParams.get("github")).toBe(
      "installation_not_authorized",
    );
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("requires the candidate callback to use the same GitHub user authorized before installation", async () => {
    markOAuthCompleted();
    mocks.exchange.mockResolvedValue({ login: "mallory", accessToken: tokenSentinel });
    const response = await GET(request(`${state}.i2001`));

    expect(new URL(response.headers.get("location")!).searchParams.get("github")).toBe(
      "installation_identity_mismatch",
    );
    expect(mocks.listInstallations).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("supports organization installs even when the OAuth user login differs", async () => {
    const response = await GET(request());

    expect(response.headers.get("location")).toContain("github=connected");
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        githubLogin: "alice",
        userInstallation: expect.objectContaining({ accountLogin: "acme-inc" }),
      }),
    );
  });

  it("does not persist suspended installations", async () => {
    mocks.listInstallations.mockResolvedValue([
      { ...install, suspendedAt: "2026-10-08T00:00:00Z" },
    ]);
    const response = await GET(request());

    expect(new URL(response.headers.get("location")!).searchParams.get("github")).toBe(
      "installation_suspended",
    );
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("does not persist installations with write permissions", async () => {
    mocks.listInstallations.mockResolvedValue([
      { ...install, permissions: { contents: "write", metadata: "read" } },
    ]);
    const response = await GET(request());

    expect(new URL(response.headers.get("location")!).searchParams.get("github")).toBe(
      "permissions_unavailable",
    );
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("keeps state reusable after a prior callback failure and rechecks current workspace authority", async () => {
    markOAuthCompleted();
    const response = await GET(request(`${state}.i2001`));

    expect(response.headers.get("location")).toContain("github=connected");
    expect(mocks.role).toHaveBeenCalledWith(expect.anything(), workspaceId, "workspace-owner");
    expect(mocks.entitlements).toHaveBeenCalledWith(workspaceId);
  });

  it("does not attach the installation when workspace membership is revoked", async () => {
    mocks.membership.mockResolvedValue({ data: null, error: null });
    const response = await GET(request());

    expect(new URL(response.headers.get("location")!).searchParams.get("github")).toBe(
      "workspace_access_revoked",
    );
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("consumes an installation-candidate state only through verified persistence", async () => {
    markOAuthCompleted();
    const response = await GET(request(`${state}.i2001`));
    expect(response.headers.get("location")).toContain("github=connected");
    expect(mocks.persist).toHaveBeenCalledTimes(1);
  });
});
