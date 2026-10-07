import { schedules, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { safeDatabaseErrorDiagnostic } from "@/lib/m15/safe-database-error";
import { isM15LocalAcceptanceDuplicateTarget } from "@/lib/m15/local-trigger-proof";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { prepareRemediationTask } from "@/trigger/prepare-remediation";

const batchSchema = z.array(
  z.object({
    queue_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    preflight_run_id: z.string().uuid(),
    impact_assessment_id: z.string().uuid(),
    attempt_count: z.number().int().min(0).max(5),
  }),
);

export const dispatchRemediationPreparationTask = schedules.task({
  id: "dispatch-remediation-preparation",
  cron: { pattern: "*/2 * * * *", window: "2m" },
  run: async () => {
    const client = createSupabaseServerClient();
    const { data, error } = await client.rpc("list_remediation_preparation_queue", {
      p_limit: 20,
    });
    if (error) {
      const diagnostic = safeDatabaseErrorDiagnostic(error);
      console.error(
        JSON.stringify({
          event: "m15_remediation_preparation_queue_read_failed",
          ...diagnostic,
        }),
      );
      throw new Error(`remediation_preparation_queue_read_failed:${diagnostic.code}`);
    }
    const items = batchSchema.parse(data ?? []);
    if (process.env.AUTERIM_M15_LOCAL_INTEGRATION === "1") {
      console.info(`AUTERIM_M15_REMEDIATION_QUEUE_READ_COMPLETED items=${items.length}`);
    }
    let dispatched = 0;
    for (const item of items) {
      const { data: attempt, error: claimError } = await client.rpc(
        "claim_remediation_preparation_dispatch",
        { p_queue_id: item.queue_id },
      );
      if (claimError || typeof attempt !== "number" || attempt <= 0) continue;
      try {
        const handle = await tasks.trigger<typeof prepareRemediationTask>(
          "prepare-remediation",
          {
            queueId: item.queue_id,
            workspaceId: item.workspace_id,
            preflightRunId: item.preflight_run_id,
            impactAssessmentId: item.impact_assessment_id,
            attempt,
          },
          { idempotencyKey: `remediation-preparation:${item.queue_id}:${attempt}` },
        );
        const { data: marked, error: markError } = await client.rpc(
          "mark_remediation_preparation_dispatched",
          {
            p_queue_id: item.queue_id,
            p_attempt: attempt,
            p_trigger_run_id: handle.id,
          },
        );
        if (markError || marked !== true) {
          throw new Error("remediation_preparation_dispatch_mark_failed");
        }
        if (await isM15LocalAcceptanceDuplicateTarget(item.queue_id)) {
          await new Promise((resolve) => setTimeout(resolve, 10_000));
          await tasks.trigger<typeof prepareRemediationTask>(
            "prepare-remediation",
            {
              queueId: item.queue_id,
              workspaceId: item.workspace_id,
              preflightRunId: item.preflight_run_id,
              impactAssessmentId: item.impact_assessment_id,
              attempt,
            },
            { idempotencyKey: `remediation-preparation:${item.queue_id}:${attempt}:m15-duplicate` },
          );
        }
        dispatched++;
      } catch {
        // Leave the durable row for stale-dispatch reconciliation; never log provider payloads.
      }
    }
    return { dispatched };
  },
});
