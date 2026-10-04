import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createOAuthBinding,
  decryptOAuthActorToken,
  decryptOAuthVerifier,
  exchangeSearchConsoleCode,
  searchConsoleOAuthConfig,
  searchConsoleAuthorizationUrl,
  SearchConsoleError,
  SearchConsoleOAuthExchangeError,
  SearchConsolePropertyError,
  verifySearchConsoleProperty,
} from "@/lib/growth-v2/search-console";

function configureOAuth(appUrl: string, redirectUri: string) {
  vi.stubEnv("GOOGLE_SEARCH_CONSOLE_CLIENT_ID", "test-client-id");
  vi.stubEnv("GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("GOOGLE_SEARCH_CONSOLE_REDIRECT_URI", redirectUri);
  vi.stubEnv("GOOGLE_SEARCH_CONSOLE_PROPERTY", "sc-domain:auterim.com");
  vi.stubEnv("AUTERIM_GROWTH_ADMIN_EMAILS", "admin@auterim.com");
  vi.stubEnv(
    "CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS",
    `{"1":"${Buffer.alloc(32, 7).toString("base64")}"}`,
  );
  vi.stubEnv("CONNECTOR_CREDENTIAL_ACTIVE_KEY_VERSION", "1");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", appUrl);
}

describe("Search Console OAuth configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("accepts the canonical HTTPS production callback", () => {
    configureOAuth(
      "https://auterim.com",
      "https://auterim.com/api/internal/growth/search-console/callback",
    );

    expect(searchConsoleOAuthConfig()).toMatchObject({
      redirectUri: "https://auterim.com/api/internal/growth/search-console/callback",
      property: "sc-domain:auterim.com",
    });
  });

  it("rejects HTTP callbacks for non-local app origins", () => {
    configureOAuth(
      "http://auterim.com",
      "http://auterim.com/api/internal/growth/search-console/callback",
    );

    expect(() => searchConsoleOAuthConfig()).toThrowError(SearchConsoleError);
  });

  it("rejects callback URLs with userinfo even when the origin matches", () => {
    configureOAuth(
      "https://auterim.com",
      "https://spoof:secret@auterim.com/api/internal/growth/search-console/callback",
    );

    expect(() => searchConsoleOAuthConfig()).toThrowError(SearchConsoleError);
  });

  it("allows the default HTTP localhost callback for local development", () => {
    configureOAuth(
      "http://localhost:3000",
      "http://localhost:3000/api/internal/growth/search-console/callback",
    );

    expect(searchConsoleOAuthConfig().redirectUri).toBe(
      "http://localhost:3000/api/internal/growth/search-console/callback",
    );
  });

  it("creates encrypted PKCE and actor bindings without returning either credential in plaintext", () => {
    configureOAuth(
      "https://auterim.com",
      "https://auterim.com/api/internal/growth/search-console/callback",
    );

    const binding = createOAuthBinding("supabase-access-token-fixture");
    const verifier = decryptOAuthVerifier({
      ...binding.encryptedVerifier,
      stateHash: binding.stateHash,
    });
    const actorToken = decryptOAuthActorToken({
      ...binding.encryptedActorToken,
      stateHash: binding.stateHash,
    });
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    expect(binding.state).toHaveLength(43);
    expect(binding.browserSecret).toHaveLength(43);
    expect(binding.stateHash).toBe(createHash("sha256").update(binding.state).digest("hex"));
    expect(binding.browserHash).toBe(
      createHash("sha256").update(binding.browserSecret).digest("hex"),
    );
    expect(binding.challenge).toBe(challenge);
    expect(actorToken).toBe("supabase-access-token-fixture");
    expect(JSON.stringify(binding.encryptedActorToken)).not.toContain(actorToken);
    expect(JSON.stringify(binding.encryptedVerifier)).not.toContain(verifier);
  });

  it("keeps the exact offline readonly OAuth and PKCE contract", () => {
    configureOAuth(
      "https://auterim.com",
      "https://auterim.com/api/internal/growth/search-console/callback",
    );
    const url = new URL(
      searchConsoleAuthorizationUrl({ state: "bound-state", challenge: "s256-challenge" }),
    );

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://auterim.com/api/internal/growth/search-console/callback",
    );
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/webmasters.readonly",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("exchanges the authorization code server-side with exact redirect URI and PKCE", async () => {
    configureOAuth(
      "https://auterim.com",
      "https://auterim.com/api/internal/growth/search-console/callback",
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Response.json({
        access_token: "access-token-fixture",
        refresh_token: "refresh-token-fixture",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/webmasters.readonly",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const grant = await exchangeSearchConsoleCode({
      code: "one-time-code-fixture",
      verifier: "pkce-verifier-fixture",
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const body = new URLSearchParams(String(init?.body));

    expect(String(url)).toBe("https://oauth2.googleapis.com/token");
    expect(init?.method).toBe("POST");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("one-time-code-fixture");
    expect(body.get("code_verifier")).toBe("pkce-verifier-fixture");
    expect(body.get("redirect_uri")).toBe(
      "https://auterim.com/api/internal/growth/search-console/callback",
    );
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(grant.credential.refreshToken).toBe("refresh-token-fixture");
  });

  it("requires a refresh token on first persistent connection and normalizes Google failures", async () => {
    configureOAuth(
      "https://auterim.com",
      "https://auterim.com/api/internal/growth/search-console/callback",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          access_token: "access-token-fixture",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/webmasters.readonly",
        }),
      ),
    );

    await expect(
      exchangeSearchConsoleCode({ code: "one-time-code-fixture", verifier: "verifier" }),
    ).rejects.toMatchObject({ category: "REFRESH_CREDENTIAL_MISSING" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })),
    );
    await expect(
      exchangeSearchConsoleCode({ code: "one-time-code-fixture", verifier: "verifier" }),
    ).rejects.toBeInstanceOf(SearchConsoleOAuthExchangeError);
    await expect(
      exchangeSearchConsoleCode({ code: "one-time-code-fixture", verifier: "verifier" }),
    ).rejects.toMatchObject({ category: "TOKEN_EXCHANGE_400" });
  });

  it("validates only the exact configured domain property and classifies permission loss", async () => {
    configureOAuth(
      "https://auterim.com",
      "https://auterim.com/api/internal/growth/search-console/callback",
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Response.json({ siteUrl: "sc-domain:auterim.com", permissionLevel: "siteOwner" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifySearchConsoleProperty("access-token-fixture")).resolves.toBeUndefined();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aauterim.com",
    );
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers).toEqual({
      authorization: "Bearer access-token-fixture",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 403 })),
    );
    await expect(verifySearchConsoleProperty("access-token-fixture")).rejects.toBeInstanceOf(
      SearchConsolePropertyError,
    );
    await expect(verifySearchConsoleProperty("access-token-fixture")).rejects.toMatchObject({
      category: "PROPERTY_ACCESS_DENIED",
    });
  });
});
