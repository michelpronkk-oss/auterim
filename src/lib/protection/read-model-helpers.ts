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
