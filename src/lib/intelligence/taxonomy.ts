export const INTELLIGENCE_ROUTES = [
  "docs_noise",
  "deprecation",
  "breaking_api_change",
  "auth_or_security_change",
  "schema_or_contract_change",
  "pricing_change",
  "limits_or_quota_change",
  "sdk_change",
  "webhook_or_event_change",
  "feature_change",
  "availability_or_runtime_change",
  "terms_or_policy_change",
  "uncertain",
] as const;

export type IntelligenceRoute = (typeof INTELLIGENCE_ROUTES)[number];
export type ProposedPolicyState =
  "suppress_candidate" | "continue_candidate" | "escalate" | "insufficient_evidence";

export const INTELLIGENCE_ROUTE_TARGETS = {
  docs_noise: "suppress_archive",
  deprecation: "dependency_product_impact",
  breaking_api_change: "dependency_impact_repository_exposure_candidate",
  auth_or_security_change: "integration_auth_risk_analysis",
  schema_or_contract_change: "contract_exposure_analysis",
  pricing_change: "commercial_impact_analysis",
  limits_or_quota_change: "capacity_risk_analysis",
  sdk_change: "repository_dependency_exposure_analysis",
  webhook_or_event_change: "contract_repository_exposure_analysis",
  feature_change: "product_relevance_analysis",
  availability_or_runtime_change: "runtime_risk_analysis_candidate",
  terms_or_policy_change: "provider_policy_review",
  uncertain: "evidence_escalation",
} as const;

export type IntelligenceRouteTarget =
  (typeof INTELLIGENCE_ROUTE_TARGETS)[keyof typeof INTELLIGENCE_ROUTE_TARGETS];

export function resolveIntelligenceRouteTarget(route: IntelligenceRoute): IntelligenceRouteTarget {
  return INTELLIGENCE_ROUTE_TARGETS[route];
}

export type IntelligenceProbabilities = {
  material: number;
  criticalChange: number;
  evidenceSufficient: number;
  docsNoise: number;
  requiresEscalation: number;
  route: Record<IntelligenceRoute, number>;
};

export type JevJudgment = {
  route: IntelligenceRoute;
  confidence: number;
  probabilities: IntelligenceProbabilities;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number;
  responseModel: string;
};

export type SemanticClassifierSummary = {
  material: boolean;
  category: string;
  confidence: number;
  decisionStatus: "classified" | "review_required";
} | null;
