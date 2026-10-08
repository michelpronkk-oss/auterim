import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeGitHubAppOAuthCode,
  listUserAccessibleGitHubAppInstallations,
  listUserAccessibleInstallationRepositories,
} from "@/lib/preflight/github-provider";

const tokenSentinel = "ghu_ephemeral_fixture_token";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ephemeral GitHub user authorization", () => {
  it("returns the OAuth token only to its server-side caller and does not persist it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ access_token: tokenSentinel, token_type: "bearer", scope: "read:user" }),
      )
      .mockResolvedValueOnce(Response.json({ login: "alice" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      exchangeGitHubAppOAuthCode({ clientId: "client-id", clientSecret: "secret", code: "code" }),
    ).resolves.toEqual({ login: "alice", accessToken: tokenSentinel });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("filters the authenticated user's installations to this exact App ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        total_count: 2,
        installations: [
          {
            id: 2001,
            app_id: 1234,
            account: { login: "acme-inc" },
            target_type: "Organization",
            repository_selection: "selected",
            permissions: { contents: "read", metadata: "read" },
            suspended_at: null,
          },
          {
            id: 2002,
            app_id: 9876,
            account: { login: "unrelated-app-account" },
            target_type: "User",
            repository_selection: "all",
            permissions: { contents: "write" },
            suspended_at: null,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await listUserAccessibleGitHubAppInstallations({
      accessToken: tokenSentinel,
      appId: "1234",
    });

    expect(result).toEqual([
      {
        id: 2001,
        appId: 1234,
        accountLogin: "acme-inc",
        targetType: "Organization",
        repositorySelection: "selected",
        permissions: { contents: "read", metadata: "read" },
        suspendedAt: null,
      },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/user/installations?per_page=100&page=1",
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      `Bearer ${tokenSentinel}`,
    );
  });

  it("bounds installation pagination and reports only a safe failure", async () => {
    const response = {
      total_count: 1_001,
      installations: Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        app_id: 1234,
        account: { login: `account-${index}` },
        target_type: "User",
        repository_selection: "selected",
        permissions: { contents: "read", metadata: "read" },
        suspended_at: null,
      })),
    };
    const fetchMock = vi.fn().mockImplementation(() => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listUserAccessibleGitHubAppInstallations({ accessToken: tokenSentinel, appId: "1234" }),
    ).rejects.toThrow("github_user_installations_limit_exceeded");
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("lists the user-authorized repository set through the read-only metadata endpoint", async () => {
    const repo = {
      id: 4001,
      name: "auterim-m15-github-qa",
      full_name: "michelpronkk-oss/auterim-m15-github-qa",
      owner: { login: "michelpronkk-oss" },
      default_branch: "main",
      private: true,
      archived: false,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ total_count: 1, repositories: [repo] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listUserAccessibleInstallationRepositories({
        accessToken: tokenSentinel,
        installationId: 2001,
      }),
    ).resolves.toEqual([repo]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/user/installations/2001/repositories?per_page=100&page=1",
    );
  });

  it("does not expose upstream response details on authorization failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("token-bearing error response", { status: 403 })),
    );

    await expect(
      listUserAccessibleGitHubAppInstallations({ accessToken: tokenSentinel, appId: "1234" }),
    ).rejects.toThrow("github_user_installations_unavailable");
  });
});
