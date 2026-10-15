import { loadEnvConfig } from "@next/env";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildIntelligenceEvidence } from "../src/lib/intelligence/evidence";
import { INTELLIGENCE_GOLDEN_FIXTURES } from "../src/lib/intelligence/golden-fixtures";
import {
  deriveIncompleteEvidenceThreshold,
  derivePositiveClassThreshold,
  deriveZeroCriticalFalseNegativeThreshold,
  summarizeReliability,
  type EnginePrediction,
} from "../src/lib/intelligence/replay";
import { requestJevDecision } from "../src/lib/intelligence/jev";
import { getEnvironment, isIntegrationConfigured } from "../src/lib/env/schema";

// Vitest sets NODE_ENV=test, where Next deliberately ignores .env.local.
// Load only the required server-only key for this explicitly invoked local eval;
// env:check remains the source for safe configuration-presence reporting.
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
    // The live eval reports the safe not-configured state below.
  }
}

type HistoricalRow = {
  id: string;
  source_name: string;
  source_type: string;
  dependency_name: string;
  before_version: number;
  after_version: number;
  diff_text: string;
  added_lines: number;
  removed_lines: number;
  diff_truncated: boolean;
  previous_bytes: number;
  new_bytes: number;
  classifier_material: boolean | null;
  classifier_category: string | null;
  classifier_confidence: number | null;
  classifier_decision_status: "classified" | "review_required" | null;
};

