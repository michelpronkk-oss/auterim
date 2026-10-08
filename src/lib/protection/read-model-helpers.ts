type TerminalPreflight = {
  impact_assessment_id: string;
  status: string;
  created_at: string;
  id: string;
};

export function latestTerminalPreflightRuns<T extends TerminalPreflight>(runs: T[]) {
  const ordered = [...runs].sort(
    (left, right) =>
      right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
  );
  const latest = new Map<string, T>();
  for (const run of ordered) {
    if (
      (run.status === "completed" || run.status === "partial") &&
      !latest.has(run.impact_assessment_id)
    ) {
      latest.set(run.impact_assessment_id, run);
    }
  }
  return latest;
}

export function latestPreflightRuns<T extends TerminalPreflight & { status: string }>(runs: T[]) {
  const ordered = [...runs].sort(
    (left, right) =>
      right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
  );
  const latest = new Map<string, T>();
  for (const run of ordered) {
    if (!latest.has(run.impact_assessment_id)) latest.set(run.impact_assessment_id, run);
  }
  return latest;
}

export function latestVerifiedPreflightRuns<
  T extends TerminalPreflight & { status: string; verified_impact: string | null },
>(runs: T[]) {
  const ordered = [...runs].sort(
    (left, right) =>
      right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
  );
  const latest = new Map<string, T>();
  for (const run of ordered) {
    if (
      (run.status === "completed" || run.status === "partial") &&
      run.verified_impact === "verified" &&
      !latest.has(run.impact_assessment_id)
    ) {
      latest.set(run.impact_assessment_id, run);
    }
  }
  return latest;
}

export function monitoringEvidenceState(input: {
  monitoringEnabled: boolean;
  enabledSourceCount: number;
  sourcesWithBaseline: number;
  latestScanStatus: string | null;
}) {
  if (!input.monitoringEnabled) return "disabled" as const;
  if (input.enabledSourceCount === 0) return "coverage_missing" as const;
  if (input.latestScanStatus === "failed") return "scan_failed" as const;
  if (input.sourcesWithBaseline < input.enabledSourceCount) return "baseline_incomplete" as const;
  return "monitoring_evidence_available" as const;
}

export function latestObservationOutcome(
  enabledSourceCount: number,
  observations: Array<{ scan_status: string | null }>,
) {
  if (enabledSourceCount === 0) return "not_applicable" as const;
  if (observations.length < enabledSourceCount) return "partial_observation" as const;
  if (observations.every((item) => item.scan_status === null)) return "not_observed" as const;
  if (observations.some((item) => item.scan_status === null)) return "partial_observation" as const;
  if (observations.some((item) => item.scan_status === "failed"))
    return "partial_or_latest_failure" as const;
  return "latest_observations_succeeded" as const;
}

type DependencyScan = { source_id: string; finished_at: string | null; status: string | null };

export function latestDependencyScan<T extends DependencyScan>(scans: T[], sourceIds: Set<string>) {
  return [...scans]
    .filter((scan) => sourceIds.has(scan.source_id))
    .sort(
      (left, right) =>
        (right.finished_at ?? "").localeCompare(left.finished_at ?? "") ||
        right.source_id.localeCompare(left.source_id),
    )[0];
}
