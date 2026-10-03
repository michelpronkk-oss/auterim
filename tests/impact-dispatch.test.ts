import { describe, expect, it, vi } from "vitest";
import { dispatchCustomerImpactQueueBatch } from "@/lib/impact/impact-dispatch";

describe("customer impact queue fan-out", () => {
  it("starts a continuation after dispatching the bounded batch", async () => {
    const queue = Array.from({ length: 501 }, (_, index) => ({
      queue_id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      workspace_dependency_id: `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      source_change_classification_id: "20000000-0000-4000-8000-000000000001",
      context_revision: 1,
    }));
    const dispatched = new Set<string>();
    const triggered: string[] = [];
    const continuation = vi.fn(async () => undefined);
    const triggerAssessment = vi.fn(async (item: (typeof queue)[number]) => {
      triggered.push(item.queue_id);
    });
    const result = await dispatchCustomerImpactQueueBatch({
      sourceChangeId: "30000000-0000-4000-8000-000000000001",
      maxDispatches: 500,
      list: async () => queue.filter((item) => !dispatched.has(item.queue_id)).slice(0, 100),
      markDispatched: async (queueId) => {
        dispatched.add(queueId);
      },
      triggerAssessment,
      triggerContinuation: continuation,
    });

    expect(result).toEqual({ dispatched: 500, mayHaveMore: true });
    expect(triggerAssessment).toHaveBeenCalledTimes(500);
    expect(triggered).toHaveLength(500);
    expect(dispatched).toHaveLength(500);
    expect(continuation).toHaveBeenCalledOnce();
  });
});
