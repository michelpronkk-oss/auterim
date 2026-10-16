import type {
  IntelligenceProbabilities,
  IntelligenceRoute,
  ProposedPolicyState,
  SemanticClassifierSummary,
} from "@/lib/intelligence/taxonomy";
import type { EvidenceQuality } from "@/lib/intelligence/evidence";

export const INTELLIGENCE_POLICY_VERSION = "intelligence-policy-v1";

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
  if (quality.sourceCriticality === "critical" && quality.incomplete) {
    return {
      route: "uncertain",
      state: "insufficient_evidence",
      reason: "critical_evidence_incomplete",
    };
  }
  if (probability.evidenceSufficient < thresholds.evidenceSufficient) {
    return { route: "uncertain", state: "insufficient_evidence", reason: "evidence_insufficient" };
  }
  if (
    judgment.route === "uncertain" ||
    judgment.confidence < thresholds.routeConfidence ||
    probability.requiresEscalation >= thresholds.requiresEscalation
  ) {
    return { route: judgment.route, state: "escalate", reason: "model_uncertain" };
  }
  if (probability.criticalChange >= thresholds.criticalChange) {
    return { route: judgment.route, state: "escalate", reason: "critical_change_candidate" };
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
    return {
      route: judgment.route,
      state: "escalate",
      reason:
        judgment.route === "docs_noise"
          ? "classifier_jev_disagree_docs_noise"
          : "classifier_jev_disagree_material",
    };
  }
  if (highRiskRoute && jevDocsNoise) {
    return {
      route: judgment.route,
      state: "escalate",
      reason: "high_risk_route_docs_noise_conflict",
    };
  }
  if (classifier?.decisionStatus === "review_required") {
    return { route: judgment.route, state: "escalate", reason: "classifier_jev_disagree_material" };
  }
  if (classifier?.material && jevMaterial) {
    return {
      route: judgment.route,
      state: "continue_candidate",
      reason: "classifier_jev_agree_material",
    };
  }
  if (classifier?.material && jevDocsNoise) {
    return {
      route: judgment.route,
      state: "escalate",
      reason: "classifier_jev_disagree_docs_noise",
    };
  }
  if (!classifier && jevMaterial) {
    return {
      route: judgment.route,
      state: "continue_candidate",
      reason: "jev_material_without_classifier",
    };
  }
  if (classifier?.material || jevMaterial) {
    return {
      route: judgment.route,
      state: "escalate",
      reason: classifier ? "classifier_jev_disagree_material" : "jev_material_without_classifier",
    };
  }
  if (jevDocsNoise && quality.sourceCriticality !== "critical") {
    return {
      route: judgment.route,
      state: "suppress_candidate",
      reason: "both_non_material_docs_noise",
    };
  }
  return { route: judgment.route, state: "escalate", reason: "no_safe_suppression_evidence" };
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
