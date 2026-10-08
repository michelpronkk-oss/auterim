import { z } from "zod";
import { resolveWorkspaceEntitlementsForMember } from "@/lib/billing/server";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { getWorkspaceRole } from "@/lib/billing/server";
import { getProductProtectionGraph } from "@/lib/protection/product-graph";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const productId = z.string().uuid().safeParse(id);
  const workspaceId = z
    .string()
    .uuid()
    .safeParse(new URL(request.url).searchParams.get("workspaceId"));
  if (!productId.success || !workspaceId.success)
    return Response.json({ error: "invalid_product_graph_query" }, { status: 400 });

  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const role = await getWorkspaceRole(auth.client, workspaceId.data, auth.user.id);
  if (!role) return Response.json({ error: "forbidden" }, { status: 403 });

  try {
    const entitlements = await resolveWorkspaceEntitlementsForMember(auth.client, workspaceId.data);
    const graph = await getProductProtectionGraph(auth.client, {
      workspaceId: workspaceId.data,
      productId: productId.data,
      verificationCapabilityAvailable: entitlements.capabilities.automaticPreflight,
    });
    if (!graph) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(graph, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ error: "product_protection_graph_unavailable" }, { status: 503 });
  }
}
