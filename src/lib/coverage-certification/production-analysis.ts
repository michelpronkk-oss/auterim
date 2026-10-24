import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { exposureForSurface, exposureIssueArguments, type ExposureEvidence } from "./exposure";

// No request, environment variable or task payload can enable issuance in Step 4b.
export const PRODUCTION_EXPOSURE_ISSUANCE_ENABLED = false;
export const productionAnalysisRequest = z
  .object({
    workspaceId: z.string().uuid(),
    productId: z.string().uuid(),
    repositoryId: z.string().uuid(),
    surfaceId: z.string().uuid(),
    seedGraphBuildId: z.string().uuid(),
  })
  .strict();
export type ProductionAnalysisRequest = z.infer<typeof productionAnalysisRequest>;

export type ProductionBinding = ProductionAnalysisRequest & {
  routeIntentId: string;
  deploymentId: string;
  commitSha: string;
  observationId: string;
  evidenceId: string;
  syncAttemptId: string;
  syncCompletedAt: string;
  observedAt: string;
};
export type ProductionGraph = ExposureEvidence["graph"] & {
  workspaceId: string;
  productId: string;
  routeIntentId: string;
};
export type ProductionAnalysisDependencies = {
  /** Authorize all scope relationships, then read the live provider and stored current rows. */
  readBinding(request: ProductionAnalysisRequest): Promise<ProductionBinding | null>;
  analyze(binding: ProductionBinding, key: string): Promise<string>;
  buildGraph(
    binding: ProductionBinding,
    analysisRunId: string,
    key: string,
  ): Promise<ProductionGraph>;
  now(): Date;
};

export function productionAnalysisKey(binding: ProductionBinding) {
  // Repository analysis itself is reused by exact commit; orchestration additionally binds
  // tenant, Product, source-change route, surface and provider deployment (including rollbacks).
  return `production-exposure-v1:${createHash("sha256")
    .update(
      JSON.stringify([
        binding.workspaceId,
        binding.productId,
        binding.repositoryId,
        binding.surfaceId,
        binding.routeIntentId,
        binding.deploymentId,
        binding.commitSha,
      ]),
    )
    .digest("hex")}`;
}

function validBinding(request: ProductionAnalysisRequest, binding: ProductionBinding, now: Date) {
  const observed = Date.parse(binding.observedAt);
  const completed = Date.parse(binding.syncCompletedAt);
  return (
    Object.entries(request).every(
      ([key, value]) => binding[key as keyof ProductionAnalysisRequest] === value,
    ) &&
    /^[a-f0-9]{40,64}$/.test(binding.commitSha) &&
    [binding.routeIntentId, binding.observationId, binding.evidenceId, binding.syncAttemptId].every(
      (id) => z.string().uuid().safeParse(id).success,
    ) &&
    binding.deploymentId.length > 0 &&
    binding.deploymentId.length <= 200 &&
    Number.isFinite(observed) &&
    observed <= now.getTime() &&
    now.getTime() - observed <= 120_000 &&
    Number.isFinite(completed) &&
    completed <= now.getTime() &&
    now.getTime() - completed < 86_400_000
  );
}

/**
 * One bounded attempt, one exact deployed commit, no fan-out or internal retry. The task
 * adapter supplies bounded durable retries; each attempt must resolve Production afresh.
 * Returned results are internal previews, never durable/customer-visible protection claims.
 */
export async function analyzeCurrentProduction(
  value: unknown,
  dependencies: ProductionAnalysisDependencies,
) {
  const request = productionAnalysisRequest.parse(value);
  const started = dependencies.now().getTime();
  const unknown = (reason: "deployment_not_production_verified" | "graph_evidence_incomplete") => ({
    status: "unknown" as const,
    state: "unknown" as const,
    reason,
    issuanceEnabled: false as const,
  });
  const initial = await dependencies.readBinding(request);
  if (!initial || !validBinding(request, initial, dependencies.now()))
    return unknown("deployment_not_production_verified");
  const key = productionAnalysisKey(initial);
  const analysisRunId = await dependencies.analyze(initial, key);
  const graph = await dependencies.buildGraph(initial, analysisRunId, key);
  if (
    graph.workspaceId !== request.workspaceId ||
    graph.productId !== request.productId ||
    graph.repositoryId !== request.repositoryId ||
    graph.routeIntentId !== initial.routeIntentId ||
    graph.commitSha !== initial.commitSha ||
    !z.string().uuid().safeParse(graph.id).success
  )
    throw new Error("production_analysis_graph_identity_mismatch");
  // Re-authorize after analysis, including mapping/connection revocation. A newer sync,
  // alias move, same-SHA redeploy or evidence replacement invalidates this attempt.
  const final = await dependencies.readBinding(request);
  if (
    !final ||
    !validBinding(request, final, dependencies.now()) ||
    Object.keys(initial).some(
      (field) =>
        field !== "observedAt" &&
        initial[field as keyof ProductionBinding] !== final[field as keyof ProductionBinding],
    )
  )
    return unknown("deployment_not_production_verified");
  const elapsed = dependencies.now().getTime() - started;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 600_000)
    return unknown("graph_evidence_incomplete");
  const exposure = exposureForSurface(
    {
      graph,
      surfaceId: request.surfaceId,
      evidence: {
        id: final.evidenceId,
        repositoryId: request.repositoryId,
        verificationState: "production_verified",
        verifiedCommitSha: final.commitSha,
      },
      lastSync: {
        id: final.syncAttemptId,
        status: "succeeded",
        completedAt: final.syncCompletedAt,
      },
    },
    dependencies.now(),
  );
  return {
    status: "preview" as const,
    ...exposure,
    key,
    binding: final,
    graphBuildId: graph.id,
    analysisRunId,
    issuanceEnabled: false as const,
    // Future persistence must use this Step 4a contract and revalidate at issuance time.
    issueArguments: exposureIssueArguments({
      workspaceId: request.workspaceId,
      graphBuildId: graph.id,
      surfaceId: request.surfaceId,
      exposure,
    }),
  };
}