function readLocalHistoricalRows(): HistoricalRow[] {
  const root = "C:\\Users\\miche\\Desktop\\Auterim";
  if (process.cwd().toLowerCase() !== root.toLowerCase())
    throw new Error("auterim_workdir_required");
  const context = spawnSync("docker", ["context", "show"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (context.status !== 0 || context.stdout.trim() !== "desktop-linux")
    throw new Error("local_docker_context_required");
  const identity = spawnSync(
    "docker",
    ["inspect", "--format", "{{.Name}}", "supabase_db_auterim-m15-acceptance"],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  if (identity.status !== 0 || identity.stdout.trim() !== "/supabase_db_auterim-m15-acceptance")
    throw new Error("local_auterim_history_database_required");
  const sql = `select coalesce(json_agg(to_jsonb(rows)), '[]'::json)::text from (
    select ch.id, src.name as source_name, src.source_type, dep.name as dependency_name,
      old_snapshot.version as before_version, new_snapshot.version as after_version,
      ch.diff_text, ch.added_lines, ch.removed_lines, ch.diff_truncated,
      ch.previous_bytes, ch.new_bytes, cls.material as classifier_material,
      cls.category as classifier_category, cls.confidence as classifier_confidence,
      cls.decision_status as classifier_decision_status
    from public.source_changes ch
    join public.source_catalog src on src.id=ch.source_id
    join public.dependency_catalog dep on dep.id=src.dependency_id
    join public.source_snapshots old_snapshot on old_snapshot.id=ch.previous_snapshot_id
    join public.source_snapshots new_snapshot on new_snapshot.id=ch.new_snapshot_id
    left join lateral (select c.material,c.category,c.confidence,c.decision_status
      from public.source_change_classifications c where c.change_id=ch.id and c.status='classified'
      order by c.classified_at desc limit 1) cls on true
    order by ch.created_at desc, ch.id limit 25
  ) rows;`;
  const result = spawnSync(
    "docker",
    [
      "exec",
      "supabase_db_auterim-m15-acceptance",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-Atc",
      sql,
    ],
    { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 512 * 1024 },
  );
  if (result.status !== 0) throw new Error("local_historical_replay_read_failed");
  try {
    return JSON.parse(result.stdout.trim() || "[]") as HistoricalRow[];
  } catch {
    throw new Error("local_historical_replay_shape_invalid");
  }
}

describe("M15.75A live Jev reliability eval", () => {
  it("evaluates static golden fixtures through the pinned Decisions API", async () => {
    if (process.env.RUN_INTELLIGENCE_LIVE !== "1")
      throw new Error("Set RUN_INTELLIGENCE_LIVE=1 for the one authorized live eval.");
    const environment = getEnvironment();
    if (!isIntegrationConfigured("intelligence", environment))
      throw new Error("Jev shadow integration is not configured.");
    const predictions: Array<{
      id: string;
      expected: (typeof INTELLIGENCE_GOLDEN_FIXTURES)[number]["expected"];
      prediction: EnginePrediction;
      route: string;
      confidence: number;
      responseModel: string;
      probabilities: Record<string, number>;
      usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
    }> = [];
    const providerExamples: Record<string, string> = {
      "deprecation-retirement": "OpenAI",
      "endpoint-removal": "Vercel",
      "breaking-api-behavior": "GitHub",
      "authentication-scope": "Supabase",
      "pricing-increase": "Stripe",
    };
    let cursor = 0;
    const worker = async () => {
      while (cursor < INTELLIGENCE_GOLDEN_FIXTURES.length) {
        const index = cursor++;
        const item = INTELLIGENCE_GOLDEN_FIXTURES[index]!;
        const change = {
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
        try {
          const judgment = await requestJevDecision(buildIntelligenceEvidence(change));
          predictions[index] = {
            id: item.id,
            expected: item.expected,
            prediction: {
              material: false,
              critical: false,
              route: judgment.route,
              evidenceInsufficient: false,
              escalation: false,
              latencyMs: judgment.latencyMs,
              costUsd: judgment.costUsd,
            },
            route: judgment.route,
            confidence: judgment.confidence,
            responseModel: judgment.responseModel,
            probabilities: {
              material: judgment.probabilities.material,
              critical: judgment.probabilities.criticalChange,
              evidenceSufficient: judgment.probabilities.evidenceSufficient,
              docsNoise: judgment.probabilities.docsNoise,
              escalation: judgment.probabilities.requiresEscalation,
            },
            usage: {
              inputTokens: judgment.inputTokens,
              outputTokens: judgment.outputTokens,
              costUsd: judgment.costUsd,
            },
          };
        } catch (error) {
          const category =
            error instanceof Error && "category" in error
              ? String(error.category)
              : "provider_error";
          throw new Error(`live_jev_fixture_failed:${item.id}:${category}`);
        }
      }
    };
    await Promise.all([worker(), worker()]);

    const historicalRows = readLocalHistoricalRows();
    let historicalCursor = 0;
    const historicalJudgments: Array<{
      classifierMaterial: boolean | null;
      jevMaterial: number;
      route: string;
    }> = [];
    const replayWorker = async () => {
      while (historicalCursor < historicalRows.length) {
        const row = historicalRows[historicalCursor++]!;
        const evidence = buildIntelligenceEvidence({
          sourceName: row.source_name,
          sourceType: row.source_type,
          sourceUrl: "https://historical.local/source",
          dependencyName: row.dependency_name,
          beforeVersion: row.before_version,
          afterVersion: row.after_version,
          diffText: row.diff_text,
          addedLines: row.added_lines,
          removedLines: row.removed_lines,
          diffTruncated: row.diff_truncated,
          beforeBytes: row.previous_bytes,
          afterBytes: row.new_bytes,
        });
        const judgment = await requestJevDecision(evidence);
        historicalJudgments.push({
          classifierMaterial: row.classifier_material,
          jevMaterial: judgment.probabilities.material,
          route: judgment.route,
        });
      }
    };
    await Promise.all([replayWorker(), replayWorker()]);

    const calibration = predictions.slice(0, 16);
    const holdout = predictions.slice(16);
    const materialThreshold = deriveZeroCriticalFalseNegativeThreshold(
      calibration.map((row) => ({
        probability: row.probabilities.material,
        expected: row.expected,
      })),
    );
    const criticalThreshold = derivePositiveClassThreshold(
      calibration.filter((row) => row.expected.critical).map((row) => row.probabilities.critical),
    );
    const evidenceThreshold = deriveIncompleteEvidenceThreshold(
      calibration
        .filter((row) => !row.expected.evidenceSufficient)
        .map((row) => row.probabilities.evidenceSufficient),
    );
    const escalationThreshold = derivePositiveClassThreshold(
      calibration
        .filter((row) => row.expected.escalation)
        .map((row) => row.probabilities.escalation),
    );
    const heldoutAtCalibratedThreshold = holdout.map((row) => ({
      expected: row.expected,
      prediction: {
        ...row.prediction,
        material:
          materialThreshold === null ? false : row.probabilities.material >= materialThreshold,
        critical:
          criticalThreshold === null ? false : row.probabilities.critical >= criticalThreshold,
        evidenceInsufficient:
          evidenceThreshold === null
            ? false
            : row.probabilities.evidenceSufficient < evidenceThreshold,
        escalation:
          escalationThreshold === null
            ? false
            : row.probabilities.escalation >= escalationThreshold,
      },
    }));
    const metrics = summarizeReliability(heldoutAtCalibratedThreshold);
    const totalUsage = predictions.reduce(
      (sum, row) => ({
        inputTokens: sum.inputTokens + (row.usage.inputTokens ?? 0),
        outputTokens: sum.outputTokens + (row.usage.outputTokens ?? 0),
        costUsd: sum.costUsd + (row.usage.costUsd ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    );
    const reportedCostCount = predictions.filter((row) => row.usage.costUsd !== null).length;
    console.log(
      JSON.stringify({
        model: predictions[0]?.responseModel ?? "typesafe/jev-1.14",
        schema: [
          "choice:route",
          "noul:material",
          "noul:critical",
          "noul:evidence_sufficient",
          "noul:docs_noise",
          "noul:escalation",
        ],
        fixtureCount: predictions.length,
        historicalReplay: {
          count: historicalRows.length,
          currentClassifierCount: historicalRows.filter((row) => row.classifier_material !== null)
            .length,
          jevCount: historicalJudgments.length,
          materialAgreementAtMidpoint: historicalJudgments.filter(
            (row) =>
              row.classifierMaterial !== null && row.classifierMaterial === row.jevMaterial >= 0.5,
          ).length,
          materialDisagreementAtMidpoint: historicalJudgments.filter(
            (row) =>
              row.classifierMaterial !== null && row.classifierMaterial !== row.jevMaterial >= 0.5,
          ).length,
          labeledGoldCount: 0,
          classifierFalseNegatives: null,
          note: "agreement is not accuracy; historical rows have no independent gold labels, so classifier false-negative rate is not measurable",
        },
        classifierMetrics: {
          labeledGoldCount: 0,
          historicalClassifiedRows: historicalRows.filter((row) => row.classifier_material !== null)
            .length,
          materialFalseNegatives: null,
          criticalFalseNegatives: null,
          note: "false-negative metrics require independently labeled outcomes; historical classifier results are not gold labels",
        },
        providerExamples: Object.values(providerExamples),
        calibrationCount: calibration.length,
        heldoutCount: holdout.length,
        calibratedMaterialThreshold: materialThreshold,
        calibratedCriticalThreshold: criticalThreshold,
        calibratedEvidenceSufficientThreshold: evidenceThreshold,
        calibratedEscalationThreshold: escalationThreshold,
        heldoutMetrics: metrics,
        totalUsage,
        reportedCostCount,
        costPerThousandUsd:
          reportedCostCount === predictions.length
            ? (totalUsage.costUsd / predictions.length) * 1000
            : null,
        meanLatencyMs:
          predictions.reduce((sum, row) => sum + (row.prediction.latencyMs ?? 0), 0) /
          predictions.length,
        outcomes: predictions.map(({ id, route, confidence, probabilities }) => ({
          id,
          route,
          confidence,
          probabilities,
        })),
      }),
    );
    expect(predictions).toHaveLength(24);
  }, 180_000);
});
