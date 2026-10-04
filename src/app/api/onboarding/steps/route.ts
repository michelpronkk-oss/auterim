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
    if (input.step === "dependencies_review") {
      const status = await auth.client.rpc("get_onboarding_status", {
        p_workspace_id: input.workspaceId,
      });
      if (status.error) return onboardingError(status.error);
      const onboarding = z
        .object({
          currentStep: z.string(),
          discovery: z.object({
            status: z.enum(["running", "completed", "partial", "failed"]).nullable(),
          }),
        })
        .parse(status.data);
      if (
        ["company_created", "discovery_running"].includes(onboarding.currentStep) &&
        onboarding.discovery.status === null
      )
        return Response.json({ error: "discovery_in_progress" }, { status: 409 });
    }
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
