export type FixMetricName =
  | "fix_runs"
  | "stage_outcomes"
  | "diagnosis"
  | "plan"
  | "patch_generation"
  | "patch_apply"
  | "verification"
  | "preflight"
  | "risk"
  | "pr_provider"
  | "latency_ms"
  | "model_tokens"
  | "model_cost_microusd"
  | "retry_count"
  | "stale_base"
  | "cleanup_failure";
export type FixMetricLabels = {
  stage?: string;
  outcome?: string;
  risk?: string;
  provider?: string;
};

const allowedStages = new Set([
  "diagnose",
  "plan",
  "generate_patch",
  "apply_patch",
  "verify_patch",
  "preflight",
  "risk_assess",
  "create_draft_pr",
]);
const allowedOutcomes = new Set([
  "success",
  "failure",
  "blocked",
  "unsupported",
  "retry",
  "ambiguous",
]);
const allowedRisks = new Set(["LOW", "MEDIUM", "HIGH", "BLOCKED"]);

export interface FixMetricsSink {
  observe(name: FixMetricName, value: number, labels: FixMetricLabels): void;
}

export function recordFixMetric(
  sink: FixMetricsSink,
  name: FixMetricName,
  value: number,
  labels: FixMetricLabels = {},
) {
  if (!Number.isFinite(value) || value < 0) return;
  const safe: FixMetricLabels = {};
  if (labels.stage && allowedStages.has(labels.stage)) safe.stage = labels.stage;
  if (labels.outcome && allowedOutcomes.has(labels.outcome)) safe.outcome = labels.outcome;
  if (labels.risk && allowedRisks.has(labels.risk)) safe.risk = labels.risk;
  if (labels.provider && /^[a-z0-9_-]{1,32}$/i.test(labels.provider))
    safe.provider = labels.provider;
  sink.observe(name, value, safe);
}

export class InMemoryFixMetrics implements FixMetricsSink {
  readonly samples: Array<{ name: FixMetricName; value: number; labels: FixMetricLabels }> = [];
  observe(name: FixMetricName, value: number, labels: FixMetricLabels) {
    this.samples.push({ name, value, labels: { ...labels } });
  }
}
