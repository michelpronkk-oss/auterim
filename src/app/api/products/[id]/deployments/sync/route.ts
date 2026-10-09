import { z } from "zod";
import { connectorProviderEntitled } from "@/lib/connectors/entitlements";
import {
  getFreshProviderCredentials,
  loadInstallation,
  serverConnectors,
} from "@/lib/connectors/service";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { getWorkspaceRole, resolveWorkspaceEntitlementsForMember } from "@/lib/billing/server";
import { syncSelectedVercelProject } from "@/lib/deployments/service";

const requestSchema = z.object({
  workspaceId: z.string().uuid(),
  installationId: z.string().uuid(),
  resourceId: z.string().uuid(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const productId = z.string().uuid().safeParse(id);
  if (!productId.success) return Response.json({ error: "invalid_product" }, { status: 400 });
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const input = requestSchema.safeParse(await request.json().catch(() => null));
  if (!input.success)
    return Response.json({ error: "invalid_deployment_sync_request" }, { status: 400 });
  const role = await getWorkspaceRole(auth.client, input.data.workspaceId, auth.user.id).catch(
    () => null,
  );
  if (role !== "owner" && role !== "admin")
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { data: product, error: productError } = await auth.client
    .from("workspace_products")
    .select("id,status")
    .eq("workspace_id", input.data.workspaceId)
    .eq("id", productId.data)
    .maybeSingle();
  if (productError) return Response.json({ error: "deployment_sync_unavailable" }, { status: 503 });
  if (!product) return Response.json({ error: "not_found" }, { status: 404 });
  if (product.status !== "protected")
    return Response.json({ error: "product_not_protected" }, { status: 409 });
  try {
    const entitlements = await resolveWorkspaceEntitlementsForMember(
      auth.client,
      input.data.workspaceId,
    );
    if (!connectorProviderEntitled(entitlements, "vercel"))
      return Response.json({ error: "connector_not_entitled" }, { status: 402 });
  } catch {
    return Response.json({ error: "billing_state_unavailable" }, { status: 503 });
  }

  const { data: resource, error: resourceError } = await auth.client
    .from("connector_resources")
    .select("id,installation_id,external_resource_id,resource_type,selected,access_state")
    .eq("id", input.data.resourceId)
    .eq("workspace_id", input.data.workspaceId)
    .eq("installation_id", input.data.installationId)
    .eq("resource_type", "project")
    .eq("selected", true)
    .eq("access_state", "available")
    .maybeSingle();
  if (resourceError)
    return Response.json({ error: "deployment_resource_unavailable" }, { status: 503 });
  if (!resource)
    return Response.json({ error: "selected_vercel_project_required" }, { status: 409 });

  const service = serverConnectors();
  try {
    const installation = await loadInstallation(
      service,
      input.data.workspaceId,
      input.data.installationId,
      "vercel",
    );
    const credentials = await getFreshProviderCredentials(service, installation);
    const result = await syncSelectedVercelProject({
      service,
      workspaceId: input.data.workspaceId,
      productId: productId.data,
      installation,
      credentials,
      externalProjectId: resource.external_resource_id,
    });
    return Response.json(
      {
        observed: result.observed,
        mappedProducts: result.mappedProducts,
        currentProductionDeploymentId: result.currentProductionDeploymentId,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return Response.json({ error: "deployment_sync_failed" }, { status: 503 });
  }
}
