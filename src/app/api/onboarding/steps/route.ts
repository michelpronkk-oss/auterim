import { z } from "zod";
import {
  authenticateOnboardingRequest,
  onboardingError,
  parseJsonBody,
} from "@/lib/onboarding/auth";

const inputSchema = z
  .object({
    workspaceId: z.string().uuid(),
    step: z.enum(["dependencies_review", "context_setup", "notifications_setup"]),
  })
  .strict();

export async function POST(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const input = inputSchema.parse(await parseJsonBody(request));
    const { data, error } = await auth.client.rpc("complete_onboarding_step", {
      p_workspace_id: input.workspaceId,
      p_step: input.step,
    });
    if (error) return onboardingError(error);
    return Response.json({ currentStep: data });
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: "invalid_onboarding_step" }, { status: 400 });
    return onboardingError(error);
  }
}
