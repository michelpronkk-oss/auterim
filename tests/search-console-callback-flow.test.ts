import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchConsolePropertyError } from "@/lib/growth-v2/search-console";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  getUser: vi.fn(),
  decryptActor: vi.fn(),
  decryptVerifier: vi.fn(),
  exchange: vi.fn(),
  verifyProperty: vi.fn(),
  save: vi.fn(),
  admins: vi.fn(() => new Set(["admin@auterim.com"])),
  lookupState: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: () => ({
    rpc: mocks.claim,
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: mocks.lookupState }),
      }),
    }),
    auth: { getUser: mocks.getUser },
  }),
}));

vi.mock("@/lib/growth-v2/search-console", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/growth-v2/search-console")>()),
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
    mocks.lookupState.mockResolvedValue({ data: null, error: null });
  });

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

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
      onStage: expect.any(Function),
    });
    expect(response.status).toBe(303);
    expect(location).toBe("https://auterim.com/app/settings?searchConsole=connected");
    expect(location).not.toContain("access-token-fixture");
    expect(location).not.toContain("refresh-token-fixture");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(vi.mocked(console.info).mock.calls.at(-1)?.[1] as string)).toMatchObject({
      stage: "CALLBACK_COMPLETE",
      property: "sc-domain:auterim.com",
      actorUserId: "verified-admin-id",
    });
  });

  it("denies unknown, expired, replayed, or browser-mismatched state when the atomic claim returns no row", async () => {
    mocks.claim.mockResolvedValue({ data: [], error: null });

    const response = await GET(callbackRequest());

    expect(response.headers.get("location")).toContain("searchConsole=denied");
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("surfaces safe callback stage and category without leaking callback secrets", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.exchange.mockRejectedValueOnce(new Error("google-code-fixture refresh-token-fixture"));

    const response = await GET(callbackRequest());
    const location = response.headers.get("location") ?? "";
    const messages = [...info.mock.calls, ...warn.mock.calls]
      .map((call) => call.join(" "))
      .join("\n");

    expect(location).toContain("searchConsole=failed");
    expect(location).toContain("stage=PKCE_READY");
    expect(location).toContain("reason=TOKEN_EXCHANGE_OTHER");
    expect(messages).toContain("TOKEN_EXCHANGE_OTHER");
    expect(messages).not.toContain("google-code-fixture");
    expect(messages).not.toContain("access-token-fixture");
    expect(messages).not.toContain("refresh-token-fixture");
    info.mockRestore();
    warn.mockRestore();
  });

  it("reports exact property access denial and never attempts credential persistence", async () => {
    mocks.verifyProperty.mockRejectedValue(
      new SearchConsolePropertyError("PROPERTY_ACCESS_DENIED"),
    );

    const response = await GET(callbackRequest());
    const location = response.headers.get("location") ?? "";

    expect(location).toContain("stage=CODE_EXCHANGE_SUCCEEDED");
    expect(location).toContain("reason=PROPERTY_ACCESS_DENIED");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("reports encryption and persistence failures at their safe stages", async () => {
    mocks.save.mockImplementationOnce(async (input: { onStage: (stage: string) => void }) => {
      input.onStage("CREDENTIAL_ENCRYPTION_STARTED");
      throw new Error("sensitive encryption details");
    });
    const encryptionFailure = await GET(callbackRequest());
    expect(encryptionFailure.headers.get("location")).toContain("stage=PROPERTY_ACCESS_CONFIRMED");
    expect(encryptionFailure.headers.get("location")).toContain(
      "reason=CREDENTIAL_ENCRYPTION_FAILED",
    );

    mocks.save.mockImplementationOnce(async (input: { onStage: (stage: string) => void }) => {
      input.onStage("CREDENTIAL_ENCRYPTION_STARTED");
      input.onStage("CREDENTIAL_ENCRYPTION_SUCCEEDED");
      input.onStage("CONNECTION_PERSIST_STARTED");
      throw new Error("sensitive database details");
    });
    const databaseFailure = await GET(callbackRequest());
    expect(databaseFailure.headers.get("location")).toContain(
      "stage=CREDENTIAL_ENCRYPTION_SUCCEEDED",
    );
    expect(databaseFailure.headers.get("location")).toContain("reason=DATABASE_PERSIST_FAILED");
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
