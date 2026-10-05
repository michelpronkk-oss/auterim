import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getEnvironment, isIntegrationConfigured } from "@/lib/env/schema";
import {
  ConnectorError,
  normalizeProviderFailure,
  safeConnectorResource,
  type ConnectorProvider,
} from "./model";

export type ProviderCredentials = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scopes: string[];
  refreshExpiresAt?: string | null;
};
export type OAuthGrant = ProviderCredentials & {
  externalAccountId: string;
  accountName: string;
  safeMetadata: Record<string, string | number | boolean | null>;
};
export type ConnectorProviderAdapter = {
  provider: Exclude<ConnectorProvider, "github">;
  capabilities: readonly string[];
  requiredScopes: readonly string[];
  beginAuthorization(state: string, codeChallenge?: string): string;
  exchangeCode(code: string, codeVerifier?: string): Promise<OAuthGrant>;
  refreshCredentials?: (refreshToken: string) => Promise<ProviderCredentials>;
  revoke(accessToken: string): Promise<void>;
  listResources(
    credentials: ProviderCredentials,
    context?: { accountSlug?: string },
  ): Promise<ReturnType<typeof safeConnectorResource>[]>;
  sendAlert?: (
    credentials: ProviderCredentials,
    input: { channelId: string; text: string; deliveryId: string },
  ) => Promise<{ providerMessageId: string | null }>;
  createAction?: (
    credentials: ProviderCredentials,
    input: { teamId: string; title: string; description: string },
  ) => Promise<{ id: string; identifier: string; url: string }>;
  readRuntimeContext?: typeof readSentryRuntimeContext;
};

type Provider = Exclude<ConnectorProvider, "github">;
function configuration(provider: Provider) {
  const environment = getEnvironment();
  const name =
    provider === "slack" ? "slackApp" : provider === "linear" ? "linearApp" : "sentryApp";
  if (!isIntegrationConfigured(name, environment)) throw new Error(`${provider}_not_configured`);
  if (!isIntegrationConfigured("connectorEncryption", environment))
    throw new Error("connector_credential_encryption_not_configured");
  const redirect = (redirectUri: string) => {
    let expected: string;
    try {
      expected = new URL(
        `/api/connectors/${provider}/callback`,
        environment.NEXT_PUBLIC_APP_URL,
      ).toString();
      const configured = new URL(redirectUri);
      if (configured.toString() !== expected || configured.hash || configured.search)
        throw new Error("connector_redirect_uri_mismatch");
      if (configured.protocol !== "https:" && configured.hostname !== "localhost")
        throw new Error("connector_redirect_uri_requires_https");
    } catch {
      throw new Error("connector_redirect_uri_mismatch");
    }
    return redirectUri;
  };
  if (provider === "slack")
    return {
      clientId: environment.SLACK_CLIENT_ID!,
      clientSecret: environment.SLACK_CLIENT_SECRET!,
      redirectUri: redirect(environment.SLACK_REDIRECT_URI!),
    };
  if (provider === "linear")
    return {
      clientId: environment.LINEAR_CLIENT_ID!,
      clientSecret: environment.LINEAR_CLIENT_SECRET!,
      redirectUri: redirect(environment.LINEAR_REDIRECT_URI!),
    };
  return {
    clientId: environment.SENTRY_CLIENT_ID!,
    clientSecret: environment.SENTRY_CLIENT_SECRET!,
    redirectUri: redirect(environment.SENTRY_REDIRECT_URI!),
  };
}

function expiry(expiresIn: unknown) {
  const seconds = typeof expiresIn === "number" ? expiresIn : Number(expiresIn);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(Date.now() + Math.min(seconds, 365 * 86400) * 1000).toISOString()
    : null;
}

