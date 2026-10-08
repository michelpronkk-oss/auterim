import { describe, expect, it } from "vitest";
import {
  deriveOnboardingRecommendations,
  deriveProductBaselineStatus,
  ONBOARDING_V2_STAGES,
} from "@/lib/onboarding/v2";

describe("Product onboarding V2", () => {
  it("defines a stable, resumable stage order with the CLI insertion point at discovery", () => {
    expect(ONBOARDING_V2_STAGES).toEqual([
      "scan_import",
      "company",
      "product",
      "discovery",
      "dependency_confirmation",
      "protection_graph",
      "strengthen_protection",
      "activation",
      "complete",
    ]);
  });

  it("recommends only actions grounded in missing dependencies, real verification access, or baseline state", () => {
    expect(
      deriveOnboardingRecommendations({
        dependencyCount: 0,
        mappedRepositories: 0,
        verificationAvailable: false,
        baselineStatus: null,
        hasUnresolvedCandidates: true,
      }),
    ).toEqual([
      {
        key: "review-discovery",
        reason: "Public website evidence still has suggestions that need your decision.",
        action: "confirm_dependencies",
      },
      {
        key: "confirm-dependency",
        reason: "Protection starts with at least one dependency you confirm or add.",
        action: "confirm_dependencies",
      },
    ]);
  });

  it("never recommends GitHub verification without entitlement and never claims baselines that are not ready", () => {
    expect(
      deriveOnboardingRecommendations({
        dependencyCount: 2,
        mappedRepositories: 0,
        verificationAvailable: false,
        baselineStatus: "in_progress",
        hasUnresolvedCandidates: false,
      }).map((item) => item.key),
    ).toEqual(["baseline-progress"]);
  });

  it("provides contextual GitHub and partial-coverage guidance from actual Product state", () => {
    expect(
      deriveOnboardingRecommendations({
        dependencyCount: 2,
        mappedRepositories: 0,
        verificationAvailable: true,
        baselineStatus: "partial",
        hasUnresolvedCandidates: false,
      }).map((item) => item.key),
    ).toEqual(["connect-github", "baseline-partial"]);
  });

  it("does not claim baseline work is in progress without observed baseline evidence", () => {
    expect(
      deriveProductBaselineStatus({
        protectedProduct: true,
        sources: 4,
        observedBaselines: 0,
      }),
    ).toBe("partial");
    expect(
      deriveProductBaselineStatus({
        protectedProduct: true,
        sources: 4,
        observedBaselines: 2,
      }),
    ).toBe("in_progress");
    expect(
      deriveProductBaselineStatus({
        protectedProduct: true,
        sources: 4,
        observedBaselines: 4,
      }),
    ).toBe("ready");
    expect(
      deriveProductBaselineStatus({
        protectedProduct: false,
        sources: 4,
        observedBaselines: 0,
      }),
    ).toBeNull();
  });
});
