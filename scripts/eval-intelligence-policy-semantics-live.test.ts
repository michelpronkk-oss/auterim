import { loadEnvConfig } from "@next/env";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildIntelligenceEvidence } from "../src/lib/intelligence/evidence";
import { INTELLIGENCE_GOLDEN_FIXTURES } from "../src/lib/intelligence/golden-fixtures";
import { CALIBRATED_ACTIVE_THRESHOLDS } from "../src/lib/intelligence/calibration";
import { applyIntelligencePolicy } from "../src/lib/intelligence/policy";
import { requestJevDecision } from "../src/lib/intelligence/jev";
import { getEnvironment, isIntegrationConfigured } from "../src/lib/env/schema";
import type { SemanticClassifierSummary } from "../src/lib/intelligence/taxonomy";

loadEnvConfig(process.cwd());
if (!process.env.OPENROUTER_API_KEY) {
  try {
    const keyLine = readFileSync(".env.local", "utf8")
      .split(/\r?\n/)
      .find((line) => line.trimStart().startsWith("OPENROUTER_API_KEY="));
    if (keyLine) {
      const separator = keyLine.indexOf("=");
      const value = keyLine
        .slice(separator + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2");
      if (value) process.env.OPENROUTER_API_KEY = value;
    }
  } catch {
    // The bounded live eval reports the safe configuration state below.
  }
}

const selectedIds = [
  "sdk-breaking-change",
  "endpoint-removal",
  "documentation-wording",
  "truncated-deprecation",
  "ambiguous-evidence",
  "pricing-increase",
] as const;

const expectedClassifier: Record<(typeof selectedIds)[number], SemanticClassifierSummary | null> = {
  "sdk-breaking-change": {
    material: true,
    category: "sdk_change",
    confidence: 0.99,
    decisionStatus: "classified",
  },
  "endpoint-removal": {
    material: true,
    category: "api_change",
    confidence: 0.99,
    decisionStatus: "classified",
  },
  "documentation-wording": {
    material: false,
    category: "documentation",
    confidence: 0.99,
    decisionStatus: "classified",
  },
  "truncated-deprecation": {
    material: true,
    category: "deprecation",
    confidence: 0.99,
    decisionStatus: "classified",
  },
  "ambiguous-evidence": null,
  "pricing-increase": {
    material: true,
    category: "pricing",
    confidence: 0.99,
    decisionStatus: "classified",
  },
};

function asEvidenceInput(item: (typeof INTELLIGENCE_GOLDEN_FIXTURES)[number]) {
  const providerExamples: Record<string, string> = {
    "endpoint-removal": "Vercel",
    "pricing-increase": "Stripe",
  };
  return {
    sourceName: item.id,
    sourceType: item.sourceType,
    sourceUrl: "https://fixture.provider.invalid/source",
    dependencyName: providerExamples[item.id] ?? "Static provider fixture",
    beforeVersion: 1,
    afterVersion: 2,
    diffText: item.diffText,
    addedLines: item.addedLines,
    removedLines: item.removedLines,
    diffTruncated: item.diffTruncated ?? false,
    beforeBytes: Buffer.byteLength(item.before),
    afterBytes: Buffer.byteLength(item.after),
  };
}

describe("bounded live Jev policy-semantics validation", () => {
  it("checks six fixed golden cases without persistence or downstream dispatch", async () => {
    if (process.env.RUN_INTELLIGENCE_POLICY_SEMANTICS_LIVE !== "1")
      throw new Error("Set RUN_INTELLIGENCE_POLICY_SEMANTICS_LIVE=1 to run six bounded Jev calls.");
    const environment = getEnvironment();
    if (!isIntegrationConfigured("intelligence", environment))
      throw new Error("Jev integration is not configured.");

    const fixtures = new Map(INTELLIGENCE_GOLDEN_FIXTURES.map((item) => [item.id, item]));
    for (const id of selectedIds) {
      const fixture = fixtures.get(id);
      if (!fixture) throw new Error(`live_jev_fixture_missing:${id}`);
      const evidence = buildIntelligenceEvidence(asEvidenceInput(fixture));
      let judgment;
      try {
        judgment = await requestJevDecision(evidence);
      } catch (error) {
        const category =
          error instanceof Error && "category" in error ? String(error.category) : "provider_error";
        throw new Error(`live_jev_case_failed:${id}:${category}`);
      }
      const policy = applyIntelligencePolicy({
        classifier: expectedClassifier[id],
        judgment,
        evidenceQuality: evidence.quality,
        thresholds: CALIBRATED_ACTIVE_THRESHOLDS,
      });

      if (id === "sdk-breaking-change") {
        expect(judgment.route).toBe("sdk_change");
        expect(judgment.probabilities.material).toBeGreaterThanOrEqual(
          CALIBRATED_ACTIVE_THRESHOLDS.material,
        );
        expect(judgment.probabilities.evidenceSufficient).toBeGreaterThanOrEqual(
          CALIBRATED_ACTIVE_THRESHOLDS.evidenceSufficient,
        );
        expect(
          judgment.probabilities.criticalChange >= CALIBRATED_ACTIVE_THRESHOLDS.criticalChange ||
            judgment.probabilities.requiresEscalation >=
              CALIBRATED_ACTIVE_THRESHOLDS.requiresEscalation,
        ).toBe(true);
        expect(policy.reviewDisposition).toBe("review_required");
        expect(policy.state).toBe(
          judgment.confidence < CALIBRATED_ACTIVE_THRESHOLDS.routeConfidence
            ? "escalate"
            : "continue_candidate",
        );
      } else if (id === "endpoint-removal") {
        expect(judgment.route).toBe("breaking_api_change");
        expect(judgment.probabilities.material).toBeGreaterThanOrEqual(
          CALIBRATED_ACTIVE_THRESHOLDS.material,
        );
        expect(judgment.probabilities.evidenceSufficient).toBeGreaterThanOrEqual(
          CALIBRATED_ACTIVE_THRESHOLDS.evidenceSufficient,
        );
        expect(policy.reviewDisposition).toBe("review_required");
        expect(policy.state).toBe(
          judgment.confidence < CALIBRATED_ACTIVE_THRESHOLDS.routeConfidence
            ? "escalate"
            : "continue_candidate",
        );
      } else if (id === "documentation-wording") {
        expect(judgment.route).toBe("docs_noise");
        expect(judgment.probabilities.material).toBeLessThan(CALIBRATED_ACTIVE_THRESHOLDS.material);
        expect(judgment.probabilities.docsNoise).toBeGreaterThanOrEqual(
          CALIBRATED_ACTIVE_THRESHOLDS.docsNoise,
        );
        if (
          judgment.probabilities.evidenceSufficient <
          CALIBRATED_ACTIVE_THRESHOLDS.evidenceSufficient
        ) {
          expect(policy.state).toBe("insufficient_evidence");
        } else if (
          judgment.probabilities.criticalChange >= CALIBRATED_ACTIVE_THRESHOLDS.criticalChange ||
          judgment.probabilities.requiresEscalation >=
            CALIBRATED_ACTIVE_THRESHOLDS.requiresEscalation
        ) {
          expect(policy.state).toBe("escalate");
          expect(policy.reviewDisposition).toBe("review_required");
        } else {
          expect(policy.state).toBe("suppress_candidate");
        }
      } else if (id === "truncated-deprecation") {
        expect(evidence.quality.incomplete).toBe(true);
        expect(evidence.quality.sourceCriticality).toBe("critical");
        expect(policy.state).toBe("insufficient_evidence");
      } else if (id === "ambiguous-evidence") {
        expect(
          judgment.route === "uncertain" ||
            judgment.confidence < CALIBRATED_ACTIVE_THRESHOLDS.routeConfidence ||
            judgment.probabilities.evidenceSufficient <
              CALIBRATED_ACTIVE_THRESHOLDS.evidenceSufficient,
        ).toBe(true);
        expect(["escalate", "insufficient_evidence"]).toContain(policy.state);
      } else {
        expect(judgment.route).toBe("pricing_change");
        expect(judgment.probabilities.material).toBeGreaterThanOrEqual(
          CALIBRATED_ACTIVE_THRESHOLDS.material,
        );
        if (
          judgment.probabilities.evidenceSufficient <
          CALIBRATED_ACTIVE_THRESHOLDS.evidenceSufficient
        ) {
          expect(policy.state).toBe("insufficient_evidence");
        } else if (judgment.confidence < CALIBRATED_ACTIVE_THRESHOLDS.routeConfidence) {
          expect(policy.state).toBe("escalate");
        } else {
          expect(policy.state).toBe("continue_candidate");
        }
        expect(policy.reviewDisposition).toBe(
          judgment.probabilities.criticalChange >= CALIBRATED_ACTIVE_THRESHOLDS.criticalChange ||
            judgment.probabilities.requiresEscalation >=
              CALIBRATED_ACTIVE_THRESHOLDS.requiresEscalation
            ? "review_required"
            : "none",
        );
      }

      console.log(
        JSON.stringify({
          case: id,
          route: judgment.route,
          confidence: judgment.confidence,
          material: judgment.probabilities.material,
          criticalChange: judgment.probabilities.criticalChange,
          evidenceSufficient: judgment.probabilities.evidenceSufficient,
          docsNoise: judgment.probabilities.docsNoise,
          requiresEscalation: judgment.probabilities.requiresEscalation,
          policyState: policy.state,
          reviewDisposition: policy.reviewDisposition,
          reviewReason: policy.reviewReason,
          responseModel: judgment.responseModel,
        }),
      );
    }
  });
});
