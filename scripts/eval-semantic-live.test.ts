import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseEnvironment } from "../src/lib/env/schema.ts";
import {
  applyClassificationPolicy,
  buildEvidencePacket,
  OpenAIClassifierError,
  OpenAISemanticClassifier,
  type ClassificationChange,
} from "../src/lib/monitoring/classification.ts";

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

const fixtures: Array<{
  name: string;
  change: ClassificationChange;
  expectedMaterial: boolean;
  expectedCategory: string;
}> = [
  {
    name: "copyright-year-only",
    change: {
      sourceName: "OpenAI copyright notice",
      sourceType: "documentation",
      sourceUrl: "https://openai.com/policies",
      dependencyName: "OpenAI",
      beforeVersion: 1,
      afterVersion: 2,
      diffText: "-Copyright 2026 OpenAI\n+Copyright 2027 OpenAI",
      addedLines: 1,
      removedLines: 1,
      diffTruncated: false,
      beforeBytes: 18,
      afterBytes: 18,
    },
    expectedMaterial: false,
    expectedCategory: "documentation",
  },
  {
    name: "pricing-increase",
    change: {
      sourceName: "API pricing",
      sourceType: "pricing",
      sourceUrl: "https://openai.com/pricing",
      dependencyName: "OpenAI",
      beforeVersion: 3,
      afterVersion: 4,
      diffText:
        "-Standard model input: $1.00 per million tokens\n+Standard model input: $1.20 per million tokens",
      addedLines: 1,
      removedLines: 1,
      diffTruncated: false,
      beforeBytes: 45,
      afterBytes: 45,
    },
    expectedMaterial: true,
    expectedCategory: "pricing",
  },
  {
    name: "endpoint-deprecation-with-date",
    change: {
      sourceName: "API lifecycle notice",
      sourceType: "api",
      sourceUrl: "https://openai.com/docs/api",
      dependencyName: "OpenAI",
      beforeVersion: 8,
      afterVersion: 9,
      diffText: "+The /v1/events endpoint is deprecated and will be removed on 2027-06-01.",
      addedLines: 1,
      removedLines: 0,
      diffTruncated: false,
      beforeBytes: 0,
      afterBytes: 78,
    },
    expectedMaterial: true,
    expectedCategory: "deprecation",
  },
];

it("runs a bounded live semantic evaluation using only Auterim's configured OpenAI Responses API", async () => {
  const environment = readAuterimEnvironment();
  if (
    environment.AUTERIM_CLASSIFIER_PROVIDER !== "openai" ||
    environment.AUTERIM_CLASSIFIER_MODEL !== "gpt-6.1-sol" ||
    !environment.OPENAI_API_KEY
  ) {
    throw new Error(
      "Live semantic evaluation requires OPENAI_API_KEY, AUTERIM_CLASSIFIER_PROVIDER=openai, and AUTERIM_CLASSIFIER_MODEL=gpt-6.1-sol in Auterim/.env.local.",
    );
  }

  const classifier = new OpenAISemanticClassifier(
    environment.AUTERIM_CLASSIFIER_MODEL,
    environment.OPENAI_API_KEY,
  );
  const results: Array<Record<string, unknown>> = [];
  const failures: Array<{ fixture: string; category: string }> = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let usageKnown = true;

  for (const fixture of fixtures) {
    const packet = buildEvidencePacket(fixture.change);
    try {
      const response = await classifier.classify(packet);
      const decision = applyClassificationPolicy(response.classification, packet.diffTruncated);
      const evidenceText = `${packet.previousEvidence}\n${packet.currentEvidence}`;
      const grounded = response.classification.evidence.every((item) =>
        item.type === "added"
          ? packet.currentEvidence.includes(item.excerpt)
          : item.type === "removed"
            ? packet.previousEvidence.includes(item.excerpt)
            : evidenceText.includes(item.excerpt),
      );
      if (response.inputTokens === null || response.outputTokens === null) {
        usageKnown = false;
      } else {
        inputTokens += response.inputTokens;
        outputTokens += response.outputTokens;
      }
      results.push({
        fixture: fixture.name,
        expected: { material: fixture.expectedMaterial, category: fixture.expectedCategory },
        actual: {
          material: decision.material,
          category: decision.category,
          severityHint: decision.severityHint,
          confidence: decision.confidence,
          decisionStatus: decision.decisionStatus,
          evidenceGrounded: grounded,
          summary: decision.summary,
        },
        agrees:
          decision.material === fixture.expectedMaterial &&
          decision.category === fixture.expectedCategory &&
          grounded,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      });
    } catch (error) {
      failures.push({
        fixture: fixture.name,
        category:
          error instanceof OpenAIClassifierError ? error.category : "provider_or_transport_error",
      });
      break;
    }
  }

  const disagreements = results.filter((result) => result.agrees === false);
  const estimatedCostUsd = usageKnown
    ? (inputTokens * INPUT_USD_PER_MILLION + outputTokens * OUTPUT_USD_PER_MILLION) / 1_000_000
    : null;
  console.log(
    `LIVE_SEMANTIC_EVALUATION ${JSON.stringify({
      provider: "openai",
      model: environment.AUTERIM_CLASSIFIER_MODEL,
      endpoint: "Responses API",
      calls: results.length + failures.length,
      results,
      disagreements,
      failures,
      usage: { inputTokens, outputTokens },
      estimatedCostUsd,
      estimateRatesUsdPerMillion: {
        input: INPUT_USD_PER_MILLION,
        output: OUTPUT_USD_PER_MILLION,
      },
      estimateBasis: "Published standard uncached rates; actual billing may differ.",
    })}`,
  );
  expect(failures).toEqual([]);
  expect(results).toHaveLength(fixtures.length);
}, 90_000);
