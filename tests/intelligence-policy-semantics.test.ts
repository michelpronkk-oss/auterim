import { describe, expect, it } from "vitest";
import { applyIntelligencePolicy, type PolicyThresholds } from "@/lib/intelligence/policy";
import type { EvidenceQuality } from "@/lib/intelligence/evidence";
import type {
  IntelligenceProbabilities,
  IntelligenceRoute,
  SemanticClassifierSummary,
} from "@/lib/intelligence/taxonomy";

const thresholds: PolicyThresholds = {
  material: 0.4,
  criticalChange: 0.51,
  evidenceSufficient: 0.42,
  docsNoise: 0.83,
  requiresEscalation: 0.54,
  routeConfidence: 0.49,
  calibrationFixtureCount: 32,
  calibrationVersion: "m1575a-stratified-64-v2",
};

function evidence(
  sourceCriticality: "critical" | "standard" = "standard",
  incomplete = false,
): EvidenceQuality {
  return {
    diffTruncated: incomplete,
    previousSideTruncated: false,
    currentSideTruncated: false,
    normalizedByteSize: 80,
    addedLineCount: 1,
    removedLineCount: 1,
    sourceCriticality,
    sourceType: sourceCriticality === "critical" ? "api" : "changelog",
    semanticEvidenceCoverage: incomplete ? 0.5 : 1,
    incomplete,
  };
}

function judgment(
  route: IntelligenceRoute,
  overrides: Partial<IntelligenceProbabilities> = {},
  confidence = 0.99,
) {
  const routeProbabilities = Object.fromEntries(
    [
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
    ].map((value) => [value, value === route ? confidence : 0]),
  ) as IntelligenceProbabilities["route"];
  return {
    route,
    confidence,
    probabilities: {
      material: 0.95,
      criticalChange: 0.1,
      evidenceSufficient: 0.95,
      docsNoise: 0.02,
      requiresEscalation: 0.02,
      route: routeProbabilities,
      ...overrides,
    },
  };
}

function classifier(
  category: string,
  decisionStatus: "classified" | "review_required" = "classified",
): SemanticClassifierSummary {
  return { material: true, category, confidence: 0.99, decisionStatus };
}

const run = (
  route: IntelligenceRoute,
  options: {
    classifier?: SemanticClassifierSummary;
    probabilities?: Partial<IntelligenceProbabilities>;
    confidence?: number;
    evidence?: EvidenceQuality;
  } = {},
) =>
  applyIntelligencePolicy({
    classifier: options.classifier ?? null,
    judgment: judgment(route, options.probabilities, options.confidence),
    evidenceQuality: options.evidence ?? evidence(),
    thresholds,
  });

describe("M15.77 orthogonal analysis and review policy semantics", () => {
  it("lets a clear noncritical material SDK change continue without review", () => {
    expect(run("sdk_change", { classifier: classifier("sdk_change") })).toMatchObject({
      state: "continue_candidate",
      reviewDisposition: "none",
      reviewReason: null,
    });
  });

  it.each([
    ["clear critical breaking SDK", "sdk_change", "sdk_change", "standard"],
    ["endpoint removal", "breaking_api_change", "api_change", "critical"],
    ["auth/scope break", "auth_or_security_change", "security", "critical"],
  ] as const)(
    "allows analysis and preserves review for %s",
    (_label, route, category, criticality) => {
      expect(
        run(route, {
          classifier: classifier(category),
          evidence: evidence(criticality),
          probabilities: { criticalChange: 0.96, requiresEscalation: 0.89 },
        }),
      ).toMatchObject({ state: "continue_candidate", reviewDisposition: "review_required" });
    },
  );

  it("continues a pricing increase and retains elevated review risk", () => {
    expect(
      run("pricing_change", {
        classifier: classifier("pricing"),
        probabilities: { requiresEscalation: 0.7 },
      }),
    ).toMatchObject({
      state: "continue_candidate",
      reviewDisposition: "review_required",
      reviewReason: "elevated_risk",
    });
  });

  it("uses the calibrated escalation threshold only for review, not analysis eligibility", () => {
    const below = run("sdk_change", {
      classifier: classifier("sdk_change"),
      probabilities: { requiresEscalation: thresholds.requiresEscalation - 0.01 },
    });
    const at = run("sdk_change", {
      classifier: classifier("sdk_change"),
      probabilities: { requiresEscalation: thresholds.requiresEscalation },
    });

    expect(below).toMatchObject({ state: "continue_candidate", reviewDisposition: "none" });
    expect(at).toMatchObject({
      state: "continue_candidate",
      reviewDisposition: "review_required",
      reviewReason: "elevated_risk",
    });
  });

  it("suppresses safe documentation noise only with no review signal", () => {
    expect(
      run("docs_noise", {
        classifier: {
          material: false,
          category: "documentation",
          confidence: 0.99,
          decisionStatus: "classified",
        },
        probabilities: { material: 0.01, docsNoise: 0.99 },
      }),
    ).toMatchObject({ state: "suppress_candidate", reviewDisposition: "none" });
  });

  it("blocks analysis when evidence sufficiency is below its unchanged threshold", () => {
    expect(run("sdk_change", { probabilities: { evidenceSufficient: 0.2 } })).toMatchObject({
      state: "insufficient_evidence",
      reviewDisposition: "review_required",
      reviewReason: "evidence_insufficient",
    });
  });

  it("routes an uncertain family to evidence escalation", () => {
    expect(run("uncertain", { probabilities: { material: 0.1 }, confidence: 0.8 })).toMatchObject({
      state: "escalate",
      reason: "model_uncertain",
      reviewReason: "analysis_uncertain",
    });
  });

  it("routes below-threshold route confidence to evidence escalation", () => {
    expect(
      run("sdk_change", { classifier: classifier("sdk_change"), confidence: 0.48 }),
    ).toMatchObject({
      state: "escalate",
      reason: "model_uncertain",
      reviewReason: "analysis_uncertain",
    });
  });

  it("escalates an untrustworthy classifier/Jev route disagreement", () => {
    expect(run("sdk_change", { classifier: classifier("security") })).toMatchObject({
      state: "escalate",
      reviewDisposition: "review_required",
      reviewReason: "classifier_model_conflict",
    });
  });

  it("keeps critical incomplete evidence insufficient even when Jev appears material", () => {
    expect(
      run("deprecation", {
        classifier: classifier("deprecation"),
        evidence: evidence("critical", true),
        probabilities: { criticalChange: 0.99, material: 0.99 },
      }),
    ).toMatchObject({
      state: "insufficient_evidence",
      reviewDisposition: "review_required",
      reviewReason: "evidence_incomplete",
    });
  });

  it("does not suppress high-risk documentation conflicts", () => {
    expect(
      run("breaking_api_change", {
        classifier: classifier("api_change"),
        probabilities: { docsNoise: 0.99, requiresEscalation: 0.9 },
      }),
    ).toMatchObject({
      state: "escalate",
      reviewDisposition: "review_required",
      reviewReason: "high_risk_docs_noise_conflict",
    });
  });

  it("allows Jev-confirmed analysis while retaining a classifier review marker", () => {
    expect(
      run("sdk_change", { classifier: classifier("sdk_change", "review_required") }),
    ).toMatchObject({
      state: "continue_candidate",
      reviewDisposition: "review_required",
      reviewReason: "classifier_review",
    });
  });
});
