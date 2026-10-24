import type { ExposureState } from "./contracts";
import { assessExposure, evaluateDeploymentExposure, type ExposureAssessment } from "./evaluate";

export const EXPOSURE_CONTRACT_VERSION = "exposure-v1" as const;

/** The rows one exposure assessment rests on: one graph build on one linked surface. */
export type ExposureEvidence = {
  graph: {
    id: string;
    repositoryId: string;
    status: "queued" | "building" | "completed" | "failed";
    assessmentState: "evidence_present" | "absence_observed" | "unknown_incomplete" | "failed";
    analysisProfile: string;
    coverageState: "complete" | "partial" | "unsupported" | "failed";
    commitSha: string;
  };
  surfaceId: string;
  /** The latest evidence row for the Product and surface (by `observed_at`, then `id`). */
  evidence: {
    id: string;
    repositoryId: string;
    verificationState:
      "mapped" | "commit_verified" | "production_verified" | "inconclusive" | "historical";
    verifiedCommitSha: string | null;
  } | null;
  /** The latest finished sync of the surface (by `completed_at`, then `id`). */
  lastSync: { id: string; status: "succeeded" | "failed"; completedAt: string } | null;
};

export type SurfaceExposure = ExposureAssessment & {
  /** The evidence actually used: none when it describes another repository. */
  evidenceId: string | null;
  syncAttemptId: string | null;
  /** A definite state lasts as long as the sync it rests on is fresh. */
  validUntil: string | null;
};

/**
 * Production exposure of one graph build on one surface, with the same rule the issuing RPC
 * recomputes (`private.impact_exposure_outcome`). An unfinished graph build is never evidence,
 * and evidence about another repository is treated as absent.
 */
export function exposureForSurface(input: ExposureEvidence, now: Date): SurfaceExposure {
  const evidence =
    input.evidence && input.evidence.repositoryId === input.graph.repositoryId
      ? input.evidence
      : null;
  const deployment = evaluateDeploymentExposure({
    surfaceId: input.surfaceId,
    evidence: evidence && {
      evidenceId: evidence.id,
      verificationState: evidence.verificationState,
      verifiedCommitSha: evidence.verifiedCommitSha,
    },
    lastSync: input.lastSync && {
      status: input.lastSync.status,
      completedAt: input.lastSync.completedAt,
    },
    now,
  });
  const assessment = assessExposure({
    graph: {
      assessmentState:
        input.graph.status === "completed" ? input.graph.assessmentState : "unknown_incomplete",
      analysisCommitSha: input.graph.commitSha,
      analysisProfile: input.graph.analysisProfile,
      analysisCoverageState: input.graph.coverageState,
    },
    deployment,
  });
  const definite = assessment.state !== "unknown";
  return {
    ...assessment,
    evidenceId: evidence?.id ?? null,
    syncAttemptId: input.lastSync?.id ?? null,
    validUntil: definite ? (deployment.expiresAt ?? null) : null,
  };
}

/** The exposure a stored assessment supports at a given time; an expired one is `unknown`. */
export function exposureAt(
  assessment: { exposureState: ExposureState; validUntil: string | null },
  asOf: Date,
): ExposureState {
  if (assessment.exposureState === "unknown") return "unknown";
  if (!assessment.validUntil || Date.parse(assessment.validUntil) <= asOf.getTime())
    return "unknown";
  return assessment.exposureState;
}

/** Arguments for `issue_impact_exposure_assessment`. */
export function exposureIssueArguments(input: {
  workspaceId: string;
  graphBuildId: string;
  surfaceId: string;
  exposure: SurfaceExposure;
}) {
  return {
    p_workspace_id: input.workspaceId,
    p_graph_build_id: input.graphBuildId,
    p_deployment_surface_id: input.surfaceId,
    p_product_deployment_evidence_id: input.exposure.evidenceId,
    p_deployment_sync_attempt_id: input.exposure.syncAttemptId,
    p_exposure_state: input.exposure.state,
    p_reason: input.exposure.reason,
  };
}
