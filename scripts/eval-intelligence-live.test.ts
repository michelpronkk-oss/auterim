import { loadEnvConfig } from "@next/env";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildIntelligenceEvidence,
  measureEvidenceQuality,
} from "../src/lib/intelligence/evidence";
import {
  INTELLIGENCE_CALIBRATION_FIXTURE_IDS,
  INTELLIGENCE_GOLDEN_FIXTURES,
  INTELLIGENCE_HOLDOUT_FIXTURE_IDS,
} from "../src/lib/intelligence/golden-fixtures";
import { applyIntelligencePolicy, type PolicyThresholds } from "../src/lib/intelligence/policy";
import type {
  IntelligenceProbabilities,
  IntelligenceRoute,
} from "../src/lib/intelligence/taxonomy";
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

function fixtureChange(item: (typeof INTELLIGENCE_GOLDEN_FIXTURES)[number]) {
  const providerExamples: Record<string, string> = {
    "deprecation-retirement": "OpenAI",
    "endpoint-removal": "Vercel",
    "breaking-api-behavior": "GitHub",
    "authentication-scope": "Supabase",
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

function splitByIds(ids: readonly string[]) {
  const selected = new Set(ids);
  return INTELLIGENCE_GOLDEN_FIXTURES.filter((item) => selected.has(item.id));
}

function assertExplicitSplit() {
  const allIds = INTELLIGENCE_GOLDEN_FIXTURES.map((item) => item.id);
  const calibrationIds = new Set<string>(INTELLIGENCE_CALIBRATION_FIXTURE_IDS);
  const holdoutIds = new Set<string>(INTELLIGENCE_HOLDOUT_FIXTURE_IDS);
  if (
    new Set(allIds).size !== allIds.length ||
    calibrationIds.size !== INTELLIGENCE_CALIBRATION_FIXTURE_IDS.length ||
    holdoutIds.size !== INTELLIGENCE_HOLDOUT_FIXTURE_IDS.length ||
    [...calibrationIds].some((id) => holdoutIds.has(id)) ||
    allIds.some((id) => !calibrationIds.has(id) && !holdoutIds.has(id)) ||
    [...calibrationIds, ...holdoutIds].some((id) => !allIds.includes(id))
  ) {
    throw new Error("stratified_split_ids_invalid");
  }
  for (const split of [
    splitByIds(INTELLIGENCE_CALIBRATION_FIXTURE_IDS),
    splitByIds(INTELLIGENCE_HOLDOUT_FIXTURE_IDS),
  ]) {
    const routes = new Set(split.map((item) => item.expected.route));
    const has = (predicate: (item: (typeof split)[number]) => boolean) => split.some(predicate);
    if (
      split.length !== 32 ||
      !has((item) => item.expected.material && item.expected.critical) ||
      !has((item) => item.expected.material && !item.expected.critical) ||
      !has((item) => item.expected.docsNoise) ||
      !has((item) => !item.expected.evidenceSufficient) ||
      !has((item) => item.diffText.length > 4_000) ||
      !has((item) => item.id.includes("injection")) ||
      [
        "docs_noise",
        "deprecation",
        "breaking_api_change",
        "auth_or_security_change",
        "schema_or_contract_change",
        "limits_or_quota_change",
        "pricing_change",
        "uncertain",
      ].some((route) => !routes.has(route as never))
    ) {
      throw new Error("stratified_split_route_missing");
    }
  }
}

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
    assertExplicitSplit();
    const calibrationFixtures = splitByIds(INTELLIGENCE_CALIBRATION_FIXTURE_IDS);
    const holdoutFixtures = splitByIds(INTELLIGENCE_HOLDOUT_FIXTURE_IDS);
    const predictions: Array<{
      id: string;
      expected: (typeof INTELLIGENCE_GOLDEN_FIXTURES)[number]["expected"];
      quality: ReturnType<typeof measureEvidenceQuality>;
      prediction: EnginePrediction;
      route: string;
      confidence: number;
      responseModel: string;
      probabilities: Record<string, number>;
      usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
    }> = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < INTELLIGENCE_GOLDEN_FIXTURES.length) {
        const index = cursor++;
        const item = INTELLIGENCE_GOLDEN_FIXTURES[index]!;
        const change = fixtureChange(item);
        try {
          const evidence = buildIntelligenceEvidence(change);
          const judgment = await requestJevDecision(evidence);
          predictions[index] = {
            id: item.id,
            expected: item.expected,
            quality: evidence.quality,
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
      costUsd: number | null;
      latencyMs: number;
      inputTokens: number | null;
      outputTokens: number | null;
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
          costUsd: judgment.costUsd,
          latencyMs: judgment.latencyMs,
          inputTokens: judgment.inputTokens,
          outputTokens: judgment.outputTokens,
        });
      }
    };
    await Promise.all([replayWorker(), replayWorker()]);

    const byId = new Map(predictions.map((row) => [row.id, row]));
    const calibration = calibrationFixtures.map((item) => byId.get(item.id)!);
    const holdout = holdoutFixtures.map((item) => byId.get(item.id)!);
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
    const docsNoiseThreshold = derivePositiveClassThreshold(
      calibration.filter((row) => row.expected.docsNoise).map((row) => row.probabilities.docsNoise),
    );
    const policyThresholds: PolicyThresholds = {
      material: materialThreshold ?? 1,
      criticalChange: criticalThreshold ?? 1,
      evidenceSufficient: evidenceThreshold ?? 1,
      docsNoise: docsNoiseThreshold ?? 1,
      requiresEscalation: escalationThreshold ?? 1,
      routeConfidence:
        derivePositiveClassThreshold(
          calibration
            .filter((row) => row.expected.route !== "uncertain")
            .map((row) => row.confidence),
        ) ?? 0.7,
      calibrationFixtureCount: calibration.length,
      calibrationVersion: "m1575a-stratified-64-v2",
    };
    const heldoutEvaluated = holdout.map((row) => {
      const routeProbabilities = Object.fromEntries(
        INTELLIGENCE_GOLDEN_FIXTURES.map((fixture) => [fixture.expected.route, 0]),
      ) as IntelligenceProbabilities["route"];
      routeProbabilities[row.route as IntelligenceRoute] = row.confidence;
      const probabilities: IntelligenceProbabilities = {
        material: row.probabilities.material,
        criticalChange: row.probabilities.critical,
        evidenceSufficient: row.probabilities.evidenceSufficient,
        docsNoise: row.probabilities.docsNoise,
        requiresEscalation: row.probabilities.escalation,
        route: routeProbabilities,
      };
      const rawPrediction: EnginePrediction = {
        ...row.prediction,
        material: probabilities.material >= policyThresholds.material,
        critical: probabilities.criticalChange >= policyThresholds.criticalChange,
        evidenceInsufficient:
          probabilities.evidenceSufficient < policyThresholds.evidenceSufficient,
        escalation: probabilities.requiresEscalation >= policyThresholds.requiresEscalation,
      };
      const judgment = {
        route: row.route as IntelligenceRoute,
        confidence: row.confidence,
        probabilities,
      };
      const policy = applyIntelligencePolicy({
        classifier: null,
        judgment,
        evidenceQuality: row.quality,
        thresholds: policyThresholds,
      });
      return { ...row, rawPrediction, policy, judgment };
    });
    const rawMetrics = summarizeReliability(
      heldoutEvaluated.map((row) => ({ expected: row.expected, prediction: row.rawPrediction })),
    );
    const count = (predicate: (row: (typeof heldoutEvaluated)[number]) => boolean) =>
      heldoutEvaluated.filter(predicate).length;
    const criticalRows = heldoutEvaluated.filter((row) => row.expected.critical);
    const criticalIncompleteRows = criticalRows.filter(
      (row) => row.quality.sourceCriticality === "critical" && row.quality.incomplete,
    );
    const docsNoiseSuppressed = heldoutEvaluated.filter(
      (row) => row.expected.docsNoise && row.policy.state === "suppress_candidate",
    );
    const allSuppressed = heldoutEvaluated.filter(
      (row) => row.policy.state === "suppress_candidate",
    );
    const dangerousSuppressionFalseNegatives = count(
      (row) =>
        (row.expected.material || row.expected.critical) &&
        row.policy.state === "suppress_candidate",
    );
    const criticalProtected = criticalRows.filter((row) =>
      ["continue_candidate", "escalate", "insufficient_evidence"].includes(row.policy.state),
    ).length;
    const criticalIncompleteCaught = criticalIncompleteRows.filter(
      (row) => row.policy.state === "insufficient_evidence",
    ).length;
    const routeConfusion = Object.fromEntries(
      [...new Set(heldoutEvaluated.map((row) => row.expected.route))].sort().map((route) => {
        const matching = heldoutEvaluated.filter((row) => row.expected.route === route);
        return [
          route,
          {
            count: matching.length,
            correct: matching.filter((row) => row.route === route).length,
            accuracy: matching.length
              ? matching.filter((row) => row.route === route).length / matching.length
              : null,
            predicted: Object.fromEntries(
              [...new Set(heldoutEvaluated.map((row) => row.route))]
                .sort()
                .map((predicted) => [
                  predicted,
                  matching.filter((row) => row.route === predicted).length,
                ]),
            ),
          },
        ];
      }),
    );
    const policyMetrics = {
      labeledCount: holdout.length,
      stateCounts: Object.fromEntries(
        ["suppress_candidate", "continue_candidate", "escalate", "insufficient_evidence"].map(
          (state) => [state, count((row) => row.policy.state === state)],
        ),
      ),
      dangerousSuppressionFalseNegatives,
      criticalProtectionCoverage: criticalRows.length
        ? criticalProtected / criticalRows.length
        : null,
      criticalIncompleteEvidenceCoverage: criticalIncompleteRows.length
        ? criticalIncompleteCaught / criticalIncompleteRows.length
        : null,
      docsNoiseSuppressionPrecision: allSuppressed.length
        ? docsNoiseSuppressed.length / allSuppressed.length
        : null,
      docsNoiseMaterialFalseSuppressions: count(
        (row) =>
          row.expected.material &&
          row.route === "docs_noise" &&
          row.policy.state === "suppress_candidate",
      ),
      unnecessaryEscalationRate: heldoutEvaluated.filter(
        (row) => !row.expected.material && !row.expected.critical,
      ).length
        ? heldoutEvaluated.filter(
            (row) =>
              !row.expected.material &&
              !row.expected.critical &&
              !row.expected.escalation &&
              row.policy.state === "escalate",
          ).length /
          heldoutEvaluated.filter((row) => !row.expected.material && !row.expected.critical).length
        : null,
      heldoutPolicyOutcomes: heldoutEvaluated.map((row) => ({
        id: row.id,
        expectedRoute: row.expected.route,
        state: row.policy.state,
        reason: row.policy.reason,
      })),
    };
    const highRiskRoutes = new Set([
      "deprecation",
      "breaking_api_change",
      "auth_or_security_change",
      "schema_or_contract_change",
      "webhook_or_event_change",
      "limits_or_quota_change",
    ]);
    const highRiskRouteCollapse = Object.entries(routeConfusion).filter(
      ([route, metric]) =>
        highRiskRoutes.has(route) && (metric as { accuracy: number | null }).accuracy === 0,
    );
    const activeRoutingGate = {
      dangerousSuppressionFalseNegatives: dangerousSuppressionFalseNegatives === 0,
      criticalProtectionCoverage:
        criticalRows.length > 0 && criticalProtected === criticalRows.length,
      docsNoiseNoMaterialFalseSuppression: policyMetrics.docsNoiseMaterialFalseSuppressions === 0,
      criticalIncompleteEvidenceCatch:
        criticalIncompleteRows.length > 0 &&
        criticalIncompleteCaught === criticalIncompleteRows.length,
      noHighRiskRouteCollapse: highRiskRouteCollapse.length === 0,
    };
    const criticalFalseNegativeDiagnostics = heldoutEvaluated
      .filter((row) => row.expected.critical && !row.rawPrediction.critical)
      .map((row) => ({
        fixtureId: row.id,
        expectedRoute: row.expected.route,
        jevRoute: row.route,
        materialProbability: row.probabilities.material,
        criticalProbability: row.probabilities.critical,
        evidenceSufficientProbability: row.probabilities.evidenceSufficient,
        docsNoiseProbability: row.probabilities.docsNoise,
        escalationProbability: row.probabilities.escalation,
        evidenceQualityIncomplete: row.quality.incomplete,
        finalPolicyState: row.policy.state,
        finalPolicyReason: row.policy.reason,
      }));
    const totalUsage = predictions.reduce(
      (sum, row) => ({
        inputTokens: sum.inputTokens + (row.usage.inputTokens ?? 0),
        outputTokens: sum.outputTokens + (row.usage.outputTokens ?? 0),
        costUsd: sum.costUsd + (row.usage.costUsd ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    );
    for (const row of historicalJudgments) {
      totalUsage.inputTokens += row.inputTokens ?? 0;
      totalUsage.outputTokens += row.outputTokens ?? 0;
      totalUsage.costUsd += row.costUsd ?? 0;
    }
    const liveDecisionCount = predictions.length + historicalJudgments.length;
    const reportedCostCount =
      predictions.filter((row) => row.usage.costUsd !== null).length +
      historicalJudgments.filter((row) => row.costUsd !== null).length;
    const report = JSON.stringify({
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
      calibrationCount: calibration.length,
      holdoutCount: holdout.length,
      splitVersion: "explicit-stratified-64-v2",
      splitPass: true,
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
        note: "agreement is not accuracy; historical rows have no independent gold labels",
      },
      classifierMetrics: {
        sameGoldCorpusEvaluated: false,
        reason:
          "would require additional live classifier calls not authorized by this Jev-only budget",
        historicalClassifiedRows: historicalRows.filter((row) => row.classifier_material !== null)
          .length,
        historicalGoldLabels: 0,
      },
      rawJev: {
        heldoutMetrics: rawMetrics,
        perRouteConfusion: routeConfusion,
        thresholdsDerivedFromCalibration: {
          material: materialThreshold,
          critical: criticalThreshold,
          evidenceSufficient: evidenceThreshold,
          docsNoise: docsNoiseThreshold,
          escalation: escalationThreshold,
        },
        currentCriticalFalseNegativeDiagnostics: criticalFalseNegativeDiagnostics,
      },
      auterimPolicy: {
        thresholds: policyThresholds,
        metrics: policyMetrics,
        activeRoutingGate,
        activeRoutingReady: Object.values(activeRoutingGate).every(Boolean),
        classifierMode:
          "Jev-only policy evaluation; classifier unavailable for this corpus without additional live requests",
      },
      liveJevDecisionCount: liveDecisionCount,
      liveFixtureDecisionCount: predictions.length,
      liveHistoricalDecisionCount: historicalJudgments.length,
      totalUsage,
      reportedCostCount,
      costPerThousandUsd:
        reportedCostCount === liveDecisionCount
          ? (totalUsage.costUsd / liveDecisionCount) * 1000
          : null,
      meanLatencyMs:
        [
          ...predictions.map((row) => row.prediction.latencyMs ?? 0),
          ...historicalJudgments.map((row) => row.latencyMs),
        ].reduce((sum, value) => sum + value, 0) / liveDecisionCount,
    });
    const reportPath = join(
      process.cwd(),
      "node_modules",
      ".cache",
      "auterim",
      "intelligence-live-eval.json",
    );
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${report}\n`, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(`${report}\n`);
    expect(predictions).toHaveLength(64);
    expect(calibration).toHaveLength(32);
    expect(holdout).toHaveLength(32);
    expect(liveDecisionCount).toBeLessThanOrEqual(100);
  }, 180_000);
});
