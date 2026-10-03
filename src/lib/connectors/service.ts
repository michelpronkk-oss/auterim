import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  connectorCredentialAad,
  decryptConnectorCredential,
  encryptConnectorCredential,
  type EncryptedCredential,
} from "./credentials";
import { getConnectorProvider, type ProviderCredentials } from "./providers";
import { ConnectorError, PROVIDER_SCOPE_REQUIREMENTS, type ConnectorProvider } from "./model";

export type ConnectorInstallationRow = {
  id: string;
  workspace_id: string;
  provider: ConnectorProvider;
  external_account_id: string;
  account_name: string;
  lifecycle_state: string;
  health_state: string;
  scopes: string[];
  safe_metadata: Record<string, unknown>;
  connected_at: string;
  last_checked_at: string | null;
};
type CredentialRow = EncryptedCredential & {
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  credential_version: number;
};

export function connectorStateHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function newOAuthSecrets() {
  return {
    state: randomBytes(32).toString("base64url"),
    browserBinding: randomBytes(32).toString("base64url"),
  };
}

export function encryptCredentialValue(
  value: unknown,
  workspaceId: string,
  provider: string,
  externalAccountId: string,
) {
  const aad = connectorCredentialAad(workspaceId, provider, externalAccountId);
  return encryptConnectorCredential(JSON.stringify(value), aad);
}

export function decryptCredentialValue<T>(
  value: EncryptedCredential,
  workspaceId: string,
  provider: string,
  externalAccountId: string,
): T {
  const aad = connectorCredentialAad(workspaceId, provider, externalAccountId);
  return JSON.parse(decryptConnectorCredential(value, aad)) as T;
}

export async function loadInstallation(
  service: SupabaseClient,
  workspaceId: string,
  installationId: string,
  provider?: ConnectorProvider,
): Promise<ConnectorInstallationRow> {
  let query = service
    .from("connector_installations")
    .select("*")
    .eq("id", installationId)
    .eq("workspace_id", workspaceId);
  if (provider) query = query.eq("provider", provider);
  const { data, error } = await query.maybeSingle();
  if (error || !data)
    throw Object.assign(new Error("connector_installation_not_found"), { code: "P0002" });
  return data as ConnectorInstallationRow;
}

async function markHealth(
  service: SupabaseClient,
  installation: ConnectorInstallationRow,
  state: "connected" | "degraded" | "reauth_required",
  health:
    "healthy" | "degraded" | "reauth_required" | "provider_unavailable" | "permission_missing",
  event?: string,
) {
  await setConnectorHealth(service, installation, state, health, event);
}

export async function setConnectorHealth(
  service: SupabaseClient,
  installation: ConnectorInstallationRow,
  state: "connected" | "degraded" | "reauth_required",
  health:
    | "healthy"
    | "degraded"
    | "reauth_required"
    | "provider_unavailable"
    | "permission_missing"
    | "resource_missing",
  event?: string,
) {
  const { data: previous } = await service
    .from("connector_installations")
    .select("lifecycle_state,health_state,updated_at")
    .eq("id", installation.id)
    .eq("workspace_id", installation.workspace_id)
    .maybeSingle();
  const { data: updated, error } = await service.rpc("update_connector_health", {
    p_workspace_id: installation.workspace_id,
    p_installation_id: installation.id,
    p_lifecycle_state: state,
    p_health_state: health,
  });
  if (error) throw new Error("connector_health_update_failed");
  if (updated !== true) return;
  if (event)
    await service.from("connector_audit_events").insert({
      workspace_id: installation.workspace_id,
      installation_id: installation.id,
      provider: installation.provider,
      event_kind: event,
      safe_metadata: { category: health },
    });
  const meaningful =
    health === "reauth_required" ||
    health === "permission_missing" ||
    health === "resource_missing";
  const alreadyAlerted = previous?.health_state === health && previous?.lifecycle_state === state;
  if (meaningful && !alreadyAlerted) {
    const label = installation.provider[0]!.toUpperCase() + installation.provider.slice(1);
    await service.from("notifications").insert({
      workspace_id: installation.workspace_id,
      notification_type: "connector_health_problem",
      priority: "high",
      title: `${label} connection needs attention`,
      summary: `Auterim can no longer use this ${label} connection as configured. An owner or admin can reconnect it in Integrations.`,
      dedupe_key:
        `connector-health:${installation.id}:${state}:${health}:${previous?.updated_at ?? "initial"}`.slice(
          0,
          200,
        ),
    });
  }
}

