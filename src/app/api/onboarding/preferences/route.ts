import { z } from "zod";
import {
  authenticateOnboardingRequest,
  onboardingError,
  parseJsonBody,
} from "@/lib/onboarding/auth";

const inputSchema = z
  .object({
    workspaceId: z.string().uuid(),
    importantChanges: z.enum(["daily_digest", "instant", "off"]),
    informational: z.enum(["off", "digest"]),
    monthlyProtectionReport: z.boolean(),
  })
  .strict();

export async function PUT(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const input = inputSchema.parse(await parseJsonBody(request));
    const { data, error } = await auth.client.rpc("save_onboarding_notification_preferences", {
      p_workspace_id: input.workspaceId,
      p_important_changes: input.importantChanges,
      p_informational: input.informational,
      p_monthly_protection_report: input.monthlyProtectionReport,
    });
    if (error) return onboardingError(error);
    return Response.json(data);
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: "invalid_notification_preferences" }, { status: 400 });
    return onboardingError(error);
  }
}
