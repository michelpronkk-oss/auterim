import {
  ProductProtectionReadError,
  productProtectionReadStage,
} from "@/lib/protection/read-stage";

type CompletionAttempt = {
  id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
};

type M157AcceptanceCompletionInput = {
  currentSha: string;
  currentDeploymentId: string;
  baseline: {
    id: string;
    commitSha: string;
    verificationState: string;
    observedAt: string;
    preflightRunId: string;
  };
  baselineRun: { id: string; mode: string; status: string };
  surface: {
    id: string;
    currentProductionDeploymentId: string | null;
    lastAttemptStatus: string | null;
  };
  mapping: { id: string; repositoryId: string; provenance: string };
  repositoryId: string;
  observation: {
    id: string;
    deploymentId: string;
    environment: string;
    state: string;
    commitSha: string | null;
    repositoryOwner: string | null;
    repositoryName: string | null;
  };
  evidence: {
    id: string;
    baselineEvidenceId: string | null;
    preflightFindingId: string | null;
    verificationState: string;
    verifiedCommitSha: string | null;
    exactCommitMatch: boolean;
    deploymentObservationId: string;
    repositoryId: string;
  };
  attempts: CompletionAttempt[];
  expectedRepositoryOwner: string;
  expectedRepositoryName: string;
};

/** Keep raw provider/database exceptions private while naming the failed stage. */
export async function withM157AcceptanceStage<T>(
  stage: string,
  operation: () => PromiseLike<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && /^m157_acceptance_[a-z0-9_]+$/.test(error.message)) throw error;
    if (error instanceof ProductProtectionReadError) {
      const graphStage = stage.replace(/_unavailable$/, "");
      throw new Error(`m157_acceptance_${graphStage}_${productProtectionReadStage(error)}`);
    }
    throw new Error(`m157_acceptance_${stage}`);
  }
}

function validTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * A current deployment verification is only a partial acceptance. Completion
 * requires coherent current evidence plus the two successful syncs that prove
 * the idempotency phase ran after the same baseline was established.
 */
export function isM157AcceptanceComplete(input: M157AcceptanceCompletionInput): boolean {
  const shaPattern = /^[a-f0-9]{40}$/i;
  const currentSha = input.currentSha.toLowerCase();
  if (!shaPattern.test(currentSha) || !shaPattern.test(input.baseline.commitSha)) return false;

  const baselineTime = validTimestamp(input.baseline.observedAt);
  if (baselineTime === null) return false;

  const attempts = [...input.attempts].sort((left, right) => {
    const byStart = Date.parse(right.started_at) - Date.parse(left.started_at);
    return byStart || right.id.localeCompare(left.id);
  });
  const latest = attempts[0];
  const previous = attempts[1];
  const latestStart = validTimestamp(latest?.started_at);
  const previousStart = validTimestamp(previous?.started_at);
  const previousCompleted = validTimestamp(previous?.completed_at);
  const latestCompleted = validTimestamp(latest?.completed_at);

  if (
    !latest ||
    !previous ||
    latest.id === previous.id ||
    latest.status !== "succeeded" ||
    previous.status !== "succeeded" ||
    latestStart === null ||
    previousStart === null ||
    previousCompleted === null ||
    latestCompleted === null ||
    previousStart < baselineTime ||
    latestStart <= previousCompleted ||
    latestCompleted < latestStart ||
    previousCompleted < previousStart
  )
    return false;

  return (
    input.baseline.verificationState === "verified" &&
    input.baseline.commitSha.toLowerCase() === currentSha &&
    input.baselineRun.id === input.baseline.preflightRunId &&
    input.baselineRun.mode === "baseline" &&
    input.baselineRun.status === "completed" &&
    input.surface.id.length > 0 &&
    input.surface.currentProductionDeploymentId === input.currentDeploymentId &&
    input.surface.lastAttemptStatus === "succeeded" &&
    input.mapping.id.length > 0 &&
    input.mapping.repositoryId === input.repositoryId &&
    input.mapping.provenance === "protected_repository_identity" &&
    input.observation.id.length > 0 &&
    input.observation.deploymentId === input.currentDeploymentId &&
    input.observation.environment === "production" &&
    input.observation.state === "ready" &&
    input.observation.commitSha?.toLowerCase() === currentSha &&
    input.observation.repositoryOwner?.toLowerCase() === input.expectedRepositoryOwner &&
    input.observation.repositoryName?.toLowerCase() === input.expectedRepositoryName &&
    input.evidence.id.length > 0 &&
    input.evidence.baselineEvidenceId === input.baseline.id &&
    input.evidence.preflightFindingId === null &&
    input.evidence.verificationState === "production_verified" &&
    input.evidence.verifiedCommitSha?.toLowerCase() === currentSha &&
    input.evidence.exactCommitMatch &&
    input.evidence.deploymentObservationId === input.observation.id &&
    input.evidence.repositoryId === input.repositoryId
  );
}
