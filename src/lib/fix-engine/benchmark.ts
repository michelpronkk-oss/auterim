export type FixBenchmarkOutcome = {
  semanticCorrect: boolean;
  targetedTestsPassed: boolean;
  typecheckPassed: boolean;
  buildPassed: boolean;
  changedFiles: number;
  allowedFiles: number;
  forbiddenEdits: number;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicrousd: number | null;
};

export type FixBenchmarkFixture = {
  id: string;
  family: "endpoint" | "sdk" | "signature" | "package" | "schema" | "auth";
  baseSha: string;
  allowedPaths: string[];
  expectedBehavior: string;
  sourceFiles: Array<{ path: string; content: string }>;
  testFiles: Array<{ path: string; content: string }>;
};

export type FixBenchmarkProviderResult = {
  provider: string;
  model: string;
  outcomes: Array<{ fixtureId: string; result: FixBenchmarkOutcome }>;
};

export function scoreFixBenchmark(result: FixBenchmarkProviderResult) {
  const total = result.outcomes.length;
  if (total === 0 || new Set(result.outcomes.map((entry) => entry.fixtureId)).size !== total)
    throw new Error("fix_benchmark_fixture_identity_invalid");
  const average = (selector: (entry: FixBenchmarkOutcome) => number) =>
    result.outcomes.reduce((sum, entry) => sum + selector(entry.result), 0) / total;
  return {
    provider: result.provider,
    model: result.model,
    fixtureCount: total,
    patchSemanticCorrectRate: average((entry) => Number(entry.semanticCorrect)),
    targetedTestPassRate: average((entry) => Number(entry.targetedTestsPassed)),
    typecheckPassRate: average((entry) => Number(entry.typecheckPassed)),
    buildPassRate: average((entry) => Number(entry.buildPassed)),
    minimalDiffRatio: average((entry) =>
      entry.allowedFiles === 0
        ? 0
        : Math.min(entry.changedFiles, entry.allowedFiles) / entry.allowedFiles,
    ),
    forbiddenEditRate: average((entry) => Number(entry.forbiddenEdits > 0)),
    medianLatencyMs: median(result.outcomes.map((entry) => Math.max(0, entry.result.latencyMs))),
    totalInputTokens: sumNullable(result.outcomes.map((entry) => entry.result.inputTokens)),
    totalOutputTokens: sumNullable(result.outcomes.map((entry) => entry.result.outputTokens)),
    totalCostMicrousd: sumNullable(result.outcomes.map((entry) => entry.result.costMicrousd)),
  };
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function sumNullable(values: Array<number | null>) {
  return values.every((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}
