export const ONBOARDING_V2_STAGES = [
  "scan_import",
  "company",
  "product",
  "discovery",
  "dependency_confirmation",
  "protection_graph",
  "strengthen_protection",
  "activation",
  "complete",
] as const;

export type OnboardingV2Stage = (typeof ONBOARDING_V2_STAGES)[number];

export type OnboardingRecommendation = {
  key: string;
  reason: string;
  action: "confirm_dependencies" | "connect_github" | "wait_for_baseline" | "review_product";
};

export function deriveProductBaselineStatus(input: {
  protectedProduct: boolean;
  sources: number;
  observedBaselines: number;
  failedSources?: number;
}): "ready" | "in_progress" | "partial" | null {
  if (!input.protectedProduct) return null;
  if (input.sources <= 0 || input.observedBaselines <= 0 || (input.failedSources ?? 0) > 0)
    return "partial";
  if (input.observedBaselines >= input.sources) return "ready";
  return "in_progress";
}

export function deriveOnboardingRecommendations(input: {
  dependencyCount: number;
  mappedRepositories: number;
  verificationAvailable: boolean;
  baselineStatus: "ready" | "in_progress" | "partial" | null;
  hasUnresolvedCandidates: boolean;
}): OnboardingRecommendation[] {
  const recommendations: OnboardingRecommendation[] = [];
  if (input.hasUnresolvedCandidates) {
    recommendations.push({
      key: "review-discovery",
      reason: "Public website evidence still has suggestions that need your decision.",
      action: "confirm_dependencies",
    });
  }
  if (input.dependencyCount === 0) {
    recommendations.push({
      key: "confirm-dependency",
      reason: "Protection starts with at least one dependency you confirm or add.",
      action: "confirm_dependencies",
    });
  }
  if (input.dependencyCount > 0 && input.verificationAvailable && input.mappedRepositories === 0) {
    recommendations.push({
      key: "connect-github",
      reason:
        "GitHub repository evidence can verify whether a confirmed dependency is used in your code.",
      action: "connect_github",
    });
  }
  if (input.baselineStatus === "in_progress") {
    recommendations.push({
      key: "baseline-progress",
      reason: "Shared authoritative source baselines are still being collected.",
      action: "wait_for_baseline",
    });
  }
  if (input.baselineStatus === "partial") {
    recommendations.push({
      key: "baseline-partial",
      reason: "Some confirmed dependencies do not yet have complete authoritative source coverage.",
      action: "review_product",
    });
  }
  return recommendations.slice(0, 5);
}
