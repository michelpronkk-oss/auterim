import { z } from "zod";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import {
  connectorCapabilityEntitled,
  connectorProviderEntitled,
} from "@/lib/connectors/entitlements";
import { CONNECTOR_PROVIDERS, PROVIDER_CAPABILITIES } from "@/lib/connectors/model";
import { getEnvironment, isIntegrationConfigured } from "@/lib/env/schema";
import { getConnectorProvider } from "@/lib/connectors/providers";
import { encryptConnectorCredential } from "@/lib/connectors/credentials";
import { getWorkspaceRole, resolveWorkspaceEntitlementsForMember } from "@/lib/billing/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { connectorStateHash, newOAuthSecrets } from "@/lib/connectors/service";

const inputSchema = z.object({
  workspaceId: z.string().uuid(),
  provider: z.enum(["slack", "linear", "sentry"]),
});
const configurationName = { slack: "slackApp", linear: "linearApp", sentry: "sentryApp" } as const;

export async function GET(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const workspaceId = z
    .string()
    .uuid()
    .safeParse(new URL(request.url).searchParams.get("workspaceId"));
  if (!workspaceId.success) return Response.json({ error: "invalid_workspace" }, { status: 400 });
  const role = await getWorkspaceRole(auth.client, workspaceId.data, auth.user.id).catch(
    () => null,
  );
  if (!role) return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    const entitlements = await resolveWorkspaceEntitlementsForMember(auth.client, workspaceId.data);
    const [{ data: installations, error: installError }, { data: github, error: githubError }] =
      await Promise.all([
        auth.client
          .from("connector_installations")
          .select(
            "id,provider,external_account_id,account_name,lifecycle_state,health_state,scopes,safe_metadata,connected_at,last_checked_at,updated_at",
          )
          .eq("workspace_id", workspaceId.data),
        auth.client
          .from("repository_connections")
          .select("id,provider,account_login,status,connected_at,revoked_at")
          .eq("workspace_id", workspaceId.data)
          .eq("provider", "github"),
      ]);
    if (installError || githubError)
      return Response.json({ error: "connectors_unavailable" }, { status: 503 });
    const installationRows = installations ?? [];
    const resourcesByInstallation: Record<string, unknown[]> = {};
    if (installationRows.length) {
      const { data: resources, error } = await auth.client
        .from("connector_resources")
        .select(
          "id,installation_id,external_resource_id,resource_type,display_name,selected,access_state,safe_metadata,last_seen_at",
        )
        .eq("workspace_id", workspaceId.data)
        .order("display_name")
        .limit(200);
      if (error) return Response.json({ error: "connectors_unavailable" }, { status: 503 });
      for (const resource of resources ?? [])
        (resourcesByInstallation[resource.installation_id] ??= []).push(resource);
    }
    const environment = getEnvironment();
    const items = CONNECTOR_PROVIDERS.map((provider) => {
      const rawInstallation =
        provider === "github"
          ? (github ?? []).find((item) => item.status === "connected")
          : installationRows.find((item) => item.provider === provider);
      const installation = rawInstallation
        ? {
            id: rawInstallation.id,
            status:
              provider === "github"
                ? "status" in rawInstallation
                  ? rawInstallation.status
                  : "disconnected"
                : "lifecycle_state" in rawInstallation
                  ? rawInstallation.lifecycle_state
                  : "disconnected",
            health:
              provider === "github"
                ? "status" in rawInstallation && rawInstallation.status === "connected"
                  ? "healthy"
                  : "revoked"
                : "health_state" in rawInstallation
                  ? rawInstallation.health_state
                  : "unknown",
            scopes: "scopes" in rawInstallation ? rawInstallation.scopes : [],
            account:
              "account_login" in rawInstallation
                ? rawInstallation.account_login
                : "account_name" in rawInstallation
                  ? rawInstallation.account_name
                  : null,
            connectedAt: rawInstallation.connected_at,
          }
        : null;
      const configName = provider === "github" ? "githubApp" : configurationName[provider];
      const capabilities = PROVIDER_CAPABILITIES[provider];
      return {
        provider,
        displayName: provider[0]!.toUpperCase() + provider.slice(1),
        configured:
          isIntegrationConfigured(configName, environment) &&
          (provider === "github" || isIntegrationConfigured("connectorEncryption", environment)),
        status: installation?.status ?? "disconnected",
        health: installation?.health ?? "unknown",
        capabilities: capabilities.map((capability) => ({
          name: capability,
          enabled: connectorCapabilityEntitled(
            entitlements,
            capability === "CAN_VERIFY"
              ? "CAN_VERIFY"
              : capability === "CAN_RECEIVE_ALERTS"
                ? "CAN_RECEIVE_ALERTS"
                : capability === "CAN_CREATE_ACTIONS"
                  ? "CAN_CREATE_ACTIONS"
                  : "CAN_READ_RUNTIME_CONTEXT",
          ),
        })),
        scopes: provider === "github" ? [] : (installation?.scopes ?? []),
        account: installation?.account ?? null,
        connectedAt: installation?.connectedAt ?? null,
        installationId: provider === "github" ? null : (installation?.id ?? null),
        lastCheckedAt:
          provider === "github"
            ? null
            : rawInstallation && "last_checked_at" in rawInstallation
              ? rawInstallation.last_checked_at
              : null,
        resources:
          provider === "github" || !installation
            ? []
            : (resourcesByInstallation[installation.id] ?? []),
      };
    });
    return Response.json({ items });
  } catch {
    return Response.json({ error: "connectors_unavailable" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  let input: z.infer<typeof inputSchema>;
  try {
    input = inputSchema.parse(await request.json());
  } catch {
    return Response.json({ error: "invalid_connector_request" }, { status: 400 });
  }
  const role = await getWorkspaceRole(auth.client, input.workspaceId, auth.user.id).catch(
    () => null,
  );
  if (role !== "owner" && role !== "admin")
    return Response.json({ error: "forbidden" }, { status: 403 });
  let entitlements;
  try {
    entitlements = await resolveWorkspaceEntitlementsForMember(auth.client, input.workspaceId);
  } catch {
    return Response.json({ error: "billing_state_unavailable" }, { status: 503 });
  }
  if (!connectorProviderEntitled(entitlements, input.provider))
    return Response.json(
      { error: input.provider === "slack" ? "slack_not_entitled" : "pro_plan_required" },
      { status: 402 },
    );
  const environment = getEnvironment();
  if (
    !isIntegrationConfigured(configurationName[input.provider], environment) ||
    !isIntegrationConfigured("connectorEncryption", environment)
  )
    return Response.json({ error: `${input.provider}_not_configured` }, { status: 503 });
  const adapter = getConnectorProvider(input.provider);
  const secrets = newOAuthSecrets();
  const stateHash = connectorStateHash(secrets.state);
  const browserBindingHash = connectorStateHash(secrets.browserBinding);
  const { challenge, verifier } =
    input.provider === "slack"
      ? { challenge: undefined, verifier: undefined }
      : await import("@/lib/connectors/providers").then(({ generatePkce }) => generatePkce());
  const verifierCipher = verifier
    ? encryptConnectorCredential(verifier, `auterim-connector-pkce:v1:${stateHash}`)
    : null;
  const service = createSupabaseServerClient();
  const { error } = await service.from("connector_authorization_states").insert({
    state_hash: stateHash,
    provider: input.provider,
    workspace_id: input.workspaceId,
    actor_user_id: auth.user.id,
    browser_binding_hash: browserBindingHash,
    pkce_ciphertext: verifierCipher?.ciphertext ?? null,
    pkce_nonce: verifierCipher?.nonce ?? null,
    pkce_tag: verifierCipher?.authenticationTag ?? null,
    pkce_key_version: verifierCipher?.keyVersion ?? null,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  if (error)
    return Response.json({ error: "connector_authorization_unavailable" }, { status: 503 });
  const secure = new URL(environment.NEXT_PUBLIC_APP_URL).protocol === "https:" ? "; Secure" : "";
  const response = Response.json({
    authorizationUrl: adapter.beginAuthorization(secrets.state, challenge),
    expiresInSeconds: 600,
  });
  response.headers.append(
    "set-cookie",
    `auterim_connector_${input.provider}=${secrets.browserBinding}; Path=/api/connectors/${input.provider}/callback; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
  );
  return response;
}
