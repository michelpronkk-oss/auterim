import { z } from "zod";
import { resolveWorkspaceEntitlementsForMember } from "@/lib/billing/server";
import { authenticateOnboardingRequest, parseJsonBody } from "@/lib/onboarding/auth";
import { getProductRepositoryProtection } from "@/lib/repositories/product-protection-read-model";

const mappingSchema = z.object({
  workspaceId: z.string().uuid(),
  repositoryId: z.string().uuid(),
});

async function getProductAccess(request: Request, productId: string, workspaceId: string) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return { auth, response: auth.response } as const;
  const { data: membership, error: membershipError } = await auth.client
    .from("workspace_members")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (membershipError)
    return {
      auth,
      response: Response.json({ error: "workspace_access_unavailable" }, { status: 503 }),
    } as const;
  if (!membership)
    return { auth, response: Response.json({ error: "forbidden" }, { status: 403 }) } as const;
  const { data: product, error: productError } = await auth.client
    .from("workspace_products")
    .select("id")
    .eq("id", productId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (productError)
    return {
      auth,
      response: Response.json({ error: "product_unavailable" }, { status: 503 }),
    } as const;
  if (!product)
    return { auth, response: Response.json({ error: "not_found" }, { status: 404 }) } as const;
  return { auth, response: null } as const;
}

function safeMutationError(error: { code?: string; message?: string } | null) {
  const code = error?.message?.match(/^[a-z_]+/)?.[0] ?? error?.code;
  if (code === "forbidden") return Response.json({ error: "forbidden" }, { status: 403 });
  if (code === "repository_plan_required")
    return Response.json({ error: "repository_connections_plan_required" }, { status: 402 });
  if (code === "repository_quota_exceeded")
    return Response.json({ error: "repository_quota_exceeded" }, { status: 409 });
  if (code === "repository_unavailable")
    return Response.json({ error: "repository_unavailable" }, { status: 422 });
  if (code === "product_not_found" || code === "repository_not_found")
    return Response.json({ error: "resource_not_found" }, { status: 404 });
  if (code === "product_not_available")
    return Response.json({ error: "product_not_available" }, { status: 422 });
  return Response.json({ error: "repository_mapping_failed" }, { status: 503 });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const workspaceId = new URL(request.url).searchParams.get("workspaceId");
  if (!workspaceId || !z.string().uuid().safeParse(workspaceId).success)
    return Response.json({ error: "workspace_id_required" }, { status: 400 });
  const access = await getProductAccess(request, id, workspaceId);
  if (access.response) return access.response;
  try {
    const entitlements = await resolveWorkspaceEntitlementsForMember(
      access.auth.client,
      workspaceId,
    );
    const graph = await getProductRepositoryProtection(access.auth.client, {
      workspaceId,
      productId: id,
      verificationCapabilityAvailable: entitlements.capabilities.automaticPreflight,
    });
    if (!graph) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(
      {
        ...graph,
        protectionUsage: {
          protectedRepositories: entitlements.usage.repositories,
          repositoryLimit: entitlements.limits.repositories,
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return Response.json({ error: "product_repository_graph_unavailable" }, { status: 503 });
  }
}

async function mutateMapping(
  request: Request,
  context: { params: Promise<{ id: string }> },
  operation: "map" | "unmap",
) {
  const { id } = await context.params;
  let input: z.infer<typeof mappingSchema>;
  try {
    input = mappingSchema.parse(await parseJsonBody(request));
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const access = await getProductAccess(request, id, input.workspaceId);
  if (access.response) return access.response;
  const { data, error } = await access.auth.client.rpc(
    operation === "map" ? "map_repository_to_product" : "unmap_repository_from_product",
    { p_product_id: id, p_repository_id: input.repositoryId },
  );
  if (error) return safeMutationError(error);
  return Response.json(data);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return mutateMapping(request, context, "map");
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return mutateMapping(request, context, "unmap");
}
