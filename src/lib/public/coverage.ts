export type EnabledSourceRow = { dependency_id: string; source_type: string };

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
