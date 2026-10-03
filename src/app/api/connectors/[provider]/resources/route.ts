import { z } from "zod";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { connectorProviderEntitled } from "@/lib/connectors/entitlements";
import { ConnectorError, type ConnectorProvider } from "@/lib/connectors/model";
import {
  getFreshProviderCredentials,
  loadInstallation,
  serverConnectors,
  setConnectorHealth,
  syncProviderResources,
} from "@/lib/connectors/service";
import { getWorkspaceRole, resolveWorkspaceEntitlementsForMember } from "@/lib/billing/server";

async function providerParam(context: {
  params: Promise<{ provider: string }>;
}): Promise<Exclude<ConnectorProvider, "github"> | null> {
  const provider = (await context.params).provider;
  return provider === "slack" || provider === "linear" || provider === "sentry" ? provider : null;
}

export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  const provider = await providerParam(context);
  if (!provider) return Response.json({ error: "unsupported_connector" }, { status: 404 });
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const query = new URL(request.url).searchParams;
  const workspaceId = z.string().uuid().safeParse(query.get("workspaceId"));
  const installationId = z.string().uuid().safeParse(query.get("installationId"));
  if (!workspaceId.success || !installationId.success)
    return Response.json({ error: "invalid_connector_query" }, { status: 400 });
  const role = await getWorkspaceRole(auth.client, workspaceId.data, auth.user.id).catch(
    () => null,
  );
  if (!role) return Response.json({ error: "forbidden" }, { status: 403 });
  const { data: installation, error: installationError } = await auth.client
    .from("connector_installations")
    .select("id")
    .eq("id", installationId.data)
    .eq("workspace_id", workspaceId.data)
    .eq("provider", provider)
    .maybeSingle();
  if (installationError || !installation)
    return Response.json({ error: "connector_not_found" }, { status: 404 });
  const { data, error } = await auth.client
    .from("connector_resources")
    .select(
      "id,external_resource_id,resource_type,display_name,selected,access_state,safe_metadata,last_seen_at",
    )
    .eq("workspace_id", workspaceId.data)
    .eq("installation_id", installationId.data)
    .order("display_name")
    .limit(provider === "sentry" ? 100 : 200);
  if (error) return Response.json({ error: "connector_resources_unavailable" }, { status: 503 });
  return Response.json({ resources: data ?? [] });
}

export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  const provider = await providerParam(context);
  if (!provider) return Response.json({ error: "unsupported_connector" }, { status: 404 });
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const input = z
    .object({ workspaceId: z.string().uuid(), installationId: z.string().uuid() })
    .safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: "invalid_connector_request" }, { status: 400 });
  const role = await getWorkspaceRole(auth.client, input.data.workspaceId, auth.user.id).catch(
    () => null,
  );
  if (role !== "owner" && role !== "admin")
    return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    const entitlements = await resolveWorkspaceEntitlementsForMember(
      auth.client,
      input.data.workspaceId,
    );
    if (!connectorProviderEntitled(entitlements, provider))
      return Response.json({ error: "connector_not_entitled" }, { status: 402 });
    const service = serverConnectors();
    const installation = await loadInstallation(
      service,
      input.data.workspaceId,
      input.data.installationId,
      provider,
    );
    if (
      installation.lifecycle_state === "revoked" ||
      installation.lifecycle_state === "disconnected"
    )
      return Response.json({ error: "connector_reauthorization_required" }, { status: 409 });
    const credentials = await getFreshProviderCredentials(service, installation);
    const resourceCount = await syncProviderResources(service, installation, credentials);
    await service
      .from("connector_installations")
      .update({ last_checked_at: new Date().toISOString() })
      .eq("id", installation.id)
      .eq("workspace_id", installation.workspace_id);
    const { data: resources, error } = await auth.client
      .from("connector_resources")
      .select(
        "id,external_resource_id,resource_type,display_name,selected,access_state,safe_metadata,last_seen_at",
      )
      .eq("workspace_id", input.data.workspaceId)
      .eq("installation_id", installation.id)
      .order("display_name")
      .limit(provider === "sentry" ? 100 : 200);
    if (error) throw new Error("connector_resource_read_failed");
    return Response.json({ resourceCount, resources: resources ?? [] });
  } catch (error) {
    const service = serverConnectors();
    const category = error instanceof ConnectorError ? error.category : "UNKNOWN_SAFE";
    const health =
      category === "AUTH_REQUIRED"
        ? "reauth_required"
        : category === "PERMISSION_MISSING"
          ? "permission_missing"
          : category === "RESOURCE_NOT_FOUND"
            ? "resource_missing"
            : category === "PROVIDER_UNAVAILABLE" || category === "RATE_LIMITED"
              ? "provider_unavailable"
              : "degraded";
    const state =
      category === "AUTH_REQUIRED"
        ? "reauth_required"
        : category === "PERMISSION_MISSING"
          ? "degraded"
          : "degraded";
    try {
      const installation = await loadInstallation(
        service,
        input.data.workspaceId,
        input.data.installationId,
        provider,
      );
      await setConnectorHealth(
        service,
        installation,
        state,
        health,
        category === "AUTH_REQUIRED"
          ? "refresh_failed"
          : category === "PERMISSION_MISSING"
            ? "permission_lost"
            : undefined,
      );
    } catch {
      // Keep provider error details out of the caller response.
    }
    return Response.json(
      { error: "connector_resource_discovery_failed", category },
      { status: category === "AUTH_REQUIRED" ? 409 : 503 },
    );
  }
}

export async function PUT(request: Request, context: { params: Promise<{ provider: string }> }) {
  const provider = await providerParam(context);
  if (!provider) return Response.json({ error: "unsupported_connector" }, { status: 404 });
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const input = z
    .object({
      workspaceId: z.string().uuid(),
      installationId: z.string().uuid(),
      resourceIds: z
        .array(z.string().uuid())
        .min(1)
        .max(provider === "sentry" ? 5 : 1),
    })
    .safeParse(await request.json().catch(() => null));
  if (!input.success)
    return Response.json({ error: "invalid_resource_selection" }, { status: 400 });
  const role = await getWorkspaceRole(auth.client, input.data.workspaceId, auth.user.id).catch(
    () => null,
  );
  if (role !== "owner" && role !== "admin")
    return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    const entitlements = await resolveWorkspaceEntitlementsForMember(
      auth.client,
      input.data.workspaceId,
    );
    if (!connectorProviderEntitled(entitlements, provider))
      return Response.json({ error: "connector_not_entitled" }, { status: 402 });
  } catch {
    return Response.json({ error: "billing_state_unavailable" }, { status: 503 });
  }
  const service = serverConnectors();
  try {
    await loadInstallation(service, input.data.workspaceId, input.data.installationId, provider);
  } catch {
    return Response.json({ error: "connector_not_found" }, { status: 404 });
  }
  const { data, error } = await service.rpc("select_connector_resources", {
    p_workspace_id: input.data.workspaceId,
    p_installation_id: input.data.installationId,
    p_actor_user_id: auth.user.id,
    p_resource_ids: input.data.resourceIds,
  });
  if (error) {
    const code = (error as { code?: string }).code;
    return Response.json(
      { error: code === "42501" ? "forbidden" : "invalid_resource_selection" },
      { status: code === "42501" ? 403 : 400 },
    );
  }
  return Response.json({ selected: data });
}
