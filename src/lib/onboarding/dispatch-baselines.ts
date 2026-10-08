import "server-only";

import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import type { scanSourceTask } from "@/trigger/scan-source";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  baselineClaimResult,
  dispatchBaselineClaims,
  type BaselineDispatchClaim,
} from "@/lib/onboarding/baseline-dispatch";

const claimSchema = z.array(
  z.object({
    queue_id: z.string().uuid(),
    source_id: z.string().uuid(),
    dispatch_attempt: z.number().int().positive(),
    lease_recovery_count: z.number().int().nonnegative(),
    recovered: z.boolean(),
  }),
);

/** Immediately hands newly requested global baseline work to the existing bounded dispatcher. */
export async function dispatchOnboardingBaselines(actorUserId: string, workspaceId: string) {
  const dispatchClient = createSupabaseServerClient();
  let claims: { data: unknown; error: unknown | null };
  try {
    const result = await dispatchClient.rpc("claim_onboarding_baseline_sources", {
      p_actor_user_id: actorUserId,
      p_workspace_id: workspaceId,
      p_limit: 100,
    });
    claims = { data: result.data, error: result.error };
  } catch {
    claims = { data: null, error: true };
  }
  if (baselineClaimResult(claims.error, 0) === "error") {
    console.warn("Onboarding baseline claim failed.", {
      workspaceId,
      stage: "claim",
      outcome: "error",
      errorCategory: "claim_rpc_error",
      attemptCount: 0,
      leaseRecoveryState: "not_claimed",
    });
    return { dispatched: 0, failed: 1 };
  }
  try {
    const claimed = claimSchema.parse(claims.data ?? []) as BaselineDispatchClaim[];
    if (baselineClaimResult(null, claimed.length) === "empty") {
      console.info("Onboarding baseline claim completed.", {
        workspaceId,
        stage: "claim",
        outcome: "empty",
        errorCategory: null,
        attemptCount: 0,
        leaseRecoveryState: "not_applicable",
      });
      return { dispatched: 0, failed: 0 };
    }
    return await dispatchBaselineClaims(claimed, workspaceId, {
      createIdempotencyKey: (claim) =>
        idempotencyKeys.create(`baseline-source:${claim.queue_id}:${claim.dispatch_attempt}`, {
          scope: "global",
        }),
      trigger: (sourceId, idempotencyKey) =>
        tasks.trigger<typeof scanSourceTask>("scan-source", { sourceId }, { idempotencyKey }),
      markDispatched: (claim, triggerRunId) =>
        dispatchClient.rpc("mark_onboarding_baseline_dispatched", {
          p_actor_user_id: actorUserId,
          p_workspace_id: workspaceId,
          p_queue_id: claim.queue_id,
          p_dispatch_attempt: claim.dispatch_attempt,
          p_trigger_run_id: triggerRunId,
        }),
      release: (claim) =>
        dispatchClient.rpc("release_onboarding_baseline_claim", {
          p_actor_user_id: actorUserId,
          p_workspace_id: workspaceId,
          p_queue_id: claim.queue_id,
          p_dispatch_attempt: claim.dispatch_attempt,
        }),
      log: (event) => {
        if (event.outcome === "error")
          console.warn("Onboarding baseline dispatch observed.", event);
        else console.info("Onboarding baseline dispatch observed.", event);
      },
    });
  } catch {
    // Activation is durable; malformed/recoverable dispatch state is handled by the global worker.
    console.warn("Onboarding baseline claim response was invalid.", {
      workspaceId,
      stage: "claim",
      outcome: "error",
      errorCategory: "claim_response_invalid",
      attemptCount: 0,
      leaseRecoveryState: "not_claimed",
    });
    return { dispatched: 0, failed: 1 };
  }
}
