import "server-only";
import type { ClassificationChange } from "@/lib/monitoring/classification";
import {
  applyIntelligencePolicy,
  INTELLIGENCE_POLICY_VERSION,
  type PolicyThresholds,
} from "@/lib/intelligence/policy";
import { buildIntelligenceEvidence } from "@/lib/intelligence/evidence";
import {
  requestJevDecision,
  JevDecisionError,
  JEV_ENGINE_VERSION,
  JEV_MODEL,
  JEV_PROVIDER,
} from "@/lib/intelligence/jev";
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

export async function evaluateSourceChangeIntelligence(
  input: {
    sourceChangeId: string;
    triggerRunId: string;
    attemptNumber: number;
  },
  dependencies: {
    repository?: ChangeIntelligenceRepository;
    evaluator?: typeof requestJevDecision;
    thresholds?: PolicyThresholds;
  } = {},
) {
  const repository = dependencies.repository ?? new SupabaseChangeIntelligenceRepository();
  const start = await repository.begin(input);
  if (start.status !== "processing") return start;
  const change = start.change as ClassificationChange;
  const evidence = buildIntelligenceEvidence(change);
  try {
    const judgment = await (dependencies.evaluator ?? requestJevDecision)(evidence);
    let classifier = null;
    try {
      classifier = await repository.getClassifierSummary(input.sourceChangeId);
    } catch {
      /* JEV remains independent from classifier availability. */
    }
    const policy = applyIntelligencePolicy({
      classifier,
      judgment,
      evidenceQuality: evidence.quality,
      thresholds: dependencies.thresholds ?? INITIAL_SHADOW_THRESHOLDS,
    });
    await repository.record({
      sourceChangeId: input.sourceChangeId,
      evidenceFingerprint: start.evidenceFingerprint,
      triggerRunId: input.triggerRunId,
      attemptNumber: input.attemptNumber,
      judgment,
      quality: evidence.quality,
      policy,
    });
    return {
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
}

export const intelligenceEngineIdentity = {
  engineVersion: JEV_ENGINE_VERSION,
  policyVersion: INTELLIGENCE_POLICY_VERSION,
  provider: JEV_PROVIDER,
  model: JEV_MODEL,
} as const;
