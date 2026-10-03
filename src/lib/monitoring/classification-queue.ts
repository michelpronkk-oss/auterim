import "server-only";
import { tasks } from "@trigger.dev/sdk";
import type { semanticClassifyChangeTask } from "@/trigger/classify-source-change";

export async function enqueueSemanticClassification(sourceChangeId: string) {
  return tasks.trigger<typeof semanticClassifyChangeTask>("classify-source-change", {
    sourceChangeId,
  });
}
