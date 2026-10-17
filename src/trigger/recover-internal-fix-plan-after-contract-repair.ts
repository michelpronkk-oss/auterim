import { schemaTask, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** One database-authorized Plan retry for the immutable M15.78R Test run. */
export const recoverInternalFixPlanAfterContractRepairTask = schemaTask({
  id: "recover-internal-fix-plan-after-contract-repair",
  schema: z.object({ fixRunId: z.string().uuid() }).strict(),
  retry: { maxAttempts: 1 },
  maxDuration: 60,
  queue: { concurrencyLimit: 1 },
  run: async ({ fixRunId }, { ctx }) => {
    const targetFixRunId = "7de04a75-aefa-43a6-ba64-9fa4a70e0ec1";
    if (fixRunId !== targetFixRunId) {
      return { status: "blocked", category: "internal_plan_recovery_scope_invalid" } as const;
    }

    const client = createSupabaseServerClient();
    const { data, error } = await client.rpc("authorize_internal_fix_plan_contract_recovery", {
      p_fix_run_id: fixRunId,
      p_authorization_reference: "M15.78R user-authorized single bounded plan recovery",
      p_trigger_run_id: ctx.run.id,
    });
    if (
      error ||
      !data ||
      data.fixRunId !== fixRunId ||
      data.stageId !== "64455e32-f8c7-4f96-a26b-f1cbb04e1a6e" ||
      typeof data.recoveryId !== "string" ||
      data.recoveryGeneration !== 1 ||
      !["retry_queued", "already_authorized"].includes(data.status)
    ) {
      return { status: "blocked", category: "internal_plan_recovery_not_eligible" } as const;
    }

    const run = await tasks.trigger(
      "process-fix-engine-stage",
      { fixRunId, stage: "plan" },
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