async function providerFetch<T>(
  provider: Provider,
  url: string,
  init?: RequestInit,
  maxResponseBytes?: number,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(12_000),
      redirect: "error",
    });
  } catch {
    throw new ConnectorError(
      "PROVIDER_UNAVAILABLE",
      true,
      provider,
      "The provider is temporarily unavailable.",
    );
  }
  if (!response.ok) {
    if (
      /(?:oauth\.token|oauth\.v2\.access)/i.test(url) &&
      response.status >= 400 &&
      response.status < 500
    ) {
      const errorCode = await response
        .clone()
        .json()
        .then((body: unknown) =>
          body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error
            : "",
        )
        .catch(() => "");
      if (["invalid_grant", "token_revoked", "invalid_token"].includes(errorCode))
        throw new ConnectorError("AUTH_REQUIRED", false, provider, "Reconnect this connector.");
      if (["invalid_scope", "insufficient_scope"].includes(errorCode))
        throw new ConnectorError(
          "PERMISSION_MISSING",
          false,
          provider,
          "This connector is missing a required permission.",
        );
    }
    throw normalizeProviderFailure(provider, response.status, response.headers.get("retry-after"));
  }
  try {
    if (maxResponseBytes === undefined) return (await response.json()) as T;
    const contentLength = response.headers.get("content-length");
    if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxResponseBytes) {
      await response.body?.cancel();
      throw new ConnectorError(
        "PROVIDER_UNAVAILABLE",
        true,
        provider,
        "The provider response exceeded its safety limit.",
      );
    }
    if (!response.body) throw new Error("provider_response_body_missing");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead > maxResponseBytes) {
          await reader.cancel();
          throw new ConnectorError(
            "PROVIDER_UNAVAILABLE",
            true,
            provider,
            "The provider response exceeded its safety limit.",
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(bytesRead);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError(
      "UNKNOWN_SAFE",
      false,
      provider,
      "The provider returned an invalid response.",
    );
  }
}

export function normalizeSlackApiFailure(error: string, retryAfter?: number): ConnectorError {
  const normalized = error.toLowerCase();
  if (
    ["invalid_auth", "token_revoked", "token_expired", "not_authed", "account_inactive"].includes(
      normalized,
    )
  )
    return new ConnectorError("AUTH_REQUIRED", false, "slack", "Reconnect this connector.");
  if (["missing_scope", "not_allowed_token_type", "access_denied"].includes(normalized))
    return new ConnectorError(
      "PERMISSION_MISSING",
      false,
      "slack",
      "This connector is missing a required permission.",
    );
  if (["channel_not_found", "not_in_channel"].includes(normalized))
    return new ConnectorError(
      "RESOURCE_NOT_FOUND",
      false,
      "slack",
      "The selected Slack resource is unavailable.",
    );
  if (["ratelimited", "rate_limited"].includes(normalized))
    return new ConnectorError(
      "RATE_LIMITED",
      true,
      "slack",
      "Slack is rate limiting requests.",
      typeof retryAfter === "number" && Number.isFinite(retryAfter)
        ? Math.min(Math.max(1, Math.floor(retryAfter)), 3600)
        : 60,
    );
  if (
    [
      "internal_error",
      "service_unavailable",
      "temporarily_unavailable",
      "request_timeout",
      "fatal_error",
    ].includes(normalized)
  )
    return new ConnectorError(
      "PROVIDER_UNAVAILABLE",
      true,
      "slack",
      "Slack is temporarily unavailable.",
    );
  return new ConnectorError("UNKNOWN_SAFE", false, "slack", "Slack rejected the request safely.");
}

function form(values: Record<string, string>) {
  return new URLSearchParams(values).toString();
}

function tokenGrant(
  provider: Provider,
  body: Record<string, unknown>,
  scopes: string[],
): ProviderCredentials {
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  if (!accessToken)
    throw new ConnectorError("AUTH_REQUIRED", false, provider, "Provider authorization failed.");
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : null;
  return {
    accessToken,
    refreshToken,
    expiresAt: expiry(body.expires_in),
    refreshExpiresAt: expiry(body.refresh_token_expires_in),
    scopes,
  };
}