export async function getFreshProviderCredentials(
  service: SupabaseClient,
  installation: ConnectorInstallationRow,
): Promise<ProviderCredentials> {
  if (!["connected", "degraded"].includes(installation.lifecycle_state))
    throw new ConnectorError(
      "AUTH_REQUIRED",
      false,
      installation.provider,
      "Reconnect this connector.",
    );
  const { data: row, error } = await service
    .from("connector_credentials")
    .select("*")
    .eq("installation_id", installation.id)
    .eq("workspace_id", installation.workspace_id)
    .maybeSingle();
  if (error || !row)
    throw new ConnectorError(
      "AUTH_REQUIRED",
      false,
      installation.provider,
      "Reconnect this connector.",
    );
  const credentialRow = row as CredentialRow;
  const credentials = decryptCredentialValue<ProviderCredentials>(
    credentialRow,
    installation.workspace_id,
    installation.provider,
    installation.external_account_id,
  );
  const expiration = credentialRow.access_expires_at
    ? Date.parse(credentialRow.access_expires_at)
    : Infinity;
  if (expiration > Date.now() + 120_000) return credentials;
  if (!credentials.refreshToken) {
    await markHealth(service, installation, "reauth_required", "reauth_required");
    throw new ConnectorError(
      "AUTH_REQUIRED",
      false,
      installation.provider,
      "Reconnect this connector.",
    );
  }
  const adapter = getConnectorProvider(
    installation.provider as Exclude<ConnectorProvider, "github">,
  );
  if (!adapter.refreshCredentials) {
    await markHealth(service, installation, "reauth_required", "reauth_required");
    throw new ConnectorError(
      "AUTH_REQUIRED",
      false,
      installation.provider,
      "Reconnect this connector.",
    );
  }
  const { data: claim, error: claimError } = await service.rpc("claim_connector_refresh", {
    p_installation_id: installation.id,
    p_workspace_id: installation.workspace_id,
  });
  if (claimError)
    throw new ConnectorError(
      "TRANSIENT",
      true,
      installation.provider,
      "Credential refresh is temporarily unavailable.",
    );
  const lease = (claim ?? [])[0] as
    | (CredentialRow & {
        lease_token: string;
        provider: ConnectorProvider;
        external_account_id: string;
      })
    | undefined;
  if (!lease)
    throw new ConnectorError(
      "TRANSIENT",
      true,
      installation.provider,
      "Credential refresh is already in progress.",
    );
  const leasedCredentials = decryptCredentialValue<ProviderCredentials>(
    lease,
    installation.workspace_id,
    installation.provider,
    installation.external_account_id,
  );
  if (!leasedCredentials.refreshToken) {
    await markHealth(service, installation, "reauth_required", "reauth_required");
    throw new ConnectorError(
      "AUTH_REQUIRED",
      false,
      installation.provider,
      "Reconnect this connector.",
    );
  }
  try {
    const refreshed = await adapter.refreshCredentials(leasedCredentials.refreshToken);
    const replacement = {
      ...leasedCredentials,
      ...refreshed,
      // Some providers omit the granted scopes when rotating credentials.
      // Preserve the last verified scope set rather than accidentally erasing it.
      refreshToken: refreshed.refreshToken ?? leasedCredentials.refreshToken,
      refreshExpiresAt: refreshed.refreshExpiresAt ?? leasedCredentials.refreshExpiresAt ?? null,
      scopes: refreshed.scopes.length > 0 ? refreshed.scopes : leasedCredentials.scopes,
    };
    if (
      !requiredScopesPresent(
        installation.provider as Exclude<ConnectorProvider, "github">,
        replacement.scopes,
      )
    ) {
      await markHealth(service, installation, "degraded", "permission_missing", "permission_lost");
      throw new ConnectorError(
        "PERMISSION_MISSING",
        false,
        installation.provider,
        "This connector is missing a required permission.",
      );
    }
    const encrypted = encryptCredentialValue(
      replacement,
      installation.workspace_id,
      installation.provider,
      installation.external_account_id,
    );
    const { data: saved, error: saveError } = await service.rpc("replace_connector_credential", {
      p_installation_id: installation.id,
      p_workspace_id: installation.workspace_id,
      p_lease_token: lease.lease_token,
      p_expected_version: lease.credential_version,
      p_ciphertext: encrypted.ciphertext,
      p_nonce: encrypted.nonce,
      p_authentication_tag: encrypted.authenticationTag,
      p_key_version: encrypted.keyVersion,
      p_access_expires_at: replacement.expiresAt,
      p_refresh_expires_at: replacement.refreshExpiresAt,
      p_scopes: replacement.scopes,
    });
    if (saveError || !saved)
      throw new ConnectorError(
        "TRANSIENT",
        true,
        installation.provider,
        "Credential refresh could not be saved.",
      );
    return replacement;
  } catch (error) {
    if (error instanceof ConnectorError && error.category === "AUTH_REQUIRED")
      await markHealth(
        service,
        installation,
        "reauth_required",
        "reauth_required",
        "refresh_failed",
      );
    else if (error instanceof ConnectorError && error.category === "PERMISSION_MISSING")
      await markHealth(service, installation, "degraded", "permission_missing", "permission_lost");
    else if (error instanceof ConnectorError)
      await markHealth(service, installation, "degraded", "provider_unavailable", "refresh_failed");
    else await markHealth(service, installation, "degraded", "degraded", "refresh_failed");
    await service.rpc("release_connector_refresh", {
      p_installation_id: installation.id,
      p_workspace_id: installation.workspace_id,
      p_lease_token: lease.lease_token,
    });
    throw error;
  }
}

