import { schedules, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { FixStageSchema } from "@/lib/fix-engine/contracts";

const pendingStageSchema = z
  .object({
    fix_run_id: z.string().uuid(),
    stage: FixStageSchema,
    attempt_count: z.number().int().min(0).max(3),
    idempotency_key: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** Recovers queued stages and expired leases after a worker/process interruption. */
export const dispatchFixEngineStagesTask = schedules.task({
  id: "dispatch-fix-engine-stages",
  cron: { pattern: "*/1 * * * *", timezone: "UTC" },
  maxDuration: 60,
  queue: { concurrencyLimit: 1 },
  run: async () => {
    const { data, error } = await createSupabaseServerClient().rpc("list_fix_stage_work", {
      p_limit: 50,
    });
    if (error || !Array.isArray(data)) throw new Error("fix_stage_recovery_read_failed");

    let dispatched = 0;
    for (const raw of data) {
      const stage = pendingStageSchema.safeParse(raw);
      if (!stage.success) throw new Error("fix_stage_recovery_identity_invalid");
      const {
        fix_run_id: fixRunId,
        stage: name,
        attempt_count: attemptCount,
        idempotency_key: key,
      } = stage.data;
      await tasks.trigger(
        "process-fix-engine-stage",
        { fixRunId, stage: name },
        {
          // A new queue claim generation gets a new delivery identity. Repeated
          // dispatcher executions for the same generation collapse safely.
          idempotencyKey: `fix-engine:recovery:${key}:${attemptCount}`,
          idempotencyKeyTTL: "7d",
        },
      );
      dispatched += 1;
    }
    return { scanned: data.length, dispatched };
  },
});