function baseAdapter(provider: Provider): ConnectorProviderAdapter {
  const config = () => configuration(provider);
  const scopes =
    provider === "slack"
      ? ["channels:read", "chat:write"]
      : provider === "linear"
        ? ["read", "issues:create"]
        : ["org:read", "project:read", "event:read"];
  const capability =
    provider === "slack"
      ? "CAN_RECEIVE_ALERTS"
      : provider === "linear"
        ? "CAN_CREATE_ACTIONS"
        : "CAN_READ_RUNTIME_CONTEXT";
  const adapter: ConnectorProviderAdapter = {
    provider,
    capabilities: [capability],
    requiredScopes: scopes,
    beginAuthorization(state, challenge) {
      const current = config();
      const url = new URL(
        provider === "slack"
          ? "https://slack.com/oauth/v2/authorize"
          : provider === "linear"
            ? "https://linear.app/oauth/authorize"
            : "https://sentry.io/oauth/authorize/",
      );
      url.searchParams.set("client_id", current.clientId);
      url.searchParams.set("redirect_uri", current.redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", provider === "slack" ? scopes.join(",") : scopes.join(" "));
      if (provider === "linear") url.searchParams.set("actor", "user");
      if (provider !== "slack" && challenge) {
        url.searchParams.set("code_challenge", challenge);
        url.searchParams.set("code_challenge_method", "S256");
      }
      return url.toString();
    },
    async exchangeCode(code, verifier) {
      const current = config();
      let body: Record<string, unknown>;
      if (provider === "slack") {
        const response = await providerFetch<{
          ok: boolean;
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          scope?: string;
          team?: { id?: string; name?: string };
          enterprise?: { id?: string; name?: string } | null;
        }>(provider, "https://slack.com/api/oauth.v2.access", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form({
            client_id: current.clientId,
            client_secret: current.clientSecret,
            code,
            redirect_uri: current.redirectUri,
          }),
        });
        if (!response.ok || !response.team?.id)
          throw new ConnectorError("AUTH_REQUIRED", false, provider, "Slack authorization failed.");
        body = response;
        const tokens = tokenGrant(
          provider,
          body,
          (response.scope ?? "").split(",").filter(Boolean),
        );
        return {
          ...tokens,
          externalAccountId: response.team.id,
          accountName: response.team.name ?? "Slack workspace",
          safeMetadata: {
            enterpriseId: response.enterprise?.id ?? null,
          } as OAuthGrant["safeMetadata"],
        };
      }
      const tokenUrl =
        provider === "linear"
          ? "https://api.linear.app/oauth/token"
          : "https://sentry.io/oauth/token/";
      const fields: Record<string, string> = {
        grant_type: "authorization_code",
        code,
        client_id: current.clientId,
        client_secret: current.clientSecret,
        redirect_uri: current.redirectUri,
      };
      if (verifier) fields.code_verifier = verifier;
      body = await providerFetch<Record<string, unknown>>(provider, tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form(fields),
      });
      const tokens = tokenGrant(
        provider,
        body,
        typeof body.scope === "string" ? body.scope.split(/[ ,]+/).filter(Boolean) : [],
      );
      if (provider === "linear") {
        const viewer = await linearGraphql<{
          viewer: { id: string; organization?: { id: string; name: string } | null };
        }>(tokens.accessToken, "query { viewer { id organization { id name } } }");
        const accountId = viewer.viewer.organization?.id ?? viewer.viewer.id;
        return {
          ...tokens,
          externalAccountId: accountId,
          accountName: viewer.viewer.organization?.name ?? "Linear workspace",
          safeMetadata: { actorId: viewer.viewer.id },
        };
      }
      const organizations = await providerFetch<
        Array<{ id?: string; slug?: string; name?: string }>
      >(provider, "https://sentry.io/api/0/organizations/", {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });
      const organization = organizations[0];
      if (!organization?.id)
        throw new ConnectorError(
          "PERMISSION_MISSING",
          false,
          provider,
          "Sentry organization access is unavailable.",
        );
      return {
        ...tokens,
        externalAccountId: organization.id,
        accountName: organization.name ?? organization.slug ?? "Sentry organization",
        safeMetadata: { organizationSlug: organization.slug ?? null },
      };
    },
    async revoke(accessToken) {
      if (provider === "slack") {
        const result = await providerFetch<{ ok: boolean }>(
          provider,
          "https://slack.com/api/auth.revoke",
          { method: "POST", headers: { authorization: `Bearer ${accessToken}` } },
        );
        if (!result.ok)
          throw new ConnectorError(
            "UNKNOWN_SAFE",
            false,
            provider,
            "Slack could not revoke this installation.",
          );
      } else if (provider === "linear") {
        const current = config();
        try {
          await providerFetch(provider, "https://api.linear.app/oauth/revoke", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: form({
              token: accessToken,
              token_type_hint: "access_token",
              client_id: current.clientId,
              client_secret: current.clientSecret,
            }),
          });
        } catch (error) {
          if (!(error instanceof ConnectorError && error.category === "AUTH_REQUIRED")) throw error;
        }
      }
      // Sentry does not document an OAuth token revocation endpoint; Auterim revokes locally.
    },
    async listResources(credentials, context) {
      if (provider === "slack") {
        const resources = [];
        let cursor = "";
        for (let page = 0; page < 5; page += 1) {
          const url = new URL("https://slack.com/api/conversations.list");
          url.searchParams.set("limit", "100");
          url.searchParams.set("exclude_archived", "true");
          url.searchParams.set("types", "public_channel");
          if (cursor) url.searchParams.set("cursor", cursor);
          const data = await providerFetch<{
            ok: boolean;
            channels?: { id: string; name: string; is_member?: boolean; is_archived?: boolean }[];
            response_metadata?: { next_cursor?: string };
          }>(provider, url.toString(), {
            headers: { authorization: `Bearer ${credentials.accessToken}` },
          });
          if (!data.ok)
            throw normalizeSlackApiFailure((data as { error?: string }).error ?? "unknown_error");
          for (const channel of data.channels ?? []) {
            if (channel.is_member !== true) continue;
            resources.push(
              safeConnectorResource({
                id: channel.id,
                type: "channel",
                name: channel.name,
                metadata: {
                  isArchived: channel.is_archived === true,
                  isPrivate: false,
                  isMember: true,
                },
              }),
            );
          }
          cursor = data.response_metadata?.next_cursor ?? "";
          if (!cursor) break;
        }
        return resources;
      }
      if (provider === "linear") {
        const resources = [];
        let after: string | null = null;
        for (let page = 0; page < 3; page += 1) {
          const query = `query Teams($after: String) { teams(first: 50, after: $after) { nodes { id name key } pageInfo { hasNextPage endCursor } } }`;
          const result: {
            teams: {
              nodes: { id: string; name: string; key: string }[];
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          } = await linearGraphql(credentials.accessToken, query, { after });
          resources.push(
            ...result.teams.nodes.map((team) =>
              safeConnectorResource({
                id: team.id,
                type: "team",
                name: team.name,
                metadata: { teamKey: team.key },
              }),
            ),
          );
          after = result.teams.pageInfo.endCursor;
          if (!result.teams.pageInfo.hasNextPage || !after) break;
        }
        return resources;
      }
      const orgSlug = context?.accountSlug;
      if (!orgSlug || !/^[a-z0-9-]{1,100}$/.test(orgSlug)) return [];
      const projects = await providerFetch<
        {
          id: string;
          slug: string;
          name: string;
          platform?: string;
        }[]
      >(
        "sentry",
        `https://sentry.io/api/0/organizations/${encodeURIComponent(orgSlug)}/projects/?per_page=100`,
        {
          headers: { authorization: `Bearer ${credentials.accessToken}` },
        },
      );
      return projects.slice(0, 100).map((project) =>
        safeConnectorResource({
          id: project.id,
          type: "project",
          name: project.name,
          metadata: {
            slug: project.slug,
            ...(project.platform ? { projectType: project.platform.slice(0, 80) } : {}),
          },
        }),
      );
    },
  };
  if (provider === "slack") adapter.sendAlert = sendSlackNotification;
  if (provider === "linear") adapter.createAction = createLinearIssue;
  if (provider === "sentry") adapter.readRuntimeContext = readSentryRuntimeContext;
  adapter.refreshCredentials = async (refreshToken: string) => {
    if (provider === "slack") {
      const current = config();
      const body = await providerFetch<Record<string, unknown>>(
        provider,
        "https://slack.com/api/oauth.v2.access",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form({
            client_id: current.clientId,
            client_secret: current.clientSecret,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          }),
        },
      );
      if (body.ok !== true)
        throw new ConnectorError(
          "AUTH_REQUIRED",
          false,
          provider,
          "Slack authorization must be renewed.",
        );
      return tokenGrant(
        provider,
        body,
        typeof body.scope === "string" ? body.scope.split(",").filter(Boolean) : scopes,
      );
    }
    const current = config();
    const tokenUrl =
      provider === "linear"
        ? "https://api.linear.app/oauth/token"
        : "https://sentry.io/oauth/token/";
    const body = await providerFetch<Record<string, unknown>>(provider, tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: current.clientId,
        client_secret: current.clientSecret,
      }),
    });
    return tokenGrant(
      provider,
      body,
      typeof body.scope === "string" ? body.scope.split(/[ ,]+/).filter(Boolean) : [],
    );
  };
  return adapter;
}

