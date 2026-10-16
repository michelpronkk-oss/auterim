import "server-only";
import type { ClassificationChange } from "@/lib/monitoring/classification";
import {
  applyIntelligencePolicy,
  INTELLIGENCE_POLICY_VERSION,
  type PolicyThresholds,
} from "@/lib/intelligence/policy";
import { buildIntelligenceEvidence } from "@/lib/intelligence/evidence";
import {
  ACTIVE_ROUTING_READINESS,
  ACTIVE_THRESHOLD_VERSION,
  CALIBRATION_CORPUS_VERSION,
  CALIBRATED_ACTIVE_THRESHOLDS,
  CALIBRATION_FIXTURE_COUNT,
  CALIBRATION_HOLDOUT_METRICS,
  CALIBRATION_VERSION,
  INTELLIGENCE_ACTIVE_POLICY_VERSION,
  activeCalibrationIsReady,
  activeThresholdFingerprint,
} from "@/lib/intelligence/calibration";
import { enqueueIntelligenceRoute } from "@/lib/intelligence/router-queue";
import {
  requestJevDecision,
  JevDecisionError,
  JEV_ENGINE_VERSION,
  JEV_MODEL,
  JEV_PROVIDER,
} from "@/lib/intelligence/jev";
import type { IntelligenceRoute, ProposedPolicyState } from "@/lib/intelligence/taxonomy";
import {
  SupabaseChangeIntelligenceRepository,
  type ChangeIntelligenceRepository,
} from "@/lib/intelligence/repository";

// Until the Reliability Lab has enough labeled evidence, all ambiguous outcomes escalate.
// This policy is intentionally shadow-only and its thresholds are versioned with the lab report.
export const INITIAL_SHADOW_THRESHOLDS: PolicyThresholds = {
  material: 1,
  criticalChange: 1,
  evidenceSufficient: 1,
  docsNoise: 1,
  requiresEscalation: 1,
  routeConfidence: 1,
  calibrationFixtureCount: 0,
  calibrationVersion: "uncalibrated-conservative-v1",
};

export function evaluateWithReadinessGate(input: {
  classifier: Awaited<ReturnType<ChangeIntelligenceRepository["getClassifierSummary"]>>;
  judgment: Parameters<typeof applyIntelligencePolicy>[0]["judgment"];
  evidenceQuality: ReturnType<typeof buildIntelligenceEvidence>["quality"];
  thresholds: PolicyThresholds;
  activeReady: boolean;
}) {
  if (!input.activeReady) {
    const criticalIncomplete =
      input.evidenceQuality.sourceCriticality === "critical" && input.evidenceQuality.incomplete;
    return {
      route: input.judgment.route,
      state: criticalIncomplete ? ("insufficient_evidence" as const) : ("escalate" as const),
      reviewDisposition: "review_required" as const,
      reviewReason: criticalIncomplete
        ? ("evidence_incomplete" as const)
        : ("policy_review" as const),
      reason: criticalIncomplete
        ? ("critical_evidence_incomplete" as const)
        : ("model_uncertain" as const),
    };
  }
  return applyIntelligencePolicy({
    classifier: input.classifier,
    judgment: input.judgment,
    evidenceQuality: input.evidenceQuality,
    thresholds: input.thresholds,
  });
}

export async function evaluateSourceChangeIntelligence(
  input: {
    sourceChangeId: string;
    triggerRunId: string;
    attemptNumber: number;
  },
  dependencies: {
    repository?: ChangeIntelligenceRepository;
    evaluator?: typeof requestJevDecision;
    mode?: "active" | "shadow";
    enqueueRoute?: (sourceChangeId: string) => Promise<unknown>;
  } = {},
) {
  const repository = dependencies.repository ?? new SupabaseChangeIntelligenceRepository();
  const enqueueRoute = dependencies.enqueueRoute ?? enqueueIntelligenceRoute;
  const start = await repository.begin(input);
  if (start.status === "completed") {
    await enqueueRoute(input.sourceChangeId);
    return start;
  }
  if (start.status !== "processing") return start;
  const change = start.change as ClassificationChange;
  const evidence = buildIntelligenceEvidence(change);
  let completed: {
    status: "completed";
    sourceChangeId: string;
    route: IntelligenceRoute;
    proposedState: ProposedPolicyState;
  };
  try {
    const judgment = await (dependencies.evaluator ?? requestJevDecision)(evidence);
    let classifier = null;
    try {
      classifier = await repository.getClassifierSummary(input.sourceChangeId);
    } catch {
      /* JEV remains independent from classifier availability. */
    }
    const mode = dependencies.mode ?? "active";
    const thresholds = mode === "shadow" ? INITIAL_SHADOW_THRESHOLDS : CALIBRATED_ACTIVE_THRESHOLDS;
    const calibrationReady = mode === "shadow" || activeCalibrationIsReady();
    const policy = evaluateWithReadinessGate({
      classifier,
      judgment,
      evidenceQuality: evidence.quality,
      thresholds,
      activeReady: calibrationReady,
    });
    const policyIdentity = {
      mode: mode === "shadow" ? "shadow" : calibrationReady ? "active_calibrated" : "fail_closed",
      policyVersion:
        mode === "shadow" ? INTELLIGENCE_POLICY_VERSION : INTELLIGENCE_ACTIVE_POLICY_VERSION,
      thresholdVersion:
        mode === "shadow" ? "uncalibrated-conservative-v1" : ACTIVE_THRESHOLD_VERSION,
      calibrationCorpusVersion: mode === "shadow" ? "none" : CALIBRATION_CORPUS_VERSION,
      calibrationVersion:
        mode === "shadow" ? INITIAL_SHADOW_THRESHOLDS.calibrationVersion : CALIBRATION_VERSION,
      calibrationFixtureCount: mode === "shadow" ? 0 : CALIBRATION_FIXTURE_COUNT,
      thresholdFingerprint: mode === "shadow" ? null : activeThresholdFingerprint(),
      thresholds,
      readiness: mode === "shadow" ? { shadowOnly: true } : ACTIVE_ROUTING_READINESS,
      holdoutMetrics: mode === "shadow" ? null : CALIBRATION_HOLDOUT_METRICS,
    } as const;
    await repository.record({
      sourceChangeId: input.sourceChangeId,
      evidenceFingerprint: start.evidenceFingerprint,
      triggerRunId: input.triggerRunId,
      attemptNumber: input.attemptNumber,
      judgment,
      quality: evidence.quality,
      policy,
      policyIdentity,
    });
    completed = {
      status: "completed" as const,
      sourceChangeId: input.sourceChangeId,
      route: policy.route,
      proposedState: policy.state,
    };
  } catch (error) {
    const category =
      error instanceof JevDecisionError ? error.category : "intelligence_processing_error";
    await repository.fail({
      sourceChangeId: input.sourceChangeId,
      evidenceFingerprint: start.evidenceFingerprint,
      triggerRunId: input.triggerRunId,
      attemptNumber: input.attemptNumber,
      category,
    });
    throw error;
  }
  // A dispatch failure must leave the immutable completed decision intact.
  // Trigger retry replays begin() and re-enqueues this idempotent router task.
  await enqueueRoute(input.sourceChangeId);
  return completed;
}

export const intelligenceEngineIdentity = {
  engineVersion: JEV_ENGINE_VERSION,
  policyVersion: INTELLIGENCE_POLICY_VERSION,
  provider: JEV_PROVIDER,
  model: JEV_MODEL,
} as const;
