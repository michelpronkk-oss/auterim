import { z } from "zod";
import { getWorkspaceRole } from "@/lib/billing/server";
import {
  authenticateOnboardingRequest,
  onboardingError,
  parseJsonBody,
} from "@/lib/onboarding/auth";

const policyFields =
  "workspace_id,product_id,policy_version,enabled,human_review_required,draft_pr_preparation_allowed,automatic_workflow_handoff_allowed,approval_required,allowed_repository_ids,updated_at";

const updateSchema = z
  .object({
    workspaceId: z.string().uuid(),
    enabled: z.boolean(),
    draftPrPreparationAllowed: z.boolean(),
    automaticWorkflowHandoffAllowed: z.boolean(),
    approvalRequired: z.boolean(),
    allowedRepositoryIds: z.array(z.string().uuid()).max(100),
  })
  .strict();

function safePolicy(
  policy: Record<string, unknown> | null,
  workspaceId: string,
  productId: string,
) {
  if (!policy) {
    return {
      workspaceId,
      productId,
      version: 0,
      enabled: false,
      humanReviewRequired: true,
      draftPrPreparationAllowed: false,
      automaticWorkflowHandoffAllowed: false,
      approvalRequired: true,
      allowedRepositoryIds: [],
      updatedAt: null,
    };
  }
  return {
    workspaceId: policy.workspace_id,
    productId: policy.product_id,
    version: policy.policy_version,
    enabled: policy.enabled,
    humanReviewRequired: true,
    draftPrPreparationAllowed: policy.draft_pr_preparation_allowed,
    automaticWorkflowHandoffAllowed: policy.automatic_workflow_handoff_allowed,
    approvalRequired: policy.approval_required,
    allowedRepositoryIds: policy.allowed_repository_ids,
    updatedAt: policy.updated_at,
  };
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const productId = z
    .string()
    .uuid()
    .safeParse((await context.params).id);
  const workspaceId = z
    .string()
    .uuid()
    .safeParse(new URL(request.url).searchParams.get("workspaceId"));
  if (!productId.success || !workspaceId.success)
    return Response.json({ error: "invalid_product_input" }, { status: 400 });
  const role = await getWorkspaceRole(auth.client, workspaceId.data, auth.user.id).catch(
    () => null,
  );
  if (!role) return Response.json({ error: "forbidden" }, { status: 403 });
  const { data: product, error: productError } = await auth.client
    .from("workspace_products")
    .select("id")
    .eq("id", productId.data)
    .eq("workspace_id", workspaceId.data)
    .maybeSingle();
  if (productError)
    return Response.json({ error: "remediation_policy_unavailable" }, { status: 503 });
  if (!product) return Response.json({ error: "product_not_found" }, { status: 404 });
  const { data, error } = await auth.client
    .from("product_remediation_policies")
    .select(policyFields)
    .eq("product_id", productId.data)
    .eq("workspace_id", workspaceId.data)
    .maybeSingle();
  if (error) return Response.json({ error: "remediation_policy_unavailable" }, { status: 503 });
  return Response.json({
    policy: safePolicy(data as Record<string, unknown> | null, workspaceId.data, productId.data),
  });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const productId = z
    .string()
    .uuid()
    .safeParse((await context.params).id);
  if (!productId.success) return Response.json({ error: "invalid_product_id" }, { status: 400 });
  let input: z.infer<typeof updateSchema>;
  try {
    input = updateSchema.parse(await parseJsonBody(request));
  } catch {
    return Response.json({ error: "invalid_remediation_policy" }, { status: 400 });
  }
  const role = await getWorkspaceRole(auth.client, input.workspaceId, auth.user.id).catch(
    () => null,
  );
  if (role !== "owner" && role !== "admin")
    return Response.json({ error: "owner_or_admin_required" }, { status: 403 });
  const { data: product, error: productError } = await auth.client
    .from("workspace_products")
    .select("id")
    .eq("id", productId.data)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();
  if (productError)
    return Response.json({ error: "remediation_policy_unavailable" }, { status: 503 });
  if (!product) return Response.json({ error: "product_not_found" }, { status: 404 });
  const { data, error } = await auth.client.rpc("set_product_remediation_policy", {
    p_workspace_id: input.workspaceId,
    p_product_id: productId.data,
    p_enabled: input.enabled,
    p_draft_pr_preparation_allowed: input.draftPrPreparationAllowed,
    p_automatic_workflow_handoff_allowed: input.automaticWorkflowHandoffAllowed,
    p_approval_required: input.approvalRequired,
    p_allowed_repository_ids: input.allowedRepositoryIds,
  });
  if (error) return onboardingError(error);
  return Response.json({
    policy: safePolicy(data as Record<string, unknown>, input.workspaceId, productId.data),
  });
}
