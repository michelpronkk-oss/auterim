import { randomUUID } from "node:crypto";
import {
  decryptConnectorCredential,
  encryptConnectorCredential,
} from "@/lib/connectors/credentials";
import { connectorProviderEntitled } from "@/lib/connectors/entitlements";
import { ConnectorError, type ConnectorProvider } from "@/lib/connectors/model";
import { getConnectorProvider } from "@/lib/connectors/providers";
import {
  connectorStateHash,
  requiredScopesPresent,
  setConnectorHealth,
  syncProviderResources,
} from "@/lib/connectors/service";
import { getEnvironment, isIntegrationConfigured } from "@/lib/env/schema";
import { getWorkspaceRole, resolveWorkspaceEntitlementsForService } from "@/lib/billing/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function cookie(request: Request, key: string) {
  const value = request.headers
    .get("cookie")
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${key}=`))
    ?.slice(key.length + 1);
  return value && /^[A-Za-z0-9_-]{40,100}$/.test(value) ? value : null;
}

function completeRedirect(provider: ConnectorProvider, status: string, reason?: string) {
  const environment = getEnvironment();
  const target = new URL("/app", environment.NEXT_PUBLIC_APP_URL);
  target.searchParams.set("connector", provider);
  target.searchParams.set("status", status);
  if (reason) target.searchParams.set("reason", reason);
  return Response.redirect(target, 303);
}

function completeSuccessRedirect(request: Request, provider: ConnectorProvider, reason?: string) {
  if (provider === "vercel") {
    const next = new URL(request.url).searchParams.get("next");
    if (next) {
      try {
        const target = new URL(next);
        if (
          target.protocol === "https:" &&
          target.hostname === "vercel.com" &&
          target.pathname.startsWith("/integrations/")
        )
          return Response.redirect(target, 303);
      } catch {
        // Invalid provider return URLs fall back to Auterim's own status page.
      }
    }
  }
  return completeRedirect(provider, "connected", reason);
}

function clearCookie(response: Response, provider: ConnectorProvider) {
  const environment = getEnvironment();
  const secure = new URL(environment.NEXT_PUBLIC_APP_URL).protocol === "https:" ? "; Secure" : "";
  response.headers.append(
    "set-cookie",
    `auterim_connector_${provider}=; Path=/api/connectors/${provider}/callback; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  );
  return response;
}

