import { schemaTask, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { getEnvironment } from "@/lib/env/schema";
import { SupabaseIntelligenceRouterRepository } from "@/lib/intelligence/router-repository";
import type { escalateSourceChangeEvidenceTask } from "@/trigger/escalate-source-change-evidence";

export const routeSourceChangeIntelligenceTask = schemaTask({
  id: "route-source-change-intelligence",
  schema: z.object({ sourceChangeId: z.string().uuid() }),
  retry: {
    maxAttempts: 6,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
    randomize: true,
  },
  concurrency: { total: 4 },
  run: async ({ sourceChangeId }) => {
    if (getEnvironment().AUTERIM_INTELLIGENCE_ROUTER_ENABLED !== "1") {
      return { sourceChangeId, status: "disabled", dispatched: false };
    }
    const repository = new SupabaseIntelligenceRouterRepository();
    const intent = await repository.persistRouteIntent(sourceChangeId);
    if (
      intent.routeTarget !== "evidence_escalation" ||
      intent.routeStatus === "suppressed" ||
      intent.routeStatus === "pending" ||
      intent.routeStatus === "completed" ||
      intent.routeStatus === "failed"
    ) {
      return {
        routeIntentId: intent.id,
        route: intent.route,
        policyState: intent.policyState,
        routeTarget: intent.routeTarget,
        status: intent.routeStatus,
        dispatched: false,
      };
    }
    const claim = await repository.claimRouteDispatch(intent.id);
    if (claim.status === "dispatching") throw new Error("intelligence_route_dispatch_claim_busy");
    if (claim.status !== "claimed") {
      return {
        routeIntentId: intent.id,
        route: intent.route,
        routeTarget: intent.routeTarget,
        status: claim.status,
        dispatched: false,
      };
    }
    try {
      const run = await tasks.trigger<typeof escalateSourceChangeEvidenceTask>(
        "escalate-source-change-evidence",
        { routeIntentId: intent.id },
        { idempotencyKey: claim.idempotencyKey },
      );
      await repository.markRouteDispatched(intent.id, claim.claimToken, run.id);
      return {
        routeIntentId: intent.id,
        route: intent.route,
        routeTarget: intent.routeTarget,
        status: "dispatched",
        dispatched: true,
      };
    } catch {
      await repository.releaseRouteDispatch(
        intent.id,
        claim.claimToken,
        "downstream_enqueue_failed",
      );
      throw new Error("intelligence_route_dispatch_failed");
    }
  },
});
