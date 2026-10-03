import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseEnvironment } from "../src/lib/env/schema.ts";
import {
  applyCustomerImpactPolicy,
  buildCustomerImpactPacket,
  OpenAIImpactClassifierError,
  OpenAICustomerImpactClassifier,
  validateGroundedEvidence,
  type CustomerImpactPacket,
} from "../src/lib/impact/impact.ts";

const INPUT_USD_PER_MILLION = 2;
const OUTPUT_USD_PER_MILLION = 10;

function readAuterimEnvironment() {
  let contents: string;
  try {
    contents = readFileSync(".env.local", "utf8");
  } catch {
    return parseEnvironment({});
  }
  const entries = contents.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return [];
    const separator = trimmed.indexOf("=");
    if (separator < 1) return [];
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    return [[key, value]];
  });
  return parseEnvironment(Object.fromEntries(entries));
}

const baseline: CustomerImpactPacket = {
  dependencyName: "OpenAI",
  globalChange: {
    sourceType: "pricing",
    material: true,
    category: "pricing",
    summary: "Standard model input price increased by 20%.",
    affectedEntities: ["Standard model"],
    severityHint: "medium",
    confidence: 0.95,
    evidence: [
      { type: "changed", excerpt: "Standard model input: $1.00 -> $1.20 per million tokens" },
    ],
  },
  context: {
    criticality: "critical",
    productionCritical: true,
    usedFor: ["AI processing", "verification"],
    contextNote: "The Standard model is used for production verification.",
    usageMetadata: {},
  },
};

const fixtures: Array<{
  name: string;
  packet: CustomerImpactPacket;
  expectedRelevant: boolean;
  expectedSeverity: string[];
}> = [
  {
    name: "production-critical-pricing",
    packet: baseline,
    expectedRelevant: true,
    expectedSeverity: ["high", "critical"],
  },
  {
    name: "optional-internal-pricing",
    packet: {
      ...baseline,
      context: {
        criticality: "normal",
        productionCritical: false,
        usedFor: ["internal workflows"],
        contextNote: "Optional staff experiments only.",
        usageMetadata: {},
      },
    },
    expectedRelevant: true,
    expectedSeverity: ["low", "informational"],
  },
  {
    name: "unrelated-auth-endpoint-deprecation",
    packet: {
      ...baseline,
      context: {
        criticality: "important",
        productionCritical: false,
        usedFor: ["billing"],
        contextNote: "Uses the provider only for invoice payment processing.",
        usageMetadata: {},
      },
      globalChange: {
        ...baseline.globalChange,
        sourceType: "api",
        category: "deprecation",
        summary: "The /v1/login endpoint is deprecated.",
        affectedEntities: ["/v1/login"],
        severityHint: "high",
        evidence: [{ type: "added", excerpt: "The /v1/login endpoint is deprecated." }],
      },
    },
    expectedRelevant: false,
    expectedSeverity: ["low", "informational"],
  },
];

it("runs a bounded live customer impact evaluation using Auterim's configured OpenAI Responses API", async () => {
  const environment = readAuterimEnvironment();
  if (
    environment.AUTERIM_CLASSIFIER_PROVIDER !== "openai" ||
    environment.AUTERIM_CLASSIFIER_MODEL !== "gpt-6.1-sol" ||
    !environment.OPENAI_API_KEY
  ) {
    throw new Error(
      "Live impact evaluation requires OPENAI_API_KEY, AUTERIM_CLASSIFIER_PROVIDER=openai, and AUTERIM_CLASSIFIER_MODEL=gpt-6.1-sol in Auterim/.env.local.",
    );
  }
  const classifier = new OpenAICustomerImpactClassifier(
    environment.AUTERIM_CLASSIFIER_MODEL,
    environment.OPENAI_API_KEY,
  );
  const results: Array<Record<string, unknown>> = [];
  const failures: Array<{ fixture: string; category: string }> = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let usageKnown = true;

  for (const fixture of fixtures) {
    const packet = buildCustomerImpactPacket(fixture.packet);
    try {
      const response = await classifier.classify(packet);
      const result = applyCustomerImpactPolicy(response.result, packet);
      validateGroundedEvidence(result, packet);
      if (response.inputTokens === null || response.outputTokens === null) usageKnown = false;
      else {
        inputTokens += response.inputTokens;
        outputTokens += response.outputTokens;
      }
      const text = [result.impactSummary, result.whyItMatters, result.recommendedAction ?? ""].join(
        " ",
      );
      const unsupportedAssumptions: string[] = [];
      if (
        /\$\s?\d+(?:\.\d+)?/.test(text) &&
        !/\$\s?\d+(?:\.\d+)?/.test(packet.context.contextNote)
      ) {
        unsupportedAssumptions.push("unsupported_dollar_amount");
      }
      if (
        /\b\d[\d,.]*\s*(?:requests|tokens|calls)\s*(?:per|\/|a)\s*(?:month|day|week)\b/i.test(text)
      ) {
        unsupportedAssumptions.push("unsupported_usage_volume");
      }
      const severityAgrees = fixture.expectedSeverity.includes(result.severity);
      results.push({
        fixture: fixture.name,
        expectedRelevant: fixture.expectedRelevant,
        actualRelevant: result.relevant,
        relevanceAgrees: fixture.expectedRelevant === result.relevant,
        expectedSeverity: fixture.expectedSeverity,
        actualSeverity: result.severity,
        severityAgrees,
        confidence: result.confidence,
        missingContext: result.missingContext,
        evidenceGrounded: true,
        unsupportedAssumptions,
        impactSummary: result.impactSummary,
        recommendedAction: result.recommendedAction,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      });
    } catch (error) {
      failures.push({
        fixture: fixture.name,
        category:
          error instanceof OpenAIImpactClassifierError
            ? error.category
            : "provider_or_transport_error",
      });
      usageKnown = false;
    }
  }

  const relevantDisagreements = results.filter((result) => result.relevanceAgrees === false);
  const falsePositives = results.filter(
    (result) => result.expectedRelevant === false && result.actualRelevant === true,
  );
  const falseNegatives = results.filter(
    (result) => result.expectedRelevant === true && result.actualRelevant === false,
  );
  const severityDisagreements = results.filter((result) => result.severityAgrees === false);
  const unsupportedAssumptions = results.flatMap((result) =>
    (result.unsupportedAssumptions as string[]).map((category) => ({
      fixture: result.fixture,
      category,
    })),
  );
  const estimatedCostUsd = usageKnown
    ? (inputTokens * INPUT_USD_PER_MILLION + outputTokens * OUTPUT_USD_PER_MILLION) / 1_000_000
    : null;
  console.log(
    `LIVE_IMPACT_EVALUATION ${JSON.stringify({
      provider: "openai",
      model: environment.AUTERIM_CLASSIFIER_MODEL,
      endpoint: "Responses API",
      calls: results.length + failures.length,
      relevanceAccuracy: results.length
        ? (results.length - relevantDisagreements.length) / results.length
        : null,
      severityDisagreements,
      falsePositives,
      falseNegatives,
      unsupportedAssumptions,
      results,
      failures,
      usage: { inputTokens, outputTokens, complete: usageKnown },
      estimatedCostUsd,
      estimateRatesUsdPerMillion: { input: INPUT_USD_PER_MILLION, output: OUTPUT_USD_PER_MILLION },
      estimateBasis: "Published standard uncached rates; actual billing may differ.",
    })}`,
  );
  expect(failures).toEqual([]);
  expect(results.length + failures.length).toBe(fixtures.length);
  expect(results).toHaveLength(fixtures.length);
}, 90_000);
