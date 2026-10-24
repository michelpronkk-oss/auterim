import { AbortTaskRunError, idempotencyKeys, schemaTask } from "@trigger.dev/sdk";
import {
  analyzeCurrentProduction,
  productionAnalysisRequest,
} from "@/lib/coverage-certification/production-analysis";
import {
  readProductionBinding,
  readProductionGraph,
} from "@/lib/coverage-certification/production-repository";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { analyzeProtectedRepositoryCodeTask } from "./analyze-protected-repository-code";
import { buildProviderImpactGraphTask } from "./build-provider-impact-graph";

/** Dormant development task: no route, schedule, sync hook or Production caller. */
export const analyzeCurrentProductionExposureTask = schemaTask({
  id: "analyze-current-production-exposure",
  schema: productionAnalysisRequest,
  maxDuration: 600,
  concurrency: { total: 2 },
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
    randomize: true,
  },
  run: async (request, { ctx }) => {
    // Code review + separate deployment/activation approval are required to remove this gate.
    if (ctx.environment.type !== "DEVELOPMENT" || process.env.AUTERIM_M15_LOCAL_INTEGRATION !== "1")
      throw new AbortTaskRunError("production_exposure_analysis_activation_disabled");
    const client = createSupabaseServerClient();
    return analyzeCurrentProduction(request, {
      now: () => new Date(),
      readBinding: (scope) => readProductionBinding(client, scope),
      analyze: async (binding, key) => {
        const result = await analyzeProtectedRepositoryCodeTask.triggerAndWait(
          {
            workspaceId: binding.workspaceId,
            productId: binding.productId,
            repositoryId: binding.repositoryId,
            commitSha: binding.commitSha,
            routeIntentId: binding.routeIntentId,
          },
          {
            idempotencyKey: await idempotencyKeys.create(`${key}:analysis`, { scope: "global" }),
            idempotencyKeyTTL: "1h",
          },
        );
        if (!result.ok || result.output.status !== "completed")
          throw new Error("production_analysis_child_failed");
        return result.output.analysisRunId;
      },
      buildGraph: async (binding, analysisRunId, key) => {
        // The analyzer's normal handoff can already have built this graph. Existing claims
        // and exact-commit uniqueness make this explicit wait safe and replayable.
        const result = await buildProviderImpactGraphTask.triggerAndWait(
          {
            routeIntentId: binding.routeIntentId,
            analysisRunId,
            productId: binding.productId,
            repositoryId: binding.repositoryId,
          },
          {
            idempotencyKey: await idempotencyKeys.create(`${key}:graph:${analysisRunId}`, {
              scope: "global",
            }),
            idempotencyKeyTTL: "1h",
          },
        );
        if (!result.ok) throw new Error("production_analysis_graph_child_failed");
        return readProductionGraph(client, binding, result.output.graphBuildId, analysisRunId);
      },
    });
  },
});
