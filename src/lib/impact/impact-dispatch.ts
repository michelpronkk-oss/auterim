export type CustomerImpactQueueItem = {
  queue_id: string;
  workspace_dependency_id: string;
  source_change_classification_id: string;
  context_revision: number;
};

export async function dispatchCustomerImpactQueueBatch(input: {
  sourceChangeId?: string;
  maxDispatches: number;
  list: (sourceChangeId?: string) => Promise<CustomerImpactQueueItem[]>;
  markDispatched: (queueId: string) => Promise<void>;
  triggerAssessment: (item: CustomerImpactQueueItem) => Promise<unknown>;
  triggerContinuation: () => Promise<unknown>;
}) {
  let dispatched = 0;
  while (dispatched < input.maxDispatches) {
    const queueItems = await input.list(input.sourceChangeId);
    if (queueItems.length === 0) break;
    for (const item of queueItems.slice(0, input.maxDispatches - dispatched)) {
      await input.markDispatched(item.queue_id);
      await input.triggerAssessment(item);
      dispatched++;
    }
  }
  const mayHaveMore = dispatched === input.maxDispatches;
  if (mayHaveMore) await input.triggerContinuation();
  return { dispatched, mayHaveMore };
}
