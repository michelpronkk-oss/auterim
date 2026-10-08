import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  entitlements: vi.fn(),
  state: vi.fn(),
  membership: vi.fn(),
}));

vi.mock("@/lib/env/schema", () => ({
  getEnvironment: () => ({
    GITHUB_APP_ID: "1234",
    GITHUB_APP_CLIENT_ID: "client-id-fixture",
    GITHUB_APP_SLUG: "auterim",
    NEXT_PUBLIC_APP_URL: "https://auterim.com",
  }),
  isIntegrationConfigured: () => true,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: () => ({
    from(table: string) {
      const query = {
        select: () => query,
        eq: () => query,
        is: () => query,
        gt: () => query,
        async maybeSingle() {
          if (table === "repository_installation_states") return mocks.state();
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

import { GET } from "@/app/api/repositories/install/callback/route";

const state = "a".repeat(43);
const stateHash = createHash("sha256").update(state).digest("hex");
const workspaceId = "e140d48e-9dc0-4552-a9a4-a81fe3872422";

function request(overrides = "") {
  return new Request(
    `https://auterim.com/api/repositories/install/callback?state=${state}&installation_id=2001&setup_action=install${overrides}`,
  );
}

describe("GitHub installation callback authorization handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role.mockResolvedValue("owner");
    mocks.entitlements.mockResolvedValue({ capabilities: { repositoryConnections: true } });
    mocks.state.mockResolvedValue({
      data: {
        workspace_id: workspaceId,
        actor_user_id: "workspace-owner",
        state_hash: stateHash,
        github_login: "michelpronkk-oss",
        oauth_completed_at: "2026-10-08T00:00:00.000Z",
      },
      error: null,
    });
    mocks.membership.mockResolvedValue({ data: { workspace_id: workspaceId }, error: null });
  });

  it("requires a fresh user-token authorization proof for the candidate installation", async () => {
    const response = await GET(request());
    const location = new URL(response.headers.get("location")!);

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("client-id-fixture");
    expect(location.searchParams.get("scope")).toBe("read:user");
    expect(location.searchParams.get("state")).toBe(`${state}.i2001`);
  });

  it("does not use installation_id as authorization or persist from the setup callback", async () => {
    const response = await GET(request());
    expect(response.headers.get("location")).toContain("login/oauth/authorize");
    expect(mocks.state).toHaveBeenCalledTimes(1);
  });

  it("rejects callback workspace swaps before starting OAuth", async () => {
    mocks.membership.mockResolvedValue({ data: null, error: null });
    const response = await GET(request());
    expect(new URL(response.headers.get("location")!).searchParams.get("github")).toBe(
      "workspace_access_revoked",
    );
  });

  it("rejects malformed candidate IDs without trusting them", async () => {
    const response = await GET(
      new Request(
        `https://auterim.com/api/repositories/install/callback?state=${state}&installation_id=2e9&setup_action=install`,
      ),
    );
    expect(new URL(response.headers.get("location")!).searchParams.get("github")).toBe(
      "invalid_state",
    );
    expect(mocks.state).not.toHaveBeenCalled();
  });
});