export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  const providerValue = (await context.params).provider;
  if (!(
    providerValue === "slack" ||
    providerValue === "linear" ||
    providerValue === "sentry" ||
    providerValue === "vercel"
  ))
    return Response.json({ error: "unsupported_connector" }, { status: 404 });
  const provider = providerValue as Exclude<ConnectorProvider, "github">;
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const browserBinding = cookie(request, `auterim_connector_${provider}`);
  if (!state || state.length > 200 || !code || code.length > 2000 || !browserBinding)
    return clearCookie(completeRedirect(provider, "error", "invalid_callback"), provider);
  const stateHash = connectorStateHash(state);
  const browserBindingHash = connectorStateHash(browserBinding);
  const service = createSupabaseServerClient();
  const { data: stateRow, error: stateError } = await service
    .from("connector_authorization_states")
    .select(
      "state_hash,provider,workspace_id,actor_user_id,browser_binding_hash,pkce_ciphertext,pkce_nonce,pkce_tag,pkce_key_version,expires_at,consumed_at",
    )
    .eq("state_hash", stateHash)
    .eq("provider", provider)
    .maybeSingle();
  if (
    stateError ||
    !stateRow ||
    stateRow.consumed_at ||
    Date.parse(stateRow.expires_at) <= Date.now() ||
    stateRow.browser_binding_hash !== browserBindingHash
  )
    return clearCookie(completeRedirect(provider, "error", "invalid_or_expired_state"), provider);
  const role = await getWorkspaceRole(service, stateRow.workspace_id, stateRow.actor_user_id).catch(
    () => null,
  );
  if (role !== "owner" && role !== "admin")
    return clearCookie(completeRedirect(provider, "error", "workspace_access_revoked"), provider);
  try {
    const entitlements = await resolveWorkspaceEntitlementsForService(stateRow.workspace_id);
    if (!connectorProviderEntitled(entitlements, provider))
      return clearCookie(completeRedirect(provider, "error", "plan_required"), provider);
  } catch {
    return clearCookie(completeRedirect(provider, "error", "billing_unavailable"), provider);
  }
  const environment = getEnvironment();
  const configured =
    provider === "slack"
      ? "slackApp"
      : provider === "linear"
        ? "linearApp"
        : provider === "sentry"
          ? "sentryApp"
          : "vercelApp";
  if (
    !isIntegrationConfigured(configured, environment) ||
    !isIntegrationConfigured("connectorEncryption", environment)
  )
    return clearCookie(completeRedirect(provider, "error", "provider_not_configured"), provider);
  const claimToken = randomUUID();
  const { data: claimed, error: claimError } = await service.rpc(
    "claim_connector_authorization_state",
    {
      p_state_hash: stateHash,
      p_browser_binding_hash: browserBindingHash,
      p_provider: provider,
      p_workspace_id: stateRow.workspace_id,
      p_actor_user_id: stateRow.actor_user_id,
      p_claim_token: claimToken,
    },
  );
  if (claimError || claimed !== true)
    return clearCookie(completeRedirect(provider, "error", "state_replayed"), provider);
  const adapter = getConnectorProvider(provider);
  let verifier: string | undefined;
  if (
    stateRow.pkce_ciphertext &&
    stateRow.pkce_nonce &&
    stateRow.pkce_tag &&
    stateRow.pkce_key_version
  ) {
    try {
      verifier = decryptConnectorCredential(
        {
          ciphertext: stateRow.pkce_ciphertext,
          nonce: stateRow.pkce_nonce,
          authenticationTag: stateRow.pkce_tag,
          keyVersion: stateRow.pkce_key_version,
        },
        `auterim-connector-pkce:v1:${stateHash}`,
      );
    } catch {
      return clearCookie(completeRedirect(provider, "error", "authorization_expired"), provider);
    }
  }
  let grant;
  try {
    grant = await adapter.exchangeCode(code, verifier, {
      configurationId: url.searchParams.get("configurationId"),
      teamId: url.searchParams.get("teamId"),
    });
  } catch (error) {
    const reason =
      error instanceof ConnectorError && error.category === "PERMISSION_MISSING"
        ? "permission_missing"
        : error instanceof ConnectorError && error.category === "PROVIDER_UNAVAILABLE"
          ? "provider_unavailable"
          : "authorization_failed";
    return clearCookie(completeRedirect(provider, "error", reason), provider);
  }
  const credential = encryptConnectorCredential(
    JSON.stringify({
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      expiresAt: grant.expiresAt,
      scopes: grant.scopes,
      providerMetadata: grant.providerMetadata ?? grant.safeMetadata,
    }),
    `auterim-connector:v1:${stateRow.workspace_id}:${provider}:${grant.externalAccountId}`,
  );
  const { data: installationId, error: saveError } = await service.rpc(
    "complete_connector_authorization",
    {
      p_state_hash: stateHash,
      p_browser_binding_hash: browserBindingHash,
      p_provider: provider,
      p_workspace_id: stateRow.workspace_id,
      p_actor_user_id: stateRow.actor_user_id,
      p_claim_token: claimToken,
      p_external_account_id: grant.externalAccountId,
      p_account_name: grant.accountName.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, 160),
      p_scopes: grant.scopes.slice(0, 50),
      p_safe_metadata: grant.safeMetadata,
      p_ciphertext: credential.ciphertext,
      p_nonce: credential.nonce,
      p_authentication_tag: credential.authenticationTag,
      p_key_version: credential.keyVersion,
      p_access_expires_at: grant.expiresAt,
      p_refresh_expires_at: null,
    },
  );
  if (saveError || !installationId)
    return clearCookie(completeRedirect(provider, "error", "authorization_save_failed"), provider);
  const scopesOk = requiredScopesPresent(provider, grant.scopes);
  if (!scopesOk) {
    const installed = await service
      .from("connector_installations")
      .select(
        "id,workspace_id,provider,external_account_id,account_name,lifecycle_state,health_state,scopes,safe_metadata,connected_at,last_checked_at",
      )
      .eq("id", installationId)
      .eq("workspace_id", stateRow.workspace_id)
      .single();
    if (installed.data)
      await setConnectorHealth(
        service,
        installed.data,
        "degraded",
        "permission_missing",
        "permission_lost",
      );
    return clearCookie(completeSuccessRedirect(request, provider, "permission_missing"), provider);
  }
  const installation = {
    id: installationId as string,
    workspace_id: stateRow.workspace_id as string,
    provider,
    external_account_id: grant.externalAccountId,
    account_name: grant.accountName,
    lifecycle_state: "connected",
    health_state: "healthy",
    scopes: grant.scopes,
    safe_metadata: grant.safeMetadata,
    connected_at: new Date().toISOString(),
    last_checked_at: null,
  };
  try {
    const count = await syncProviderResources(service, installation, {
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      expiresAt: grant.expiresAt,
      scopes: grant.scopes,
      providerMetadata: grant.providerMetadata,
    });
    await service
      .from("connector_installations")
      .update({ last_checked_at: new Date().toISOString() })
      .eq("id", installationId)
      .eq("workspace_id", stateRow.workspace_id);
    return clearCookie(completeSuccessRedirect(request, provider, `resources_${count}`), provider);
  } catch (error) {
    const health =
      error instanceof ConnectorError && error.category === "PERMISSION_MISSING"
        ? "permission_missing"
        : error instanceof ConnectorError && error.category === "PROVIDER_UNAVAILABLE"
          ? "provider_unavailable"
          : "degraded";
    const installed = await service
      .from("connector_installations")
      .select(
        "id,workspace_id,provider,external_account_id,account_name,lifecycle_state,health_state,scopes,safe_metadata,connected_at,last_checked_at",
      )
      .eq("id", installationId)
      .eq("workspace_id", stateRow.workspace_id)
      .single();
    if (installed.data) await setConnectorHealth(service, installed.data, "degraded", health);
    return clearCookie(
      completeSuccessRedirect(request, provider, "resource_discovery_unavailable"),
      provider,
    );
  }
}
