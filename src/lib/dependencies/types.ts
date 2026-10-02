export const dependencySourceTypes = [
  "pricing",
  "changelog",
  "documentation",
  "api",
  "deprecation",
  "terms",
  "limits",
  "status",
  "announcement",
] as const;

export type SourceType = (typeof dependencySourceTypes)[number];
export type ImpactSeverity = "low" | "medium" | "high" | "critical";

export interface Dependency {
  id: string;
  name: string;
  websiteUrl: string;
}

export interface DependencySource {
  id: string;
  dependencyId: string;
  type: SourceType;
  url: string;
}

export interface SourceChange {
  id: string;
  sourceId: string;
  detectedAt: string;
  summary: string;
}
