import type {
  IntelligenceProbabilities,
  IntelligenceRoute,
  ProposedPolicyState,
  SemanticClassifierSummary,
} from "@/lib/intelligence/taxonomy";
import type { EvidenceQuality } from "@/lib/intelligence/evidence";

// The database queue identity remains v1 for compatibility; this identifies
// the changed policy semantics persisted on each decision.
export const INTELLIGENCE_POLICY_VERSION = "intelligence-policy-semantics-v2";

export type PolicyThresholds = {
  material: number;
  criticalChange: number;
  evidenceSufficient: number;
  docsNoise: number;
  requiresEscalation: number;
  routeConfidence: number;
  calibrationFixtureCount: number;
  calibrationVersion: string;
};

export type PolicyDecision = {
  route: IntelligenceRoute;
  state: ProposedPolicyState;
  reviewDisposition: "none" | "review_required";
  reviewReason:
    | "critical_change"
    | "elevated_risk"
    | "classifier_review"
    | "evidence_incomplete"
    | "evidence_insufficient"
    | "analysis_uncertain"
    | "classifier_model_conflict"
    | "high_risk_docs_noise_conflict"
    | "policy_review"
    | null;
  reason:
    | "critical_evidence_incomplete"
    | "evidence_insufficient"
    | "model_uncertain"
    | "critical_change_candidate"
    | "classifier_jev_agree_material"
    | "classifier_jev_disagree_material"
    | "classifier_jev_disagree_docs_noise"
    | "high_risk_route_docs_noise_conflict"
    | "both_non_material_docs_noise"
    | "jev_material_without_classifier"
    | "no_safe_suppression_evidence";
};

export function applyIntelligencePolicy(input: {
  classifier: SemanticClassifierSummary;
  judgment: {
    route: IntelligenceRoute;
    confidence: number;
    probabilities: IntelligenceProbabilities;
  };
  evidenceQuality: EvidenceQuality;
  thresholds: PolicyThresholds;
}): PolicyDecision {
  const { classifier, judgment, evidenceQuality: quality, thresholds } = input;
  const probability = judgment.probabilities;
  const reviewReason =
    probability.criticalChange >= thresholds.criticalChange ||
    quality.sourceCriticality === "critical"
      ? "critical_change"
      : probability.requiresEscalation >= thresholds.requiresEscalation
        ? "elevated_risk"
        : classifier?.decisionStatus === "review_required"
          ? "classifier_review"
          : null;
  const decision = (
    route: IntelligenceRoute,
    state: ProposedPolicyState,
    reason: PolicyDecision["reason"],
    explicitReviewReason: PolicyDecision["reviewReason"] = null,
  ): PolicyDecision => {
    const requiredReviewReason = explicitReviewReason ?? reviewReason;
    return {
      route,
      state,
      reason,
      reviewDisposition: requiredReviewReason ? "review_required" : "none",
      reviewReason: requiredReviewReason,
    };
  };

  if (quality.sourceCriticality === "critical" && quality.incomplete) {
    return decision(
      "uncertain",
      "insufficient_evidence",
      "critical_evidence_incomplete",
      "evidence_incomplete",
    );
  }
  if (probability.evidenceSufficient < thresholds.evidenceSufficient) {
    return decision(
      "uncertain",
      "insufficient_evidence",
      "evidence_insufficient",
      "evidence_insufficient",
    );
  }
  if (judgment.route === "uncertain" || judgment.confidence < thresholds.routeConfidence) {
    return decision(judgment.route, "escalate", "model_uncertain", "analysis_uncertain");
  }

  const jevMaterial = probability.material >= thresholds.material;
  const jevDocsNoise =
    probability.docsNoise >= thresholds.docsNoise || judgment.route === "docs_noise";
  const highRiskRoute = [
    "deprecation",
    "breaking_api_change",
    "auth_or_security_change",
    "schema_or_contract_change",
    "webhook_or_event_change",
    "limits_or_quota_change",
  ].includes(judgment.route);
  const classifierRoute = classifier?.material
    ? classifierRouteForCategory(classifier.category)
    : null;
  if (classifierRoute && classifierRoute !== judgment.route) {
    return decision(
      judgment.route,
      "escalate",
      judgment.route === "docs_noise"
        ? "classifier_jev_disagree_docs_noise"
        : "classifier_jev_disagree_material",
      "classifier_model_conflict",
    );
  }
  if (highRiskRoute && jevDocsNoise) {
    return decision(
      judgment.route,
      "escalate",
      "high_risk_route_docs_noise_conflict",
      "high_risk_docs_noise_conflict",
    );
  }
  if (classifier?.material && jevMaterial) {
    return decision(judgment.route, "continue_candidate", "classifier_jev_agree_material");
  }
  if (classifier?.material && jevDocsNoise) {
    return decision(
      judgment.route,
      "escalate",
      "classifier_jev_disagree_docs_noise",
      "classifier_model_conflict",
    );
  }
  if (!classifier && jevMaterial) {
    return decision(judgment.route, "continue_candidate", "jev_material_without_classifier");
  }
  if (classifier?.material || jevMaterial) {
    return decision(
      judgment.route,
      "escalate",
      classifier ? "classifier_jev_disagree_material" : "jev_material_without_classifier",
      "classifier_model_conflict",
    );
  }
  if (jevDocsNoise && quality.sourceCriticality !== "critical" && reviewReason === null) {
    return decision(judgment.route, "suppress_candidate", "both_non_material_docs_noise");
  }
  return decision(
    judgment.route,
    "escalate",
    "no_safe_suppression_evidence",
    reviewReason ?? "policy_review",
  );
}

function classifierRouteForCategory(category: string): IntelligenceRoute | null {
  const routes: Record<string, IntelligenceRoute> = {
    documentation: "docs_noise",
    deprecation: "deprecation",
    sdk_change: "sdk_change",
    api_change: "breaking_api_change",
    security: "auth_or_security_change",
    pricing: "pricing_change",
    limits: "limits_or_quota_change",
    terms: "terms_or_policy_change",
    availability: "availability_or_runtime_change",
    feature_change: "feature_change",
  };
  return routes[category] ?? null;
}

export function chooseMaterialThreshold(
  cases: Array<{ probability: number; material: boolean; critical: boolean }>,
) {
  const positiveCritical = cases.filter((item) => item.material && item.critical);
  if (positiveCritical.length === 0) return 1;
  const minimum = Math.min(...positiveCritical.map((item) => item.probability));
  return Math.max(0, Number((minimum - 1e-9).toFixed(9)));
}
