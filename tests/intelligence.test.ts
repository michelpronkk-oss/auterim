import { describe, expect, it, vi } from "vitest";
import { buildIntelligenceEvidence, measureEvidenceQuality } from "@/lib/intelligence/evidence";
import {
  INTELLIGENCE_CALIBRATION_FIXTURE_IDS,
  INTELLIGENCE_GOLDEN_FIXTURES,
  INTELLIGENCE_HOLDOUT_FIXTURE_IDS,
} from "@/lib/intelligence/golden-fixtures";
import { applyIntelligencePolicy, type PolicyThresholds } from "@/lib/intelligence/policy";
import type { IntelligenceProbabilities } from "@/lib/intelligence/taxonomy";

const thresholds: PolicyThresholds = {
  material: 0.8,
  criticalChange: 0.75,
  evidenceSufficient: 0.8,
  docsNoise: 0.8,
  requiresEscalation: 0.8,
  routeConfidence: 0.7,
  calibrationFixtureCount: 24,
  calibrationVersion: "test-calibration-v1",
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

describe("M15.75A intelligence reliability lab", () => {
  it("keeps the complete versioned golden suite", () => {
    expect(INTELLIGENCE_GOLDEN_FIXTURES).toHaveLength(64);
    expect(INTELLIGENCE_GOLDEN_FIXTURES.map((item) => item.id)).toContain("truncated-deprecation");
    expect(INTELLIGENCE_GOLDEN_FIXTURES.map((item) => item.id)).toContain(
      "prompt-injection-in-docs",
    );
  });

  it("uses an explicit disjoint stratified calibration and holdout split", () => {
    const byId = new Map(INTELLIGENCE_GOLDEN_FIXTURES.map((item) => [item.id, item]));
    const calibrationIds = new Set<string>(INTELLIGENCE_CALIBRATION_FIXTURE_IDS);
    const holdoutIds = new Set<string>(INTELLIGENCE_HOLDOUT_FIXTURE_IDS);
    expect(calibrationIds.size).toBe(32);
    expect(holdoutIds.size).toBe(32);
    expect([...calibrationIds].filter((id) => holdoutIds.has(id))).toEqual([]);
    expect(new Set([...calibrationIds, ...holdoutIds])).toEqual(new Set(byId.keys()));

    for (const ids of [calibrationIds, holdoutIds]) {
      const fixtures = [...ids].map((id) => byId.get(id));
      expect(fixtures.every(Boolean)).toBe(true);
      const rows = fixtures.filter(
        (item): item is (typeof INTELLIGENCE_GOLDEN_FIXTURES)[number] => !!item,
      );
      expect(rows.some((item) => item.expected.material && item.expected.critical)).toBe(true);
      expect(rows.some((item) => item.expected.material && !item.expected.critical)).toBe(true);
      expect(rows.some((item) => item.expected.docsNoise)).toBe(true);
      expect(rows.some((item) => item.expected.route === "deprecation")).toBe(true);
      expect(rows.some((item) => item.expected.route === "breaking_api_change")).toBe(true);
      expect(rows.some((item) => item.expected.route === "auth_or_security_change")).toBe(true);
      expect(rows.some((item) => item.expected.route === "schema_or_contract_change")).toBe(true);
      expect(rows.some((item) => item.expected.route === "limits_or_quota_change")).toBe(true);
      expect(rows.some((item) => item.expected.route === "pricing_change")).toBe(true);
      expect(rows.some((item) => !item.expected.evidenceSufficient)).toBe(true);
      expect(rows.some((item) => item.expected.route === "uncertain")).toBe(true);
      expect(rows.some((item) => item.diffText.length > 4_000)).toBe(true);
      expect(rows.some((item) => item.diffText.toLowerCase().includes("ignore"))).toBe(true);
    }
  });

  it("builds provider-neutral bounded evidence without source URL credentials", () => {
    const item = INTELLIGENCE_GOLDEN_FIXTURES[0]!;
    const evidence = buildIntelligenceEvidence({
      sourceName: "Provider deprecations",
      sourceType: item.sourceType,
      sourceUrl: "https://provider.example/path?token=private",
      dependencyName: "Provider",
      beforeVersion: 1,
      afterVersion: 2,
      diffText: item.diffText,
      addedLines: item.addedLines,
      removedLines: item.removedLines,
      diffTruncated: false,
      beforeBytes: Buffer.byteLength(item.before),
      afterBytes: Buffer.byteLength(item.after),
    });
    expect(evidence.state).not.toHaveProperty("sourceUrl");
    expect(evidence.packet.diffText).toContain("retires");
    expect(evidence.quality.sourceCriticality).toBe("critical");
    expect(evidence.quality.semanticEvidenceCoverage).toBe(1);
  });

  it("prevents incomplete critical evidence from becoming a non-material suppression", () => {
    const item = INTELLIGENCE_GOLDEN_FIXTURES.find(
      (value) => value.id === "truncated-deprecation",
    )!;
    const quality = measureEvidenceQuality({
      sourceName: "Deprecations",
      sourceType: item.sourceType,
      sourceUrl: "https://example.com",
      dependencyName: "Provider",
      beforeVersion: 1,
      afterVersion: 2,
      diffText: item.diffText,
      addedLines: item.addedLines,
      removedLines: item.removedLines,
      diffTruncated: true,
      beforeBytes: 100,
      afterBytes: 100,
    });
    const policy = applyIntelligencePolicy({
      classifier: {
        material: false,
        category: "documentation",
        confidence: 0.99,
        decisionStatus: "classified",
      },
      judgment: {
        route: "docs_noise",
        confidence: 0.99,
        probabilities: probabilities({ material: 0.01, criticalChange: 0.01, docsNoise: 0.99 }),
      },
      evidenceQuality: quality,
      thresholds,
    });
    expect(policy).toMatchObject({
      state: "insufficient_evidence",
      reason: "critical_evidence_incomplete",
      route: "uncertain",
    });
  });

  it("keeps classifier/Jev disagreement as review work", () => {
    const item = INTELLIGENCE_GOLDEN_FIXTURES[6]!;
    const quality = measureEvidenceQuality({
      sourceName: item.id,
      sourceType: item.sourceType,
      sourceUrl: "https://example.com",
      dependencyName: "Provider",
      beforeVersion: 1,
      afterVersion: 2,
      diffText: item.diffText,
      addedLines: item.addedLines,
      removedLines: item.removedLines,
      diffTruncated: false,
      beforeBytes: 10,
      afterBytes: 10,
    });
    const result = applyIntelligencePolicy({
      classifier: {
        material: true,
        category: "pricing",
        confidence: 0.9,
        decisionStatus: "classified",
      },
      judgment: {
        route: "docs_noise",
        confidence: 0.9,
        probabilities: probabilities({
          material: 0.1,
          criticalChange: 0.01,
          docsNoise: 0.95,
          route: { ...probabilities().route, docs_noise: 0.95 },
        }),
      },
      evidenceQuality: quality,
      thresholds,
    });
    expect(result.state).toBe("escalate");
    expect(result.reason).toBe("classifier_jev_disagree_docs_noise");
  });

  it("escalates a high-risk route when the model also signals docs noise", () => {
    const item = INTELLIGENCE_GOLDEN_FIXTURES.find((value) => value.id === "endpoint-removal")!;
    const quality = measureEvidenceQuality({
      sourceName: item.id,
      sourceType: item.sourceType,
      sourceUrl: "https://example.com",
      dependencyName: "Provider",
      beforeVersion: 1,
      afterVersion: 2,
      diffText: item.diffText,
      addedLines: item.addedLines,
      removedLines: item.removedLines,
      diffTruncated: false,
      beforeBytes: 10,
      afterBytes: 10,
    });
    const result = applyIntelligencePolicy({
      classifier: null,
      judgment: {
        route: "breaking_api_change",
        confidence: 0.9,
        probabilities: probabilities({
          material: 0.1,
          criticalChange: 0.1,
          docsNoise: 0.95,
          requiresEscalation: 0.1,
        }),
      },
      evidenceQuality: quality,
      thresholds,
    });
    expect(result).toMatchObject({
      state: "escalate",
      reason: "high_risk_route_docs_noise_conflict",
    });
  });

  it("routes a material Jev-only result to a candidate without requiring classifier success", () => {
    const item = INTELLIGENCE_GOLDEN_FIXTURES[6]!;
    const quality = measureEvidenceQuality({
      sourceName: item.id,
      sourceType: item.sourceType,
      sourceUrl: "https://example.com",
      dependencyName: "Provider",
      beforeVersion: 1,
      afterVersion: 2,
      diffText: item.diffText,
      addedLines: item.addedLines,
      removedLines: item.removedLines,
      diffTruncated: false,
      beforeBytes: 10,
      afterBytes: 10,
    });
    const result = applyIntelligencePolicy({
      classifier: null,
      judgment: {
        route: "pricing_change",
        confidence: 0.9,
        probabilities: probabilities({
          material: 0.9,
          criticalChange: 0.1,
          route: { ...probabilities().route, pricing_change: 0.9 },
        }),
      },
      evidenceQuality: quality,
      thresholds,
    });
    expect(result).toMatchObject({
      state: "continue_candidate",
      reason: "jev_material_without_classifier",
    });
  });

  it("sends only the pinned typed Decisions request and parses its typed probability response", async () => {
    vi.stubEnv("AUTERIM_INTELLIGENCE_MODEL", "typesafe/jev-1.14");
    const item = INTELLIGENCE_GOLDEN_FIXTURES[0]!;
    const evidence = buildIntelligenceEvidence({
      sourceName: item.id,
      sourceType: item.sourceType,
      sourceUrl: "https://example.com",
      dependencyName: "Provider",
      beforeVersion: 1,
      afterVersion: 2,
      diffText: item.diffText,
      addedLines: 1,
      removedLines: 1,
      diffTruncated: false,
      beforeBytes: 40,
      afterBytes: 45,
    });
    const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://openrouter.ai/api/alpha/decisions");
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        questions: Record<string, unknown>;
      };
      expect(body.model).toBe("typesafe/jev-1.14");
      expect(body.questions).toHaveProperty("route");
      expect(body.questions).toHaveProperty("material");
      expect(body.questions).not.toHaveProperty("tool");
      return new Response(
        JSON.stringify({
          model: "typesafe/jev-1.14-20261014",
          answers: {
            route: {
              type: "choice",
              choice: "deprecation",
              confidence: 0.93,
              probabilities: { deprecation: 0.93, uncertain: 0.07 },
            },
            material: { type: "noul", noul: 0.98 },
            critical: { type: "noul", noul: 0.91 },
            evidence_sufficient: { type: "noul", noul: 0.94 },
            docs_noise: { type: "noul", noul: 0.01 },
            escalation: { type: "noul", noul: 0.8 },
          },
          usage: { input_tokens: 200, output_tokens: 20, cost: 0.0000084 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const { requestJevDecision } = await import("@/lib/intelligence/jev");
    const result = await requestJevDecision(evidence, { apiKey: "test-key-never-logged", request });
    expect(result).toMatchObject({
      route: "deprecation",
      responseModel: "typesafe/jev-1.14-20261014",
      inputTokens: 200,
      outputTokens: 20,
    });
    expect(result.probabilities.material).toBe(0.98);
    expect(request).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
  });
});
