import "server-only";
import { tasks } from "@trigger.dev/sdk";
import type { routeSourceChangeIntelligenceTask } from "@/trigger/route-source-change-intelligence";

export async function enqueueIntelligenceRoute(sourceChangeId: string) {
  try {
    return await tasks.trigger<typeof routeSourceChangeIntelligenceTask>(
      "route-source-change-intelligence",
      { sourceChangeId },
      { idempotencyKey: `intelligence-router-v1:${sourceChangeId}` },
    );
  } catch {
    throw new Error("intelligence_router_enqueue_failed");
  }
}
