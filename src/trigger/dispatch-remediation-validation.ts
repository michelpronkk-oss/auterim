import { schedules, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { isM15LocalAcceptanceDuplicateTarget } from "@/lib/m15/local-trigger-proof";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { validateRemediationTask } from "@/trigger/validate-remediation";

const batchSchema = z.array(
  z.object({
    queue_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    remediation_proposal_id: z.string().uuid(),
    patch_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    attempt_count: z.number().int().min(0).max(5),
  }),
);

export const dispatchRemediationValidationTask = schedules.task({
  id: "dispatch-remediation-validation",
  cron: { pattern: "*/2 * * * *", window: "2m" },
  run: async () => {
    const client = createSupabaseServerClient();
    const { data, error } = await client.rpc("list_remediation_validation_queue", {
      p_limit: 20,
    });
    if (error) throw new Error("remediation_validation_queue_read_failed");
    const items = batchSchema.parse(data ?? []);
    let dispatched = 0;
    for (const item of items) {
      const { data: attempt, error: claimError } = await client.rpc(
        "claim_remediation_validation_dispatch",
        { p_queue_id: item.queue_id },
      );
      if (claimError || typeof attempt !== "number" || attempt <= 0) continue;
      try {
        const handle = await tasks.trigger<typeof validateRemediationTask>(
          "validate-remediation",
          {
            queueId: item.queue_id,
            workspaceId: item.workspace_id,
            proposalId: item.remediation_proposal_id,
            patchFingerprint: item.patch_fingerprint,
            attempt,
          },
          { idempotencyKey: `remediation-validation:${item.queue_id}:${attempt}` },
        );
        const { data: marked, error: markError } = await client.rpc(
          "mark_remediation_validation_dispatched",
          {
            p_queue_id: item.queue_id,
            p_attempt: attempt,
            p_trigger_run_id: handle.id,
          },
        );
        if (markError || marked !== true) {
          throw new Error("remediation_validation_dispatch_mark_failed");
        }
        if (await isM15LocalAcceptanceDuplicateTarget(item.queue_id)) {
          await new Promise((resolve) => setTimeout(resolve, 10_000));
          await tasks.trigger<typeof validateRemediationTask>(
            "validate-remediation",
            {
              queueId: item.queue_id,
              workspaceId: item.workspace_id,
              proposalId: item.remediation_proposal_id,
              patchFingerprint: item.patch_fingerprint,
              attempt,
            },
            { idempotencyKey: `remediation-validation:${item.queue_id}:${attempt}:m15-duplicate` },
          );
        }
        dispatched++;
      } catch {
        // Leave the durable row for stale-dispatch reconciliation without logging payloads.
      }
    }
    return { dispatched };
  },
});
