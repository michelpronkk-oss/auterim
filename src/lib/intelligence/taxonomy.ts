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
