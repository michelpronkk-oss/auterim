import { schemaTask, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { FixStageSchema } from "@/lib/fix-engine/contracts";
import { processFixEngineStage } from "@/lib/fix-engine/stage-processor";
import { runPersistedFixStage } from "@/lib/fix-engine/stage-runtime";

export const processFixEngineStageTask = schemaTask({
  id: "process-fix-engine-stage",
  schema: z.object({ fixRunId: z.string().uuid(), stage: FixStageSchema }).strict(),
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
    randomize: true,
  },
  maxDuration: 300,
  queue: { concurrencyLimit: 2 },
  run: async ({ fixRunId, stage }) => {
    const result = await runPersistedFixStage({
      fixRunId,
      stage,
      processor: processFixEngineStage,
    });
    if (result.status === "stale_scope") return { status: result.status };
    if (result.status === "busy") return { status: result.status };
    if (result.nextStage) {
      await tasks.trigger(
        "process-fix-engine-stage",
        { fixRunId, stage: result.nextStage },
        {
          idempotencyKey: `fix-engine:${fixRunId}:${result.nextStage}`,
          idempotencyKeyTTL: "30d",
        },
      );
    }
    return { status: result.status, nextStage: result.nextStage };
  },
});
