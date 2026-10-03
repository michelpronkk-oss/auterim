import { schedules, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { runPreflightTask } from "@/trigger/run-preflight";

const queueBatchSchema = z.array(
  z.object({
    queue_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    impact_assessment_id: z.string().uuid(),
  }),
);

export const dispatchPreflightQueueTask = schedules.task({
  id: "dispatch-preflight-queue",
  cron: "*/5 * * * *",
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
      if (markError || typeof attempt !== "number") continue;
      try {
        await tasks.trigger<typeof runPreflightTask>(
          "run-preflight",
          { queueId: item.queue_id, impactAssessmentId: item.impact_assessment_id },
          { idempotencyKey: `preflight:${item.queue_id}:${attempt}` },
        );
        dispatched++;
      } catch {
        await client.rpc("mark_preflight_dispatch", {
          p_queue_id: item.queue_id,
          p_status: "failed",
          p_error_category: "preflight_dispatch_failed",
        });
      }
    }
    return { dispatched };
  },
});
