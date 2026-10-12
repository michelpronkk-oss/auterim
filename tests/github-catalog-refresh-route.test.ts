import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  role: vi.fn(),
  entitlements: vi.fn(),
  refresh: vi.fn(),
  serviceConnections: vi.fn(),
}));

vi.mock("@/lib/onboarding/auth", () => ({
  authenticateOnboardingRequest: mocks.auth,
  parseJsonBody: (request: Request) => request.json(),
}));
vi.mock("@/lib/billing/server", () => ({
  getWorkspaceRole: mocks.role,
  resolveWorkspaceEntitlementsForMember: mocks.entitlements,
}));
vi.mock("@/lib/env/schema", () => ({
  getEnvironment: () => ({ GITHUB_APP_ID: "1234", GITHUB_APP_PRIVATE_KEY: "private-key" }),
  isIntegrationConfigured: () => true,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({ limit: mocks.serviceConnections }),
          }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/preflight/github-provider", () => ({
  GitHubAppInstallationError: class GitHubAppInstallationError extends Error {
    stage = "repository_list";
    category = "permission_denied";
  },
  GitHubAppRepositoryProvider: class {},
}));
vi.mock("@/lib/preflight/github-installation-connection", () => ({
  refreshGitHubInstallationCatalog: mocks.refresh,
}));

import { POST } from "@/app/api/repositories/refresh/route";

const workspaceId = "e140d48e-9dc0-4552-a9a4-a81fe3872422";
const request = () =>
  new Request("https://auterim.com/api/repositories/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });

describe("GitHub repository catalog refresh route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      ok: true,
      user: { id: "owner-1" },
      client: {},
    });
    mocks.role.mockResolvedValue("owner");
    mocks.entitlements.mockResolvedValue({ capabilities: { repositoryConnections: true } });
    mocks.serviceConnections.mockResolvedValue({
      data: [{ id: "connection-1" }],
      error: null,
    });
    mocks.refresh.mockResolvedValue({ repositoriesImported: 1, repositoriesRevoked: 0 });
  });

  it("refreshes only an owner-authorized connected workspace installation", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ repositoriesImported: 1, repositoriesRevoked: 0 });
    expect(mocks.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, connectionId: "connection-1" }),
    );
  });

  it("denies members before looking up or refreshing the installation", async () => {
    mocks.role.mockResolvedValue("member");
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(mocks.serviceConnections).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("refuses ambiguous multiple connected installations", async () => {
    mocks.serviceConnections.mockResolvedValue({
      data: [{ id: "connection-1" }, { id: "connection-2" }],
      error: null,
    });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "github_installation_selection_required" });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
