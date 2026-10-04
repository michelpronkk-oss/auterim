import { createHash, randomUUID } from "node:crypto";
import {
  decryptOAuthActorToken,
  decryptOAuthVerifier,
  exchangeSearchConsoleCode,
  saveSearchConsoleConnection,
  searchConsoleAdminEmails,
  SearchConsoleError,
  SearchConsoleOAuthExchangeError,
  SearchConsolePropertyError,
  verifySearchConsoleProperty,
} from "@/lib/growth-v2/search-console";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getEnvironment } from "@/lib/env/schema";
import { isAllowedVerifiedGrowthAdmin } from "@/lib/growth-v2/contract";

export const runtime = "nodejs";

const PROPERTY = "sc-domain:auterim.com";
type CallbackStage =
  | "CALLBACK_RECEIVED"
  | "STATE_VALIDATED"
  | "PKCE_READY"
  | "CODE_EXCHANGE_STARTED"
  | "CODE_EXCHANGE_SUCCEEDED"
  | "PROPERTY_LIST_STARTED"
  | "PROPERTY_ACCESS_CONFIRMED"
  | "CREDENTIAL_ENCRYPTION_STARTED"
  | "CREDENTIAL_ENCRYPTION_SUCCEEDED"
  | "CONNECTION_PERSIST_STARTED"
  | "CONNECTION_PERSIST_SUCCEEDED"
  | "CALLBACK_COMPLETE";
type CallbackFailure =
  | "STATE_INVALID"
  | "STATE_EXPIRED"
  | "STATE_REPLAY"
  | "BROWSER_BINDING_FAILED"
  | "PKCE_MISSING"
  | "PKCE_FAILED"
  | "TOKEN_EXCHANGE_400"
  | "TOKEN_EXCHANGE_401"
  | "TOKEN_EXCHANGE_OTHER"
  | "REFRESH_CREDENTIAL_MISSING"
  | "TOKEN_SCOPE_INVALID"
  | "GOOGLE_ACCESS_DENIED"
  | "PROPERTY_ACCESS_DENIED"
  | "PROPERTY_NOT_FOUND"
  | "PROPERTY_VALIDATION_FAILED"
  | "GOOGLE_API_ERROR"
  | "CREDENTIAL_ENCRYPTION_FAILED"
  | "DATABASE_PERSIST_FAILED"
  | "CALLBACK_INTERNAL_ERROR";

function readCookie(request: Request, name: string) {
  const cookies = request.headers.get("cookie") ?? "";
  const entry = cookies
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!entry) return null;
  try {
    return decodeURIComponent(entry.slice(name.length + 1));
  } catch {
    return null;
  }
}

function redirect(
  result: "connected" | "denied" | "failed",
  failure?: { stage: CallbackStage; category: CallbackFailure },
) {
  const target = new URL("/app/settings", getEnvironment().NEXT_PUBLIC_APP_URL);
  target.searchParams.set("searchConsole", result);
  if (failure) {
    target.searchParams.set("stage", failure.stage);
    target.searchParams.set("reason", failure.category);
  }
  const response = Response.redirect(target, 303);
  const secure =
    new URL(getEnvironment().NEXT_PUBLIC_APP_URL).protocol === "https:" ? " Secure;" : "";
  return new Response(null, {
    status: response.status,
    headers: {
      location: response.headers.get("location")!,
      "set-cookie": `auterim_gsc_state=; Path=/api/internal/growth/search-console/callback; Max-Age=0; HttpOnly; SameSite=Lax;${secure}`,
      "cache-control": "no-store",
    },
  });
}

