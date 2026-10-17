import { schemaTask, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Operator-only recovery for the one bounded internal diagnosis retry allowed
 * by the database. The RPC revalidates the Test workspace and evidence-only
 * provenance; the scheduled stage dispatcher remains a recovery fallback.
 */
export const retryInternalFixDiagnosisTask = schemaTask({
  id: "retry-internal-fix-diagnosis",
  schema: z.object({ fixRunId: z.string().uuid() }).strict(),
  retry: { maxAttempts: 1 },
  maxDuration: 60,
  queue: { concurrencyLimit: 1 },
  run: async ({ fixRunId }) => {
    const client = createSupabaseServerClient();
    const { data, error } = await client.rpc(
      "requeue_internal_fix_diagnosis_after_model_auth_repair",
      { p_fix_run_id: fixRunId },
    );
    if (error || !data || data.fixRunId !== fixRunId || data.retryGeneration !== 1) {
      return { status: "blocked", category: "internal_diagnosis_retry_not_eligible" } as const;
    }
    if (data.status === "already_used") {
      return { status: "already_used", fixRunId, stageId: data.stageId } as const;
    }
    if (data.status !== "retry_queued" || typeof data.stageId !== "string") {
      return { status: "blocked", category: "internal_diagnosis_retry_state_invalid" } as const;
    }

    const run = await tasks.trigger(
      "process-fix-engine-stage",
      { fixRunId, stage: "diagnose" },
      {
        idempotencyKey: `fix-engine:operator-retry:${fixRunId}:diagnose:${data.retryGeneration}`,
        idempotencyKeyTTL: "7d",
      },
    );
    return {
      status: "retry_dispatched",
      fixRunId,
      stageId: data.stageId,
      triggerRunId: run.id,
    } as const;
  },
});
