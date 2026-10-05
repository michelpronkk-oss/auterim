import { z } from "zod";
import {
  authenticateOnboardingRequest,
  onboardingError,
  parseJsonBody,
} from "@/lib/onboarding/auth";

const operationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("manual_add"),
      workspaceId: z.string().uuid(),
      dependencySlug: z.string().trim().min(1).max(80),
    })
    .strict(),
  z
    .object({
      action: z.literal("decision"),
      workspaceId: z.string().uuid(),
      candidateId: z.string().uuid(),
      decision: z.enum(["confirmed", "rejected"]),
    })
    .strict(),
]);

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
  const { data, error } = await auth.client.rpc("get_product_dependencies", {
    p_workspace_id: workspaceId.data,
    p_product_id: productId.data,
  });
  if (error) return onboardingError(error);
  return Response.json({ dependencies: data });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const productId = z
    .string()
    .uuid()
    .safeParse((await context.params).id);
  if (!productId.success) return Response.json({ error: "invalid_product_id" }, { status: 400 });
  try {
    const input = operationSchema.parse(await parseJsonBody(request));
    const operation =
      input.action === "decision"
        ? await auth.client.rpc("decide_product_dependency_candidate", {
            p_workspace_id: input.workspaceId,
            p_product_id: productId.data,
            p_candidate_id: input.candidateId,
            p_decision: input.decision,
          })
        : await auth.client.rpc("add_product_dependency_manually", {
            p_workspace_id: input.workspaceId,
            p_product_id: productId.data,
            p_dependency_slug: input.dependencySlug,
          });
    if (operation.error) return onboardingError(operation.error);
    return Response.json(operation.data);
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: "invalid_dependency_operation" }, { status: 400 });
    return onboardingError(error);
  }
}
