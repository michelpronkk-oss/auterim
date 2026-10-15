import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { evaluateSourceChangeIntelligence } from "@/lib/intelligence/decision";

export const evaluateSourceChangeIntelligenceTask = schemaTask({
  id: "evaluate-source-change-intelligence",
  schema: z.object({ sourceChangeId: z.string().uuid() }),
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
    randomize: true,
  },
  concurrency: { total: 4 },
  run: async ({ sourceChangeId }, { ctx }) =>
    evaluateSourceChangeIntelligence({
      sourceChangeId,
      triggerRunId: ctx.run.id,
      attemptNumber: ctx.attempt.number,
    }),
});
