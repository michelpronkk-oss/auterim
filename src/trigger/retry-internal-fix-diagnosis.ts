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
    if (
      error ||
      !data ||
      data.fixRunId !== fixRunId ||
      !Number.isInteger(data.retryGeneration) ||
      data.retryGeneration < 1 ||
      data.retryGeneration > 2
    ) {
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

/**
 * One-time recovery for the already exhausted M15.78R QA diagnosis execution.
 * The database RPC pins the run, workspace, Product, repository, graph, commit,
 * prior model metadata, and recovery budget before a stage is re-enqueued.
 */
export const recoverInternalFixDiagnosisAfterContractRepairTask = schemaTask({
  id: "recover-internal-fix-diagnosis-after-contract-repair",
  schema: z.object({ fixRunId: z.string().uuid() }).strict(),
  retry: { maxAttempts: 1 },
  maxDuration: 60,
  queue: { concurrencyLimit: 1 },
  run: async ({ fixRunId }, { ctx }) => {
    const targetFixRunId = "7de04a75-aefa-43a6-ba64-9fa4a70e0ec1";
    if (fixRunId !== targetFixRunId) {
      return { status: "blocked", category: "internal_diagnosis_recovery_scope_invalid" } as const;
    }

    const client = createSupabaseServerClient();
    const { data, error } = await client.rpc("authorize_internal_fix_diagnosis_recovery", {
      p_fix_run_id: fixRunId,
      p_authorization_reference: "M15.78R user-authorized single post-model recovery",
      p_trigger_run_id: ctx.run.id,
    });
    if (
      error ||
      !data ||
      data.fixRunId !== fixRunId ||
      typeof data.stageId !== "string" ||
      typeof data.recoveryId !== "string" ||
      data.recoveryGeneration !== 1 ||
      !["retry_queued", "already_authorized"].includes(data.status)
    ) {
      return { status: "blocked", category: "internal_diagnosis_recovery_not_eligible" } as const;
    }

    const run = await tasks.trigger(
      "process-fix-engine-stage",
      { fixRunId, stage: "diagnose" },
      {
        idempotencyKey: `fix-engine:authorized-recovery:${data.recoveryId}`,
        idempotencyKeyTTL: "30d",
      },
    );
    return {
      status: "recovery_dispatched",
      fixRunId,
      recoveryId: data.recoveryId,
      stageId: data.stageId,
      triggerRunId: run.id,
    } as const;
  },
});
