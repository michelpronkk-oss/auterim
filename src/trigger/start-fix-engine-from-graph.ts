import { schemaTask, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { createPersistedFixRun } from "@/lib/fix-engine/stage-runtime";

export const startFixEngineFromGraphTask = schemaTask({
  id: "start-fix-engine-from-graph",
  schema: z.object({ graphBuildId: z.string().uuid() }).strict(),
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 15_000,
    factor: 2,
    randomize: true,
  },
  maxDuration: 60,
  queue: { concurrencyLimit: 2 },
  run: async ({ graphBuildId }) => {
    const fix = await createPersistedFixRun(graphBuildId);
    await tasks.trigger(
      "process-fix-engine-stage",
      { fixRunId: fix.fixRunId, stage: "diagnose" },
      {
        idempotencyKey: `fix-engine:${fix.idempotencyKey}:diagnose`,
        idempotencyKeyTTL: "30d",
      },
    );
    return { fixRunId: fix.fixRunId, replayed: fix.replayed };
  },
});
