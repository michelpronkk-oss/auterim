import { z } from "zod";
import { getWorkspaceRole } from "@/lib/billing/server";
import { authenticateOnboardingRequest, parseJsonBody } from "@/lib/onboarding/auth";

const archiveSchema = z
  .object({ workspaceId: z.string().uuid(), action: z.literal("archive") })
  .strict();

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const productId = z.string().uuid().safeParse(id);
  if (!productId.success) return Response.json({ error: "invalid_product_id" }, { status: 400 });

  let input: z.infer<typeof archiveSchema>;
  try {
    input = archiveSchema.parse(await parseJsonBody(request));
  } catch {
    return Response.json({ error: "invalid_product_operation" }, { status: 400 });
  }
  const role = await getWorkspaceRole(auth.client, input.workspaceId, auth.user.id).catch(
    () => null,
  );
  if (role !== "owner" && role !== "admin")
    return Response.json({ error: "owner_or_admin_required" }, { status: 403 });

  const { data, error } = await auth.client.rpc("archive_workspace_product", {
    p_workspace_id: input.workspaceId,
    p_product_id: productId.data,
  });
  if (error) {
    if (error.code === "P0002")
      return Response.json({ error: "product_not_found" }, { status: 404 });
    if (error.code === "23514")
      return Response.json({ error: "default_product_replacement_required" }, { status: 409 });
    if (error.code === "42501") return Response.json({ error: "forbidden" }, { status: 403 });
    return Response.json({ error: "product_archive_failed" }, { status: 503 });
  }
  return Response.json(data);
}
