import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getEnvironment, isIntegrationConfigured } from "@/lib/env/schema";
import {
  connectorCredentialAad,
  decryptConnectorCredential,
  encryptConnectorCredential,
  fingerprintConnectorValue,
} from "@/lib/connectors/credentials";
import {
  canonicalSearchPage,
  hasOnlySearchConsoleReadScope,
  hasSearchConsolePropertyAccess,
  SEARCH_ANALYTICS_PAGE_SIZE,
} from "./contract";
import type { SearchMetric } from "./contract";

export const SEARCH_CONSOLE_PROPERTY = "sc-domain:auterim.com" as const;
export const SEARCH_CONSOLE_READ_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const credentialAad = connectorCredentialAad(
  "internal",
  "google-search-console",
  SEARCH_CONSOLE_PROPERTY,
);

export class SearchConsoleError extends Error {
  constructor(
    readonly category:
      | "not_configured"
      | "reauth_required"
      | "rate_limited"
      | "provider_unavailable"
      | "invalid_response",
    readonly retryable: boolean,
  ) {
    super(category);
    this.name = "SearchConsoleError";
  }
}

export type GoogleCredential = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: string[];
};

export function searchConsoleAdminEmails() {
  const value = getEnvironment().AUTERIM_GROWTH_ADMIN_EMAILS ?? "";
  return new Set(
    value
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isSearchConsoleConfigured() {
  return isIntegrationConfigured("searchConsole", getEnvironment());
}

export function searchConsoleOAuthConfig() {
  const environment = getEnvironment();
  if (!isSearchConsoleConfigured()) throw new SearchConsoleError("not_configured", false);
  if (environment.GOOGLE_SEARCH_CONSOLE_PROPERTY !== SEARCH_CONSOLE_PROPERTY)
    throw new SearchConsoleError("not_configured", false);
  const redirect = new URL(environment.GOOGLE_SEARCH_CONSOLE_REDIRECT_URI!);
  const appOrigin = new URL(environment.NEXT_PUBLIC_APP_URL);
  if (
    redirect.origin !== appOrigin.origin ||
    redirect.pathname !== "/api/internal/growth/search-console/callback" ||
    redirect.search ||
    redirect.hash ||
    (appOrigin.protocol === "https:" && redirect.protocol !== "https:")
  )
    throw new SearchConsoleError("not_configured", false);
  return {
    clientId: environment.GOOGLE_SEARCH_CONSOLE_CLIENT_ID!,
    clientSecret: environment.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET!,
    redirectUri: environment.GOOGLE_SEARCH_CONSOLE_REDIRECT_URI!,
    property: SEARCH_CONSOLE_PROPERTY,
  };
}

export function createOAuthBinding(actorAccessToken: string) {
  const state = randomBytes(32).toString("base64url");
  const browserSecret = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const stateHash = createHash("sha256").update(state).digest("hex");
  const browserHash = createHash("sha256").update(browserSecret).digest("hex");
  const encryptedVerifier = encryptConnectorCredential(
    verifier,
    `auterim-gsc-oauth:v1:${stateHash}`,
  );
  const encryptedActorToken = encryptConnectorCredential(
    actorAccessToken,
    `auterim-gsc-actor:v1:${stateHash}`,
  );
  return {
    state,
    stateHash,
    browserSecret,
    browserHash,
    verifier,
    challenge,
    encryptedVerifier,
    encryptedActorToken,
  };
}

export function searchConsoleAuthorizationUrl(input: { state: string; challenge: string }) {
  const config = searchConsoleOAuthConfig();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SEARCH_CONSOLE_READ_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function verifySearchConsoleProperty(accessToken: string) {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SEARCH_CONSOLE_PROPERTY)}`;
  const response = await boundedFetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  const site = await safeJson(response);
  if (!hasSearchConsolePropertyAccess(site)) throw new SearchConsoleError("reauth_required", false);
}

export function decryptOAuthActorToken(input: {
  ciphertext: string;
  nonce: string;
  authenticationTag: string;
  keyVersion: number;
  stateHash: string;
}) {
  return decryptConnectorCredential(
    {
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      authenticationTag: input.authenticationTag,
      keyVersion: input.keyVersion,
    },
    `auterim-gsc-actor:v1:${input.stateHash}`,
  );
}

export function decryptOAuthVerifier(input: {
  ciphertext: string;
  nonce: string;
  authenticationTag: string;
  keyVersion: number;
  stateHash: string;
}) {
  return decryptConnectorCredential(
    {
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      authenticationTag: input.authenticationTag,
      keyVersion: input.keyVersion,
    },
    `auterim-gsc-oauth:v1:${input.stateHash}`,
  );
}

function safeJson(response: Response) {
  if (response.status === 429) throw new SearchConsoleError("rate_limited", true);
  if (response.status === 401 || response.status === 403)
    throw new SearchConsoleError("reauth_required", false);
  if (response.status >= 500) throw new SearchConsoleError("provider_unavailable", true);
  if (!response.ok) throw new SearchConsoleError("invalid_response", false);
  return response.json() as Promise<Record<string, unknown>>;
}

async function boundedFetch(url: string, init: RequestInit) {
  try {
    return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new SearchConsoleError("provider_unavailable", true);
  }
}

export async function exchangeSearchConsoleCode(input: { code: string; verifier: string }) {
  const config = searchConsoleOAuthConfig();
  const form = new URLSearchParams({
    code: input.code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
    code_verifier: input.verifier,
  });
  const raw = await safeJson(
    await boundedFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    }),
  );
  const scope = typeof raw.scope === "string" ? raw.scope.split(/\s+/).filter(Boolean) : [];
  if (
    typeof raw.access_token !== "string" ||
    typeof raw.refresh_token !== "string" ||
    !hasOnlySearchConsoleReadScope(scope) ||
    typeof raw.expires_in !== "number"
  )
    throw new SearchConsoleError("reauth_required", false);
  return {
    credential: {
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token,
      expiresAt: new Date(Date.now() + raw.expires_in * 1000).toISOString(),
      scope,
    } satisfies GoogleCredential,
    safeScopes: scope,
  };
}

function encryptCredential(credential: GoogleCredential) {
  return encryptConnectorCredential(JSON.stringify(credential), credentialAad);
}

function decryptCredential(row: Record<string, unknown>): GoogleCredential {
  try {
    const json = decryptConnectorCredential(
      {
        ciphertext: String(row.ciphertext),
        nonce: String(row.nonce),
        authenticationTag: String(row.authentication_tag),
        keyVersion: Number(row.key_version),
      },
      credentialAad,
    );
    const value = JSON.parse(json) as GoogleCredential;
    if (
      typeof value.accessToken !== "string" ||
      typeof value.refreshToken !== "string" ||
      !Array.isArray(value.scope)
    )
      throw new Error("invalid");
    return value;
  } catch {
    throw new SearchConsoleError("reauth_required", false);
  }
}

export async function saveSearchConsoleConnection(input: {
  actorUserId: string;
  credential: GoogleCredential;
}) {
  const encrypted = encryptCredential(input.credential);
  const client = createSupabaseServerClient();
  const { error } = await client.rpc("persist_growth_search_console_connection", {
    p_property: SEARCH_CONSOLE_PROPERTY,
    p_ciphertext: encrypted.ciphertext,
    p_nonce: encrypted.nonce,
    p_authentication_tag: encrypted.authenticationTag,
    p_key_version: encrypted.keyVersion,
    p_scopes: input.credential.scope,
    p_actor_user_id: input.actorUserId,
    p_access_expires_at: input.credential.expiresAt,
  });
  if (error) throw new SearchConsoleError("provider_unavailable", true);
}

async function loadConnection() {
  const client = createSupabaseServerClient();
  const { data, error } = await client
    .from("growth_search_console_connection")
    .select(
      "id,property,lifecycle_state,health_state,scopes,ciphertext,nonce,authentication_tag,key_version,access_expires_at,credential_version",
    )
    .eq("id", "auterim")
    .maybeSingle();
  if (error) throw new SearchConsoleError("provider_unavailable", true);
  if (
    !data ||
    !data.ciphertext ||
    data.property !== SEARCH_CONSOLE_PROPERTY ||
    !["connected", "degraded"].includes(data.lifecycle_state)
  )
    throw new SearchConsoleError("reauth_required", false);
  return { client, row: data, credential: decryptCredential(data) };
}

async function freshAccessToken() {
  const { client, credential } = await loadConnection();
  if (Date.parse(credential.expiresAt) > Date.now() + 90_000) return credential.accessToken;
  const leaseToken = randomUUID();
  const { data: claims, error: claimError } = await client.rpc(
    "claim_growth_search_console_refresh",
    { p_lease_token: leaseToken },
  );
  const claim = Array.isArray(claims) ? claims[0] : null;
  if (claimError) throw new SearchConsoleError("provider_unavailable", true);
  if (!claim) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const latest = await loadConnection();
      if (Date.parse(latest.credential.expiresAt) > Date.now() + 30_000)
        return latest.credential.accessToken;
    }
    throw new SearchConsoleError("provider_unavailable", true);
  }
  const claimedCredential = decryptCredential({
    ciphertext: claim.ciphertext,
    nonce: claim.nonce,
    authentication_tag: claim.authentication_tag,
    key_version: claim.key_version,
  });
  const config = searchConsoleOAuthConfig();
  try {
    const response = await boundedFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: claimedCredential.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (response.status === 400 || response.status === 401) {
      const errorBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (errorBody.error === "invalid_grant")
        throw new SearchConsoleError("reauth_required", false);
      throw new SearchConsoleError("invalid_response", false);
    }
    const raw = await safeJson(response);
    if (typeof raw.access_token !== "string" || typeof raw.expires_in !== "number")
      throw new SearchConsoleError("reauth_required", false);
    const next: GoogleCredential = {
      accessToken: raw.access_token,
      refreshToken:
        typeof raw.refresh_token === "string" ? raw.refresh_token : claimedCredential.refreshToken,
      expiresAt: new Date(Date.now() + raw.expires_in * 1000).toISOString(),
      scope:
        typeof raw.scope === "string"
          ? raw.scope.split(/\s+/).filter(Boolean)
          : claimedCredential.scope,
    };
    if (!hasOnlySearchConsoleReadScope(next.scope))
      throw new SearchConsoleError("reauth_required", false);
    const encrypted = encryptCredential(next);
    const { data: saved, error } = await client
      .from("growth_search_console_connection")
      .update({
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        authentication_tag: encrypted.authenticationTag,
        key_version: encrypted.keyVersion,
        access_expires_at: next.expiresAt,
        credential_version: Number(claim.credential_version) + 1,
        refresh_lease_token: null,
        refresh_lease_until: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", "auterim")
      .eq("credential_version", claim.credential_version)
      .eq("refresh_lease_token", leaseToken)
      .select("id")
      .maybeSingle();
    if (error) throw new SearchConsoleError("provider_unavailable", true);
    if (saved) return next.accessToken;
    const winner = await loadConnection();
    if (Date.parse(winner.credential.expiresAt) > Date.now() + 30_000)
      return winner.credential.accessToken;
    throw new SearchConsoleError("provider_unavailable", true);
  } catch (error) {
    const reauth = error instanceof SearchConsoleError && error.category === "reauth_required";
    const category = error instanceof SearchConsoleError ? error.category : "provider_unavailable";
    await client.rpc("release_growth_search_console_refresh", {
      p_lease_token: leaseToken,
      p_health_state: reauth ? "reauth_required" : "degraded",
      p_lifecycle_state: reauth ? "reauth_required" : "degraded",
      p_error_category: category,
    });
    throw error;
  }
}

export async function searchAnalyticsPage(input: {
  startDate: string;
  endDate: string;
  startRow: number;
}) {
  const token = await freshAccessToken();
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SEARCH_CONSOLE_PROPERTY)}/searchAnalytics/query`;
  const response = await boundedFetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      startDate: input.startDate,
      endDate: input.endDate,
      dimensions: ["date", "query", "page"],
      rowLimit: SEARCH_ANALYTICS_PAGE_SIZE,
      startRow: input.startRow,
      type: "web",
      dataState: "final",
    }),
  });
  const result = await safeJson(response);
  const rows = Array.isArray(result.rows) ? result.rows : [];
  return rows.flatMap((value): SearchMetric[] => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const keys = Array.isArray(row.keys) ? row.keys : [];
    if (keys.length !== 3 || keys.some((key) => typeof key !== "string")) return [];
    const [metricDate, query, pageUrl] = keys as string[];
    const clicks = Number(row.clicks);
    const impressions = Number(row.impressions);
    const ctr = Number(row.ctr);
    const averagePosition = Number(row.position);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(metricDate) ||
      query.length > 500 ||
      pageUrl.length > 2048 ||
      !Number.isFinite(clicks) ||
      !Number.isFinite(impressions) ||
      !Number.isFinite(ctr) ||
      !Number.isFinite(averagePosition)
    )
      return [];
    return [
      {
        metricDate,
        query,
        pageUrl,
        clicks: Math.max(0, Math.floor(clicks)),
        impressions: Math.max(0, Math.floor(impressions)),
        ctr: Math.min(1, Math.max(0, ctr)),
        averagePosition: Math.max(0, averagePosition),
      },
    ];
  });
}

export function searchMetricKey(metric: SearchMetric) {
  const page = canonicalSearchPage(metric.pageUrl);
  if (!page) throw new SearchConsoleError("invalid_response", false);
  const query = fingerprintConnectorValue(metric.query.trim().toLowerCase(), "growth-search-query");
  return {
    metricKey: createHash("sha256")
      .update(
        `${SEARCH_CONSOLE_PROPERTY}\n${metric.metricDate}\n${query.keyVersion}\n${query.fingerprint}\n${page.path}`,
      )
      .digest("hex"),
    queryFingerprint: query.fingerprint,
    queryFingerprintKeyVersion: query.keyVersion,
    pageUrl: page.path,
    queryTopicMatch: queryMatchesPage(metric.query, page.path),
  };
}

function queryMatchesPage(query: string, path: string) {
  const queryTerms = new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3),
  );
  const pageTerms = path
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !/^\d+$/.test(word));
  return pageTerms.length === 0 || pageTerms.some((word) => queryTerms.has(word));
}