async function linearGraphql<T>(
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const data = await providerFetch<{ data?: T; errors?: unknown[] }>(
    "linear",
    "https://api.linear.app/graphql",
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    },
  );
  if (!data.data || data.errors?.length)
    throw new ConnectorError("UNKNOWN_SAFE", false, "linear", "Linear rejected the request.");
  return data.data;
}

export function getConnectorProvider(
  provider: Exclude<ConnectorProvider, "github">,
): ConnectorProviderAdapter {
  return baseAdapter(provider);
}

export function generatePkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function sendSlackNotification(
  credentials: ProviderCredentials,
  input: { channelId: string; text: string; deliveryId: string },
) {
  const result = await providerFetch<{
    ok: boolean;
    ts?: string;
    error?: string;
    retry_after?: number;
  }>("slack", "https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.accessToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: input.channelId,
      text: input.text.slice(0, 1500),
      client_msg_id: input.deliveryId,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
  if (!result.ok) {
    throw normalizeSlackApiFailure(result.error ?? "unknown_error", result.retry_after);
  }
  return { providerMessageId: result.ts ?? null };
}

export async function createLinearIssue(
  credentials: ProviderCredentials,
  input: { teamId: string; title: string; description: string },
) {
  let result: {
    issueCreate?: { success: boolean; issue?: { id: string; identifier: string; url: string } };
  };
  try {
    result = await linearGraphql(
      credentials.accessToken,
      `mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`,
      {
        input: {
          teamId: input.teamId,
          title: input.title.slice(0, 200),
          description: input.description.slice(0, 8000),
        },
      },
    );
  } catch (error) {
    // A mutation may have succeeded even when its response is incomplete or lost.
    // The action route maps retryable errors to unknown_result and blocks blind retries.
    if (
      error instanceof ConnectorError &&
      ["AUTH_REQUIRED", "PERMISSION_MISSING", "INVALID_REQUEST"].includes(error.category)
    )
      throw error;
    throw new ConnectorError(
      "TRANSIENT",
      true,
      "linear",
      "Linear issue creation could not be confirmed; reconcile before retrying.",
    );
  }
  if (result.issueCreate?.success === false)
    throw new ConnectorError("UNKNOWN_SAFE", false, "linear", "Linear did not create the issue.");
  if (result.issueCreate?.success !== true || !result.issueCreate.issue)
    throw new ConnectorError(
      "TRANSIENT",
      true,
      "linear",
      "Linear issue creation could not be confirmed; reconcile before retrying.",
    );
  return result.issueCreate.issue;
}

export const SENTRY_RUNTIME_RESPONSE_MAX_BYTES = 256 * 1024;

export async function readSentryRuntimeContext(
  credentials: ProviderCredentials,
  input: {
    organizationSlug: string;
    projectSlugs: string[];
    windowStart: string;
    windowEnd: string;
    providerIdentifiers: string[];
  },
) {
  const { classifyRuntimeContext } = await import("./model");
  const errors: Parameters<typeof classifyRuntimeContext>[0]["errors"][number][] = [];
  let pageLimitReached = false;
  for (const project of input.projectSlugs.slice(0, 5)) {
    if (!/^[a-z0-9-]{1,100}$/.test(project)) continue;
    const query = new URLSearchParams({
      project,
      statsPeriod: "24h",
      query: "is:unresolved",
      per_page: "50",
    });
    const issues = await providerFetch<
      {
        id: string;
        firstSeen?: string | null;
        lastSeen?: string | null;
        count?: string | number;
        metadata?: { type?: string };
      }[]
    >(
      "sentry",
      `https://sentry.io/api/0/organizations/${encodeURIComponent(input.organizationSlug)}/issues/?${query}`,
      {
        headers: { authorization: `Bearer ${credentials.accessToken}` },
      },
      SENTRY_RUNTIME_RESPONSE_MAX_BYTES,
    );
    if (issues.length >= 50) pageLimitReached = true;
    for (const issue of issues.slice(0, 50)) {
      const issueId = String(issue.id);
      if (!/^\d{1,30}$/.test(issueId)) continue;
      const rawType = issue.metadata?.type;
      const errorType =
        typeof rawType === "string"
          ? rawType
              .replace(/[^a-zA-Z0-9_.$ -]/g, " ")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 120) || null
          : null;
      if (!issue.firstSeen || !issue.lastSeen) continue;
      errors.push({
        issueId,
        type: errorType,
        firstSeen: issue.firstSeen,
        lastSeen: issue.lastSeen,
        count: Number(issue.count) || 0,
      });
    }
  }
  const result = classifyRuntimeContext({
    errors,
    providerIdentifiers: input.providerIdentifiers,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
  });
  return pageLimitReached && result.result !== "runtime_signal_found"
    ? { ...result, result: "runtime_signal_inconclusive" as const }
    : result;
}