export async function GET(request: Request) {
  const correlationId = randomUUID();
  let stage: CallbackStage = "CALLBACK_RECEIVED";
  let lastSuccessfulStage: CallbackStage = "CALLBACK_RECEIVED";
  let stateHashReference: string | null = null;
  let actorUserId: string | null = null;
  const trace = (nextStage: CallbackStage, succeeded = !nextStage.endsWith("_STARTED")) => {
    stage = nextStage;
    if (succeeded) lastSuccessfulStage = nextStage;
    console.info(
      "search_console_oauth_trace",
      JSON.stringify({
        correlationId,
        stage: nextStage,
        stateHashReference,
        actorUserId,
        property: PROPERTY,
      }),
    );
  };
  const fail = (category: CallbackFailure, result: "denied" | "failed" = "failed") => {
    console.warn(
      "search_console_oauth_trace",
      JSON.stringify({
        correlationId,
        stage: lastSuccessfulStage,
        failedStage: stage,
        category,
        stateHashReference,
        actorUserId,
        property: PROPERTY,
      }),
    );
    return redirect(result, { stage: lastSuccessfulStage, category });
  };

  trace("CALLBACK_RECEIVED");
  const url = new URL(request.url);
  const googleError = url.searchParams.get("error");
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const browserSecret = readCookie(request, "auterim_gsc_state");
  if (googleError === "access_denied") return fail("GOOGLE_ACCESS_DENIED", "denied");
  if (!state || !code || !browserSecret || state.length > 256 || code.length > 4096)
    return fail("STATE_INVALID", "denied");

  stateHashReference = createHash("sha256").update(state).digest("hex");
  const stateHash = stateHashReference;
  const browserHash = createHash("sha256").update(browserSecret).digest("hex");
  try {
    const service = createSupabaseServerClient();
    const { data, error } = await service.rpc("claim_growth_search_console_oauth_state", {
      p_state_hash: stateHash,
      p_browser_hash: browserHash,
    });
    const binding = Array.isArray(data) ? data[0] : null;
    if (error) return fail("CALLBACK_INTERNAL_ERROR");
    if (!binding) {
      const { data: previous, error: lookupError } = await service
        .from("growth_search_console_oauth_states")
        .select("browser_hash,expires_at,consumed_at")
        .eq("state_hash", stateHash)
        .maybeSingle();
      if (lookupError) return fail("CALLBACK_INTERNAL_ERROR", "denied");
      if (!previous) return fail("STATE_INVALID", "denied");
      if (previous.browser_hash !== browserHash) return fail("BROWSER_BINDING_FAILED", "denied");
      if (previous.consumed_at) return fail("STATE_REPLAY", "denied");
      if (Date.parse(previous.expires_at) <= Date.now()) return fail("STATE_EXPIRED", "denied");
      return fail("STATE_INVALID", "denied");
    }

    let actorAccessToken: string;
    try {
      actorAccessToken = decryptOAuthActorToken({
        ciphertext: binding.actor_token_ciphertext,
        nonce: binding.actor_token_nonce,
        authenticationTag: binding.actor_token_authentication_tag,
        keyVersion: binding.actor_token_key_version,
        stateHash,
      });
    } catch {
      return fail("CALLBACK_INTERNAL_ERROR", "denied");
    }
    const { data: userResult, error: userError } = await service.auth.getUser(actorAccessToken);
    actorUserId = binding.actor_user_id;
    if (
      userError ||
      userResult.user?.id !== binding.actor_user_id ||
      !isAllowedVerifiedGrowthAdmin(
        userResult.user?.email,
        userResult.user?.email_confirmed_at,
        searchConsoleAdminEmails(),
      )
    )
      return fail("CALLBACK_INTERNAL_ERROR", "denied");
    trace("STATE_VALIDATED");

    let verifier: string;
    try {
      verifier = decryptOAuthVerifier({
        ciphertext: binding.verifier_ciphertext,
        nonce: binding.verifier_nonce,
        authenticationTag: binding.verifier_authentication_tag,
        keyVersion: binding.verifier_key_version,
        stateHash,
      });
    } catch {
      return fail("PKCE_MISSING");
    }
    trace("PKCE_READY");

    stage = "CODE_EXCHANGE_STARTED";
    trace("CODE_EXCHANGE_STARTED");
    let grant;
    try {
      grant = await exchangeSearchConsoleCode({ code, verifier });
    } catch (error) {
      const category =
        error instanceof SearchConsoleOAuthExchangeError
          ? error.category
          : error instanceof SearchConsoleError && error.category === "reauth_required"
            ? "PKCE_FAILED"
            : "TOKEN_EXCHANGE_OTHER";
      return fail(category);
    }
    trace("CODE_EXCHANGE_SUCCEEDED");

    stage = "PROPERTY_LIST_STARTED";
    trace("PROPERTY_LIST_STARTED");
    try {
      await verifySearchConsoleProperty(grant.credential.accessToken);
    } catch (error) {
      const category =
        error instanceof SearchConsolePropertyError
          ? error.category
          : error instanceof SearchConsoleError && error.category === "provider_unavailable"
            ? "GOOGLE_API_ERROR"
            : "PROPERTY_VALIDATION_FAILED";
      return fail(category);
    }
    trace("PROPERTY_ACCESS_CONFIRMED");

    try {
      await saveSearchConsoleConnection({
        actorUserId: binding.actor_user_id,
        credential: grant.credential,
        onStage: trace,
      });
    } catch {
      const failedAt = stage as CallbackStage;
      const category =
        failedAt === "CREDENTIAL_ENCRYPTION_STARTED" ||
        failedAt === "CREDENTIAL_ENCRYPTION_SUCCEEDED"
          ? "CREDENTIAL_ENCRYPTION_FAILED"
          : "DATABASE_PERSIST_FAILED";
      return fail(category);
    }
    trace("CALLBACK_COMPLETE");
    return redirect("connected");
  } catch {
    return fail("CALLBACK_INTERNAL_ERROR");
  }
}
