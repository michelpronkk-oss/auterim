import { z } from "zod";
import {
  authenticateOnboardingRequest,
  onboardingError,
  parseJsonBody,
} from "@/lib/onboarding/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { recordGrowthFirstPartyEvent } from "@/lib/growth-v2/feedback";
import { hasUnresolvedDiscoveryCandidates } from "@/lib/onboarding/activation-readiness";
import { dispatchOnboardingBaselines } from "@/lib/onboarding/dispatch-baselines";

const inputSchema = z.object({ workspaceId: z.string().uuid() }).strict();
const activationSchema = z.object({
  workspaceId: z.string().uuid(),
  activatedAt: z.string(),
  protection: z.object({
    dependencies: z.number().int().nonnegative(),
    authoritativeSources: z.number().int().nonnegative(),
    criticalDependencies: z.number().int().nonnegative(),
    baselineStatus: z.enum(["ready", "in_progress", "partial"]),
  }),
});
export async function POST(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const input = inputSchema.parse(await parseJsonBody(request));
    const current = await auth.client.rpc("get_onboarding_status", {
      p_workspace_id: input.workspaceId,
    });
    if (current.error) return onboardingError(current.error);
    const onboarding = z
      .object({
        discovery: z.object({
          candidates: z.array(z.object({ suggestedStatus: z.string() }).passthrough()),
        }),
      })
      .passthrough()
      .parse(current.data);
    if (hasUnresolvedDiscoveryCandidates(onboarding.discovery.candidates))
      return Response.json({ error: "review_pending_candidates" }, { status: 409 });
    const activated = await auth.client.rpc("activate_workspace_protection", {
      p_workspace_id: input.workspaceId,
    });
    if (activated.error) return onboardingError(activated.error);
    const response = activationSchema.parse(activated.data);
    try {
      await recordGrowthFirstPartyEvent({
        eventType: "protection_activation",
        stableKey: input.workspaceId,
        occurredAt: response.activatedAt,
      });
      const service = createSupabaseServerClient();
      const { data: subscription } = await service
        .from("workspace_subscriptions")
        .select("trial_started_at,status,plan")
        .eq("workspace_id", input.workspaceId)
        .maybeSingle();
      if (
        subscription?.status === "trialing" &&
        subscription.plan === "pro" &&
        subscription.trial_started_at
      )
        await recordGrowthFirstPartyEvent({
          eventType: "trial_started",
          stableKey: `${input.workspaceId}:${subscription.trial_started_at}`,
          occurredAt: subscription.trial_started_at,
        });
    } catch {
      // Growth reporting is idempotent and never blocks protection activation.
    }
    try {
      await dispatchOnboardingBaselines(auth.user.id, input.workspaceId);
    } catch {
      // Protection activation is durable; the global baseline dispatcher recovers queued work.
      console.warn("Onboarding baseline dispatch could not start.", {
        workspaceId: input.workspaceId,
        stage: "claim",
        outcome: "error",
        errorCategory: "claim_rpc_error",
      });
    }
    const status = await auth.client.rpc("get_onboarding_status", {
      p_workspace_id: input.workspaceId,
    });
    if (!status.error) {
      const activation = z
        .object({
          activation: z
            .object({ baselineStatus: z.enum(["ready", "in_progress", "partial"]) })
            .nullable(),
        })
        .parse(status.data);
      response.protection.baselineStatus = activation.activation?.baselineStatus ?? "partial";
    }
    return Response.json(response);
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: "invalid_activation_request" }, { status: 400 });
    return onboardingError(error);
  }
}
