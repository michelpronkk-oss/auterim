import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  admins: vi.fn(() => new Set(["admin@auterim.com"])),
  configured: vi.fn(() => true),
  createBinding: vi.fn(),
  authorizationUrl: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("@/lib/onboarding/auth", () => ({
  authenticateOnboardingRequest: mocks.authenticate,
}));

vi.mock("@/lib/growth-v2/search-console", () => ({
  createOAuthBinding: mocks.createBinding,
  isSearchConsoleConfigured: mocks.configured,
  searchConsoleAdminEmails: mocks.admins,
  searchConsoleAuthorizationUrl: mocks.authorizationUrl,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: () => ({ from: () => ({ insert: mocks.insert }) }),
}));

vi.mock("@/lib/env/schema", () => ({
  getEnvironment: () => ({ NEXT_PUBLIC_APP_URL: "https://auterim.com" }),
}));

import { GET } from "@/app/api/internal/growth/search-console/oauth/route";

describe("Search Console OAuth start route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.admins.mockReturnValue(new Set(["admin@auterim.com"]));
    mocks.configured.mockReturnValue(true);
    mocks.insert.mockResolvedValue({ error: null });
    mocks.createBinding.mockReturnValue({
      state: "test-state",
      browserSecret: "browser-only-secret",
      challenge: "pkce-challenge",
      stateHash: "a".repeat(64),
      browserHash: "b".repeat(64),
      encryptedVerifier: {
        ciphertext: "encrypted-verifier",
        nonce: "verifier-nonce",
        authenticationTag: "verifier-tag",
        keyVersion: 1,
      },
      encryptedActorToken: {
        ciphertext: "encrypted-actor-token",
        nonce: "actor-nonce",
        authenticationTag: "actor-tag",
        keyVersion: 1,
      },
    });
    mocks.authorizationUrl.mockImplementation(
      ({ state, challenge }: { state: string; challenge: string }) =>
        `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&code_challenge=${challenge}&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fwebmasters.readonly`,
    );
    mocks.authenticate.mockResolvedValue({
      ok: true,
      accessToken: "actor-access-token-fixture",
      user: {
        id: "verified-admin-id",
        email: " ADMIN@AUTERIM.COM ",
        email_confirmed_at: "2026-01-01T00:00:00Z",
      },
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("creates a short-lived user/browser-bound PKCE state and redirects with a secure cookie", async () => {
    const before = Date.now();
    const response = await GET(
      new Request("https://auterim.com/api/internal/growth/search-console/oauth"),
    );
    const after = Date.now();
    expect(mocks.authenticate).toHaveBeenCalledOnce();
    expect(mocks.createBinding).toHaveBeenCalledOnce();
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(mocks.authorizationUrl).toHaveBeenCalledOnce();
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    const cookie = response.headers.get("set-cookie") ?? "";
    const inserted = mocks.insert.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("state")).toBe("test-state");
    expect(location.searchParams.get("code_challenge")).toBe("pkce-challenge");
    expect(inserted.actor_user_id).toBe("verified-admin-id");
    expect(inserted.state_hash).toBe("a".repeat(64));
    expect(inserted.browser_hash).toBe("b".repeat(64));
    expect(inserted.verifier_ciphertext).toBe("encrypted-verifier");
    expect(inserted.actor_token_ciphertext).toBe("encrypted-actor-token");
    const expiresAt = Date.parse(String(inserted.expires_at));
    expect(expiresAt).toBeGreaterThanOrEqual(before + 299_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 301_000);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=300");
    expect(cookie).toContain("Path=/api/internal/growth/search-console/callback");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).not.toContain("actor-access-token-fixture");
    expect(response.headers.get("location")).not.toContain("browser-only-secret");
  });

  it.each([
    { email: "admin@auterim.com", email_confirmed_at: null },
    { email: "other@auterim.com", email_confirmed_at: "2026-01-01T00:00:00Z" },
  ])("rejects unverified or non-allowlisted accounts before creating state", async (user) => {
    mocks.authenticate.mockResolvedValue({ ok: true, user, accessToken: "unused-fixture" });

    const response = await GET(
      new Request("https://auterim.com/api/internal/growth/search-console/oauth"),
    );

    expect(response.status).toBe(403);
    expect(mocks.createBinding).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests before creating state", async () => {
    mocks.authenticate.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "authentication_required" }, { status: 401 }),
    });

    const response = await GET(
      new Request("https://auterim.com/api/internal/growth/search-console/oauth"),
    );

    expect(response.status).toBe(401);
    expect(mocks.createBinding).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("supports an authenticated same-origin client handoff without exposing tokens", async () => {
    const response = await GET(
      new Request("https://auterim.com/api/internal/growth/search-console/oauth", {
        headers: { accept: "application/json" },
      }),
    );
    const body = (await response.json()) as { authorizationUrl: string };
    const authorizationUrl = new URL(body.authorizationUrl);

    expect(response.status).toBe(200);
    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.pathname).toBe("/o/oauth2/v2/auth");
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/webmasters.readonly",
    );
    expect(authorizationUrl.searchParams.get("state")).toBe("test-state");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(body)).not.toContain("actor-access-token-fixture");
    expect(JSON.stringify(body)).not.toContain("browser-only-secret");
  });
});
