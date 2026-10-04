import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createOAuthBinding,
  decryptOAuthActorToken,
  decryptOAuthVerifier,
  searchConsoleOAuthConfig,
  SearchConsoleError,
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
  afterEach(() => vi.unstubAllEnvs());

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
});