export async function syncProviderResources(
  service: SupabaseClient,
  installation: ConnectorInstallationRow,
  credentials: ProviderCredentials,
) {
  const adapter = getConnectorProvider(
    installation.provider as Exclude<ConnectorProvider, "github">,
  );
  const accountSlug =
    typeof installation.safe_metadata.organizationSlug === "string"
      ? installation.safe_metadata.organizationSlug
      : undefined;
  const resources = await adapter.listResources(credentials, { accountSlug });
  if (resources.length > 500)
    throw new ConnectorError(
      "INVALID_REQUEST",
      false,
      installation.provider,
      "Provider resource response exceeded its safety limit.",
    );
  for (const resource of resources) {
    const { error } = await service.from("connector_resources").upsert(
      {
        workspace_id: installation.workspace_id,
        installation_id: installation.id,
        external_resource_id: resource.externalResourceId,
        resource_type: resource.resourceType,
        display_name: resource.displayName,
        safe_metadata: resource.metadata,
        access_state: "available",
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "installation_id,external_resource_id", ignoreDuplicates: true },
    );
    if (error) throw new Error("connector_resource_sync_failed");
    await service
      .from("connector_resources")
      .update({
        display_name: resource.displayName,
        safe_metadata: resource.metadata,
        access_state: "available",
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("installation_id", installation.id)
      .eq("workspace_id", installation.workspace_id)
      .eq("external_resource_id", resource.externalResourceId);
  }
  return resources.length;
}

export async function appendConnectorAudit(
  service: SupabaseClient,
  input: {
    workspaceId: string;
    installationId: string;
    provider: ConnectorProvider;
    event: string;
    actorUserId?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const safe = Object.fromEntries(
    Object.entries(input.metadata ?? {}).filter(
      ([key, value]) =>
        /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key) &&
        !/(token|secret|credential|email|body|stack|cookie)/i.test(key) &&
        (typeof value === "string"
          ? value.length <= 160
          : typeof value === "number" || typeof value === "boolean" || value === null),
    ),
  );
  await service.from("connector_audit_events").insert({
    workspace_id: input.workspaceId,
    installation_id: input.installationId,
    provider: input.provider,
    actor_user_id: input.actorUserId,
    event_kind: input.event,
    safe_metadata: safe,
  });
}

export function requiredScopesPresent(
  provider: Exclude<ConnectorProvider, "github">,
  scopes: string[],
) {
  return PROVIDER_SCOPE_REQUIREMENTS[provider].required.every((scope) => scopes.includes(scope));
}

export const serverConnectors = createSupabaseServerClient;
