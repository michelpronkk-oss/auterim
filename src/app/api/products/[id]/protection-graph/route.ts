import { z } from "zod";
import { resolveWorkspaceEntitlementsForMember } from "@/lib/billing/server";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { getWorkspaceRole } from "@/lib/billing/server";
import { getProductProtectionGraph } from "@/lib/protection/product-graph";
import {
  productProtectionReadStage,
  type ProductProtectionReadStage,
} from "@/lib/protection/read-stage";

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

  let readStage: ProductProtectionReadStage = "entitlements";
  try {
    const entitlements = await resolveWorkspaceEntitlementsForMember(auth.client, workspaceId.data);
    readStage = "repository_graph";
    const graph = await getProductProtectionGraph(auth.client, {
      workspaceId: workspaceId.data,
      productId: productId.data,
      verificationCapabilityAvailable: entitlements.capabilities.automaticPreflight,
    });
    if (!graph) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(graph, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const stage = productProtectionReadStage(error);
    console.error("Product protection read failed.", {
      stage: stage === "unknown" ? readStage : stage,
    });
    return Response.json({ error: "product_protection_graph_unavailable" }, { status: 503 });
  }
}
