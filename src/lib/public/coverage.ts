export type EnabledSourceRow = { dependency_id: string; source_type: string };

export type CatalogCoverageStatus =
  "strong_coverage" | "partial_coverage" | "coverage_pending" | "coverage_unknown";

export function catalogCoverageStatus(
  sourceCount: number,
  sourceFamilies: number,
  partial = false,
): CatalogCoverageStatus {
  if (partial) return sourceCount > 0 ? "partial_coverage" : "coverage_unknown";
  if (sourceCount === 0) return "coverage_pending";
  return sourceFamilies >= 3 ? "strong_coverage" : "partial_coverage";
}

export function catalogCoverageLabel(status: CatalogCoverageStatus) {
  switch (status) {
    case "strong_coverage":
      return "strong source coverage";
    case "partial_coverage":
      return "partial source coverage";
    case "coverage_pending":
      return "coverage pending";
    case "coverage_unknown":
      return "coverage unknown";
  }
}

export function summarizeEnabledSources(rows: EnabledSourceRow[], exactTotal: number | null) {
  const sourceCounts = new Map<string, Map<string, number>>();
  for (const source of rows) {
    const categories = sourceCounts.get(source.dependency_id) ?? new Map<string, number>();
    categories.set(source.source_type, (categories.get(source.source_type) ?? 0) + 1);
    sourceCounts.set(source.dependency_id, categories);
  }
  const partial = (exactTotal ?? rows.length) > rows.length;
  return {
    partial,
    byDependency: new Map(
      [...sourceCounts].map(([dependencyId, categories]) => [
        dependencyId,
        {
          total: [...categories.values()].reduce((sum, count) => sum + count, 0),
          byType: Object.fromEntries(categories),
        },
      ]),
    ),
  };
}
