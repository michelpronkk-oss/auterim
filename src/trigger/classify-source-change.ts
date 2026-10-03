import { AbortTaskRunError, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import {
  ClassifierConfigurationError,
  classifySourceChange,
} from "@/lib/monitoring/classification";

export const semanticClassifyChangeTask = schemaTask({
  id: "classify-source-change",
  schema: z.object({ sourceChangeId: z.string().uuid() }),
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
    randomize: true,
  },
  concurrency: { total: 4 },
  run: async ({ sourceChangeId }, { ctx }) => {
    try {
      return await classifySourceChange({
        changeId: sourceChangeId,
        triggerRunId: ctx.run.id,
        attemptNumber: ctx.attempt.number,
      });
    } catch (error) {
      if (error instanceof ClassifierConfigurationError) {
        throw new AbortTaskRunError(error.message);
      }
      throw error;
    }
  },
});
