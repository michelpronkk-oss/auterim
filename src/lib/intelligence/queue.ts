import "server-only";
import { tasks } from "@trigger.dev/sdk";
import type { evaluateSourceChangeIntelligenceTask } from "@/trigger/evaluate-source-change-intelligence";

export async function enqueueSourceChangeIntelligence(sourceChangeId: string) {
  return tasks.trigger<typeof evaluateSourceChangeIntelligenceTask>(
    "evaluate-source-change-intelligence",
    { sourceChangeId },
  );
}
