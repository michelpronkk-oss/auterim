import { describe, expect, it } from "vitest";
import { evaluateBoundedEscalationEvidence } from "@/lib/intelligence/escalation";
import { applyIntelligencePolicy, type PolicyThresholds } from "@/lib/intelligence/policy";
import {
  resolveIntelligenceRouteTarget,
  type IntelligenceProbabilities,
} from "@/lib/intelligence/taxonomy";

const thresholds: PolicyThresholds = {
  material: 0.8,
  criticalChange: 0.8,
  evidenceSufficient: 0.8,
  docsNoise: 0.8,
  requiresEscalation: 0.8,
  routeConfidence: 0.7,
  calibrationFixtureCount: 0,
  calibrationVersion: "router-tests-v1",
};

function probabilities(
  overrides: Partial<IntelligenceProbabilities> = {},
): IntelligenceProbabilities {
  return {
    material: 0.9,
    criticalChange: 0.1,
    evidenceSufficient: 0.95,
    docsNoise: 0.05,
    requiresEscalation: 0.05,
    route: {
      docs_noise: 0,
      deprecation: 0,
      breaking_api_change: 0,
      auth_or_security_change: 0,
      schema_or_contract_change: 0,
      pricing_change: 0,
      limits_or_quota_change: 0,
      sdk_change: 0,
      webhook_or_event_change: 0,
      feature_change: 0,
      availability_or_runtime_change: 0,
      terms_or_policy_change: 0,
      uncertain: 0,
    },
    ...overrides,
  };
}

describe("M15.75B autonomous intelligence router", () => {
  it("maps every canonical route to one non-overlapping typed target", () => {
    expect(resolveIntelligenceRouteTarget("docs_noise")).toBe("suppress_archive");
    expect(resolveIntelligenceRouteTarget("deprecation")).toBe("dependency_product_impact");
    expect(resolveIntelligenceRouteTarget("breaking_api_change")).toBe(
      "dependency_impact_repository_exposure_candidate",
    );
    expect(resolveIntelligenceRouteTarget("auth_or_security_change")).toBe(
      "integration_auth_risk_analysis",
    );
    expect(resolveIntelligenceRouteTarget("schema_or_contract_change")).toBe(
      "contract_exposure_analysis",
    );
    expect(resolveIntelligenceRouteTarget("pricing_change")).toBe("commercial_impact_analysis");
    expect(resolveIntelligenceRouteTarget("limits_or_quota_change")).toBe("capacity_risk_analysis");
    expect(resolveIntelligenceRouteTarget("sdk_change")).toBe(
      "repository_dependency_exposure_analysis",
    );
    expect(resolveIntelligenceRouteTarget("webhook_or_event_change")).toBe(
      "contract_repository_exposure_analysis",
    );
    expect(resolveIntelligenceRouteTarget("feature_change")).toBe("product_relevance_analysis");
    expect(resolveIntelligenceRouteTarget("availability_or_runtime_change")).toBe(
      "runtime_risk_analysis_candidate",
    );
    expect(resolveIntelligenceRouteTarget("terms_or_policy_change")).toBe("provider_policy_review");
    expect(resolveIntelligenceRouteTarget("uncertain")).toBe("evidence_escalation");
  });

  it("escalates material classifier/Jev category disagreement", () => {
    const result = applyIntelligencePolicy({
      classifier: {
        material: true,
        category: "security",
        confidence: 0.92,
        decisionStatus: "classified",
      },
      judgment: { route: "pricing_change", confidence: 0.95, probabilities: probabilities() },
      evidenceQuality: {
        diffTruncated: false,
        previousSideTruncated: false,
        currentSideTruncated: false,
        normalizedByteSize: 80,
        addedLineCount: 1,
        removedLineCount: 1,
        sourceCriticality: "critical",
        sourceType: "api",
        semanticEvidenceCoverage: 1,
        incomplete: false,
      },
      thresholds,
    });
    expect(result).toMatchObject({ state: "escalate", reason: "classifier_jev_disagree_material" });
  });

  it("never silently suppresses an uncertain route", () => {
    const result = applyIntelligencePolicy({
      classifier: null,
      judgment: {
        route: "uncertain",
        confidence: 0.99,
        probabilities: probabilities({ material: 0, docsNoise: 1 }),
      },
      evidenceQuality: {
        diffTruncated: false,
        previousSideTruncated: false,
        currentSideTruncated: false,
        normalizedByteSize: 10,
        addedLineCount: 0,
        removedLineCount: 0,
        sourceCriticality: "standard",
        sourceType: "docs",
        semanticEvidenceCoverage: 1,
        incomplete: false,
      },
      thresholds,
    });
    expect(result.state).toBe("escalate");
  });

  it("rechecks immutable evidence within fixed bounds and persists only a summary", () => {
    const result = evaluateBoundedEscalationEvidence({
      status: "claimed",
      id: "00000000-0000-4000-8000-000000000001",
      routeIntentId: "00000000-0000-4000-8000-000000000002",
      sourceChangeId: "00000000-0000-4000-8000-000000000003",
      claimToken: "00000000-0000-4000-8000-000000000004",
      attemptCount: 1,
      sourceType: "api",
      sourceName: "API changelog",
      dependencyName: "Payments",
      beforeVersion: 1,
      afterVersion: 2,
      diffText: "- old authentication behavior\n+ new authentication requirement",
      previousEvidence: "old authentication behavior",
      currentEvidence: "new authentication requirement",
      previousBytes: 28,
      currentBytes: 33,
      priorDiffTruncated: false,
    });
    expect(result).toMatchObject({
      terminalState: "completed",
      reason: "bounded_evidence_rechecked",
    });
    expect(result.summary.criticalMarkers).toContain("authentication");
    expect(JSON.stringify(result.summary)).not.toContain("old authentication behavior");
    expect(result.fingerprint).toMatch(/^[a-f0-9]{32}$/);
  });

  it("terminates incomplete source windows without looping or preserving excerpts", () => {
    const result = evaluateBoundedEscalationEvidence({
      status: "claimed",
      id: "00000000-0000-4000-8000-000000000001",
      routeIntentId: "00000000-0000-4000-8000-000000000002",
      sourceChangeId: "00000000-0000-4000-8000-000000000003",
      claimToken: "00000000-0000-4000-8000-000000000004",
      attemptCount: 3,
      sourceType: "deprecation",
      sourceName: "Provider changelog",
      dependencyName: "SDK",
      beforeVersion: 1,
      afterVersion: 2,
      diffText: "- old\n+ new",
      previousEvidence: `old ${"a".repeat(4096)}\n[bounded middle omitted]\n${"a".repeat(4096)}`,
      currentEvidence: "new",
      previousBytes: 9000,
      currentBytes: 3,
      priorDiffTruncated: true,
    });
    expect(result).toMatchObject({
      terminalState: "insufficient_evidence",
      reason: "bounded_evidence_still_incomplete",
      summary: { attemptCount: 3, diffTruncated: true },
    });
    expect(result.summary).not.toHaveProperty("previousEvidence");
  });
});
