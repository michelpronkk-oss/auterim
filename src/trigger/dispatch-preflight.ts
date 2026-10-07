import { schedules, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isM15LocalAcceptanceDuplicateTarget } from "@/lib/m15/local-trigger-proof";
import type { runPreflightTask } from "@/trigger/run-preflight";

const queueBatchSchema = z.array(
  z.object({
    queue_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    impact_assessment_id: z.string().uuid(),
    attempt_count: z.number().int().min(0).max(6),
  }),
);

export const dispatchPreflightQueueTask = schedules.task({
  id: "dispatch-preflight-queue",
  cron: { pattern: "*/5 * * * *", window: "5m" },
  run: async () => {
    const client = createSupabaseServerClient();
    const { data, error } = await client.rpc("list_preflight_dispatch_queue", { p_limit: 40 });
    if (error) throw new Error("preflight_queue_list_failed");
    const items = queueBatchSchema.parse(data ?? []);
    let dispatched = 0;
    for (const item of items) {
      const { data: attempt, error: markError } = await client.rpc("mark_preflight_dispatch", {
        p_queue_id: item.queue_id,
        p_status: "dispatched",
      });
      if (markError || typeof attempt !== "number" || attempt <= 0) continue;
      try {
        const handle = await tasks.trigger<typeof runPreflightTask>(
          "run-preflight",
          {
            queueId: item.queue_id,
            workspaceId: item.workspace_id,
            impactAssessmentId: item.impact_assessment_id,
            attempt: Number(attempt),
          },
          { idempotencyKey: `preflight:${item.queue_id}:${attempt}` },
        );
        const { data: identitySaved, error: identityError } = await client.rpc(
          "mark_preflight_dispatch_run",
          {
            p_queue_id: item.queue_id,
            p_attempt: Number(attempt),
            p_trigger_run_id: handle.id,
          },
        );
        if (identityError || identitySaved !== true) {
          throw new Error("preflight_dispatch_identity_persist_failed");
        }
        if (await isM15LocalAcceptanceDuplicateTarget(item.queue_id)) {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          await tasks.trigger<typeof runPreflightTask>(
            "run-preflight",
            {
              queueId: item.queue_id,
              workspaceId: item.workspace_id,
              impactAssessmentId: item.impact_assessment_id,
              attempt: Number(attempt),
            },
            { idempotencyKey: `preflight:${item.queue_id}:${attempt}:m15-duplicate` },
          );
        }
        dispatched++;
      } catch {
        await client.rpc("finish_preflight_dispatch", {
          p_queue_id: item.queue_id,
          p_attempt: Number(attempt),
          p_status: "failed",
          p_error_category: "preflight_dispatch_failed",
        });
      }
    }
    return { dispatched };
  },
});
