import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  getUser: vi.fn(),
  decryptActor: vi.fn(),
  decryptVerifier: vi.fn(),
  exchange: vi.fn(),
  verifyProperty: vi.fn(),
  save: vi.fn(),
  admins: vi.fn(() => new Set(["admin@auterim.com"])),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: () => ({
    rpc: mocks.claim,
    auth: { getUser: mocks.getUser },
  }),
}));

vi.mock("@/lib/growth-v2/search-console", () => ({
  decryptOAuthActorToken: mocks.decryptActor,
  decryptOAuthVerifier: mocks.decryptVerifier,
  exchangeSearchConsoleCode: mocks.exchange,
  saveSearchConsoleConnection: mocks.save,
  searchConsoleAdminEmails: mocks.admins,
  verifySearchConsoleProperty: mocks.verifyProperty,
}));

vi.mock("@/lib/env/schema", () => ({
  getEnvironment: () => ({ NEXT_PUBLIC_APP_URL: "https://auterim.com" }),
}));

import { GET } from "@/app/api/internal/growth/search-console/callback/route";

const state = "state-fixture";
const browserSecret = "browser-fixture";
const stateHash = createHash("sha256").update(state).digest("hex");
const browserHash = createHash("sha256").update(browserSecret).digest("hex");

function callbackUrl(parameters = "state=state-fixture&code=google-code-fixture") {
  return `https://auterim.com/api/internal/growth/search-console/callback?${parameters}`;
}

function callbackRequest(parameters?: string) {
  return new Request(callbackUrl(parameters), {
    headers: { cookie: `auterim_gsc_state=${browserSecret}` },
  });
}

const binding = {
  actor_user_id: "verified-admin-id",
  verifier_ciphertext: "encrypted-verifier",
  verifier_nonce: "nonce",
  verifier_authentication_tag: "tag",
  verifier_key_version: 1,
  actor_token_ciphertext: "encrypted-actor-token",
  actor_token_nonce: "nonce",
  actor_token_authentication_tag: "tag",
  actor_token_key_version: 1,
};

describe("Search Console OAuth callback acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue({ data: [binding], error: null });
    mocks.getUser.mockResolvedValue({
      data: {
        user: {
          id: "verified-admin-id",
          email: "admin@auterim.com",
          email_confirmed_at: "2026-01-01T00:00:00Z",
        },
      },
      error: null,
    });
    mocks.decryptActor.mockReturnValue("actor-token-fixture");
    mocks.decryptVerifier.mockReturnValue("pkce-verifier-fixture");
    mocks.exchange.mockResolvedValue({
      credential: {
        accessToken: "access-token-fixture",
        refreshToken: "refresh-token-fixture",
        expiresAt: "2026-10-04T01:00:00.000Z",
        scope: ["https://www.googleapis.com/auth/webmasters.readonly"],
      },
    });
    mocks.verifyProperty.mockResolvedValue(undefined);
    mocks.save.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("claims bound state once, exchanges with PKCE, verifies the exact property, and persists credentials", async () => {
    const response = await GET(callbackRequest());
    const location = response.headers.get("location") ?? "";

    expect(mocks.claim).toHaveBeenCalledWith("claim_growth_search_console_oauth_state", {
      p_state_hash: stateHash,
      p_browser_hash: browserHash,
    });
    expect(mocks.decryptVerifier).toHaveBeenCalledWith(expect.objectContaining({ stateHash }));
    expect(mocks.exchange).toHaveBeenCalledWith({
      code: "google-code-fixture",
      verifier: "pkce-verifier-fixture",
    });
    expect(mocks.verifyProperty).toHaveBeenCalledWith("access-token-fixture");
    expect(mocks.save).toHaveBeenCalledWith({
      actorUserId: "verified-admin-id",
      credential: expect.objectContaining({
        scope: ["https://www.googleapis.com/auth/webmasters.readonly"],
      }),
    });
    expect(response.status).toBe(303);
    expect(location).toBe("https://auterim.com/app/settings?searchConsole=connected");
    expect(location).not.toContain("access-token-fixture");
    expect(location).not.toContain("refresh-token-fixture");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("denies unknown, expired, replayed, or browser-mismatched state when the atomic claim returns no row", async () => {
    mocks.claim.mockResolvedValue({ data: [], error: null });

    const response = await GET(callbackRequest());

    expect(response.headers.get("location")).toContain("searchConsole=denied");
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("rejects a callback bound to a different authenticated user", async () => {
    mocks.getUser.mockResolvedValue({
      data: {
        user: {
          id: "different-user-id",
          email: "admin@auterim.com",
          email_confirmed_at: "2026-01-01T00:00:00Z",
        },
      },
      error: null,
    });

    const response = await GET(callbackRequest());

    expect(response.headers.get("location")).toContain("searchConsole=denied");
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("denies a missing encrypted PKCE verifier", async () => {
    mocks.decryptVerifier.mockImplementation(() => {
      throw new Error("fixture decrypt failure");
    });

    const response = await GET(callbackRequest());

    expect(response.headers.get("location")).toContain("searchConsole=failed");
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("fails safely on Google error callbacks and token-exchange failures", async () => {
    const googleError = await GET(callbackRequest("state=state-fixture&error=access_denied"));
    expect(googleError.headers.get("location")).toContain("searchConsole=denied");

    mocks.exchange.mockRejectedValueOnce(new Error("provider error"));
    const exchangeFailure = await GET(callbackRequest());
    expect(exchangeFailure.headers.get("location")).toContain("searchConsole=failed");
    expect(exchangeFailure.headers.get("location")).not.toContain("provider error");
  });

  it("does not persist a token when the granted property is invalid", async () => {
    mocks.verifyProperty.mockRejectedValue(new Error("property access denied"));

    const response = await GET(callbackRequest());

    expect(response.headers.get("location")).toContain("searchConsole=failed");
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
