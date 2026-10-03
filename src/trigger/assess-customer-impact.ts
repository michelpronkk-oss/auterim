import { AbortTaskRunError, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { ImpactConfigurationError, assessCustomerImpact } from "@/lib/impact/impact";
import {
  markCustomerImpactQueueComplete,
  markCustomerImpactQueueFailed,
} from "@/lib/impact/impact-repository";

export const assessCustomerImpactTask = schemaTask({
  id: "assess-customer-impact",
  schema: z.object({
    queueId: z.string().uuid(),
    workspaceDependencyId: z.string().uuid(),
    sourceChangeClassificationId: z.string().uuid(),
  }),
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
    randomize: true,
  },
  concurrency: { total: 4 },
  run: async ({ queueId, workspaceDependencyId, sourceChangeClassificationId }, { ctx }) => {
    try {
      const result = await assessCustomerImpact({
        workspaceDependencyId,
        sourceChangeClassificationId,
        triggerRunId: ctx.run.id,
        attemptNumber: ctx.attempt.number,
      });
      if (result.status === "assessed") await markCustomerImpactQueueComplete(queueId);
      return result;
    } catch (error) {
      if (error instanceof ImpactConfigurationError || ctx.attempt.number >= 3) {
        await markCustomerImpactQueueFailed(
          queueId,
          error instanceof ImpactConfigurationError ? error.category : "impact_task_failed",
        );
      }
      if (error instanceof ImpactConfigurationError) throw new AbortTaskRunError(error.message);
      throw error;
    }
  },
});
