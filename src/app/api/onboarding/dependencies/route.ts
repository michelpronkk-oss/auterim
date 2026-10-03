import { z } from "zod";
import {
  authenticateOnboardingRequest,
  onboardingError,
  parseJsonBody,
} from "@/lib/onboarding/auth";

const inputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("decision"),
      workspaceId: z.string().uuid(),
      candidateId: z.string().uuid(),
      decision: z.enum(["confirmed", "rejected"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("manual_add"),
      workspaceId: z.string().uuid(),
      dependencySlug: z.string().trim().min(1).max(80),
    })
    .strict(),
]);

export async function GET(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const params = new URL(request.url).searchParams;
  const workspaceId = z.string().uuid().safeParse(params.get("workspaceId"));
  if (!workspaceId.success)
    return Response.json({ error: "invalid_workspace_id" }, { status: 400 });
  const { data, error } = await auth.client.rpc("search_onboarding_dependency_catalog", {
    p_workspace_id: workspaceId.data,
    p_query: (params.get("q") ?? "").slice(0, 80),
  });
  if (error) return onboardingError(error);
  return Response.json({ dependencies: data });
}

export async function POST(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const input = inputSchema.parse(await parseJsonBody(request));
    const { data, error } =
      input.action === "decision"
        ? await auth.client.rpc("decide_onboarding_dependency_candidate", {
            p_workspace_id: input.workspaceId,
            p_candidate_id: input.candidateId,
            p_decision: input.decision,
          })
        : await auth.client.rpc("add_onboarding_dependency_manually", {
            p_workspace_id: input.workspaceId,
            p_dependency_slug: input.dependencySlug,
          });
    if (error) return onboardingError(error);
    return Response.json(data);
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: "invalid_dependency_operation" }, { status: 400 });
    return onboardingError(error);
  }
}
