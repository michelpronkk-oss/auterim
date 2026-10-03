import { schemaTask, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import {
  listCustomerImpactQueueItems,
  markCustomerImpactQueueDispatched,
} from "@/lib/impact/impact-repository";
import { dispatchCustomerImpactQueueBatch } from "@/lib/impact/impact-dispatch";
import type { assessCustomerImpactTask } from "@/trigger/assess-customer-impact";

export const dispatchCustomerImpactTask = schemaTask({
  id: "dispatch-customer-impact",
  schema: z.object({ sourceChangeId: z.string().uuid().optional() }),
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
    randomize: true,
  },
  concurrency: { total: 1 },
  run: async ({ sourceChangeId }) => {
    const result = await dispatchCustomerImpactQueueBatch({
      sourceChangeId,
      maxDispatches: 500,
      list: listCustomerImpactQueueItems,
      markDispatched: markCustomerImpactQueueDispatched,
      triggerAssessment: (item) =>
        tasks.trigger<typeof assessCustomerImpactTask>("assess-customer-impact", {
          queueId: item.queue_id,
          workspaceDependencyId: item.workspace_dependency_id,
          sourceChangeClassificationId: item.source_change_classification_id,
        }),
      triggerContinuation: () =>
        tasks.trigger<typeof dispatchCustomerImpactTask>("dispatch-customer-impact", {
          ...(sourceChangeId ? { sourceChangeId } : {}),
        }),
    });
    return {
      dispatched: result.dispatched,
      changeScoped: sourceChangeId !== undefined,
      mayHaveMore: result.mayHaveMore,
    };
  },
});
