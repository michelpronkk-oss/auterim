import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { scanSource } from "@/lib/monitoring/scan";

export const scanSourceTask = schemaTask({
  id: "scan-source",
  schema: z.object({ sourceId: z.string().uuid() }),
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 10_000,
    factor: 2,
    randomize: true,
  },
  run: async ({ sourceId }, { ctx }) =>
    scanSource({
      sourceId,
      triggerRunId: ctx.run.id,
      attemptNumber: ctx.attempt.number,
    }),
});
