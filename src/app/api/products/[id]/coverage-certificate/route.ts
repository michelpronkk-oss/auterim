import { z } from "zod";
import { getWorkspaceRole } from "@/lib/billing/server";
import { readProductCoverageCertificate } from "@/lib/coverage-certification/read";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";

/**
 * The Product's latest coverage certificate and the claim it supports now. Read-only and
 * member-scoped: the caller's own client reads through RLS, and the claim is derived only
 * from the persisted certificate, never stronger than it.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const productId = z.string().uuid().safeParse(id);
  const workspaceId = z
    .string()
    .uuid()
    .safeParse(new URL(request.url).searchParams.get("workspaceId"));
  if (!productId.success || !workspaceId.success)
    return Response.json({ error: "invalid_coverage_certificate_query" }, { status: 400 });

  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const role = await getWorkspaceRole(auth.client, workspaceId.data, auth.user.id);
  if (!role) return Response.json({ error: "forbidden" }, { status: 403 });

  try {
    const product = await auth.client
      .from("workspace_products")
      .select("id")
      .eq("id", productId.data)
      .eq("workspace_id", workspaceId.data)
      .maybeSingle();
    if (product.error) throw product.error;
    if (!product.data) return Response.json({ error: "not_found" }, { status: 404 });
    const view = await readProductCoverageCertificate(auth.client, {
      workspaceId: workspaceId.data,
      productId: productId.data,
    });
    return Response.json(view, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    console.error("Coverage certificate read failed.");
    return Response.json({ error: "coverage_certificate_unavailable" }, { status: 503 });
  }
}
