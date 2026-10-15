import type { IntelligenceRoute, SemanticClassifierSummary } from "@/lib/intelligence/taxonomy";

export type LabeledIntelligenceResult = {
  material: boolean;
  route: IntelligenceRoute;
  critical: boolean;
  docsNoise: boolean;
  evidenceSufficient: boolean;
  escalation: boolean;
};

export type EnginePrediction = {
  material: boolean;
  critical: boolean;
  route: IntelligenceRoute;
  evidenceInsufficient: boolean;
  escalation: boolean;
  latencyMs: number | null;
  costUsd: number | null;
};

export type ReliabilityMetrics = {
  labeledCount: number;
  materialFalseNegatives: number;
  materialFalsePositives: number;
  criticalFalseNegatives: number;
  docsNoiseFalsePositives: number;
  routeAccuracy: number | null;
  evidenceInsufficiencyDetection: number | null;
  escalationRecall: number | null;
  meanLatencyMs: number | null;
  costPerThousandUsd: number | null;
};

export function summarizeReliability(
  rows: Array<{ expected: LabeledIntelligenceResult; prediction: EnginePrediction }>,
): ReliabilityMetrics {
  const denominator = rows.length;
  if (!denominator)
    return {
      labeledCount: 0,
      materialFalseNegatives: 0,
      materialFalsePositives: 0,
      criticalFalseNegatives: 0,
      docsNoiseFalsePositives: 0,
      routeAccuracy: null,
      evidenceInsufficiencyDetection: null,
      escalationRecall: null,
      meanLatencyMs: null,
      costPerThousandUsd: null,
    };
  const count = (fn: (row: (typeof rows)[number]) => boolean) => rows.filter(fn).length;
  const actualInsufficient = rows.filter((row) => !row.expected.evidenceSufficient);
  const escalationPositive = rows.filter((row) => row.expected.escalation);
  const latencies = rows.flatMap((row) =>
    row.prediction.latencyMs === null ? [] : [row.prediction.latencyMs],
  );
  const costs = rows.flatMap((row) =>
    row.prediction.costUsd === null ? [] : [row.prediction.costUsd],
  );
  return {
    labeledCount: denominator,
    materialFalseNegatives: count((row) => row.expected.material && !row.prediction.material),
    materialFalsePositives: count((row) => !row.expected.material && row.prediction.material),
    criticalFalseNegatives: count((row) => row.expected.critical && !row.prediction.critical),
    docsNoiseFalsePositives: count((row) => row.expected.docsNoise && row.prediction.material),
    routeAccuracy: count((row) => row.expected.route === row.prediction.route) / denominator,
    evidenceInsufficiencyDetection: actualInsufficient.length
      ? actualInsufficient.filter((row) => row.prediction.evidenceInsufficient).length /
        actualInsufficient.length
      : null,
    escalationRecall: escalationPositive.length
      ? escalationPositive.filter((row) => row.prediction.escalation).length /
        escalationPositive.length
      : null,
    meanLatencyMs: latencies.length
      ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
      : null,
    costPerThousandUsd: costs.length
      ? (costs.reduce((sum, value) => sum + value, 0) / costs.length) * 1000
      : null,
  };
}

export function classifierPrediction(
  classifier: SemanticClassifierSummary,
): EnginePrediction | null {
  if (!classifier) return null;
  const route =
    classifier.category === "documentation"
      ? "uncertain"
      : classifier.category === "deprecation"
        ? "deprecation"
        : classifier.category === "api_change"
          ? "breaking_api_change"
          : classifier.category === "security"
            ? "auth_or_security_change"
            : classifier.category === "pricing"
              ? "pricing_change"
              : classifier.category === "limits"
                ? "limits_or_quota_change"
                : classifier.category === "terms"
                  ? "terms_or_policy_change"
                  : classifier.category === "availability"
                    ? "availability_or_runtime_change"
                    : classifier.category === "feature_change"
                      ? "feature_change"
                      : "uncertain";
  return {
    material: classifier.material,
    critical:
      classifier.material &&
      ["deprecation", "api_change", "security", "limits"].includes(classifier.category),
    route,
    evidenceInsufficient: classifier.decisionStatus === "review_required",
    escalation: classifier.decisionStatus === "review_required" || classifier.confidence < 0.82,
    latencyMs: null,
    costUsd: null,
  };
}

export function deriveZeroCriticalFalseNegativeThreshold(
  rows: Array<{ probability: number; expected: LabeledIntelligenceResult }>,
) {
  const criticalPositive = rows.filter((row) => row.expected.critical && row.expected.material);
  if (!criticalPositive.length) return null;
  return Math.max(0, Math.min(...criticalPositive.map((row) => row.probability)) - 1e-9);
}

export function derivePositiveClassThreshold(scores: number[]) {
  if (!scores.length) return null;
  return Math.max(0, Math.min(...scores) - 1e-9);
}

export function deriveIncompleteEvidenceThreshold(scoresForInsufficientEvidence: number[]) {
  if (!scoresForInsufficientEvidence.length) return null;
  return Math.min(1, Math.max(...scoresForInsufficientEvidence) + 1e-9);
}
