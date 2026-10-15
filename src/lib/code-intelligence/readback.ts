import type { CoverageState } from "@/lib/code-intelligence/analyzer";

export const CODE_ANALYSIS_READBACK_ID = "92aa86be-a449-4677-a672-88421f203b4f";
export const CODE_ANALYSIS_READBACK_COMMIT = "6165f30d4e0c9a37bd7f2cd7579aaaa76d2bfdcc";
export const CODE_ANALYSIS_READBACK_WORKSPACE = "e140d48e-9dc0-4552-a9a4-a81fe3872422";
export const CODE_ANALYSIS_READBACK_REPOSITORY = "3b4f4fe6-cbbd-4bbd-a340-71f7c268e2c4";
export const CODE_ANALYSIS_READBACK_PRODUCT = "de1f2a12-de3c-4644-8892-b6c2d458a300";

export const EXTERNAL_REFERENCE_TYPES = [
  "package",
  "import",
  "sdk_call",
  "event",
  "endpoint",
  "dynamic_endpoint",
  "environment_variable",
  "schema",
] as const;

export const RELATION_TYPES = [
  "FILE_CONTAINS_SYMBOL",
  "IMPORTS_PACKAGE",
  "IMPORTS_SYMBOL",
  "CALLS_SYMBOL",
  "REFERENCES_EXTERNAL",
  "USES_ENV_NAME",
  "HANDLES_EVENT",
  "CALLS_ENDPOINT",
  "REFERENCES_SCHEMA",
] as const;

export function isSafeReadbackPath(value: string) {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
    /^[A-Za-z0-9_@.\-/]+$/.test(value)
  );
}

function resemblesCredential(value: string) {
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/i.test(
      value,
    ) ||
    /\bBearer\s+\S+/i.test(value) ||
    /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value)
  )
    return true;
  const trimmed = value.trim();
  if (trimmed.length < 28 || !/^[A-Za-z0-9_-]+$/.test(trimmed)) return false;
  const alphabet = new Set(trimmed).size;
  return alphabet >= 16 && alphabet / trimmed.length > 0.45;
}

export function persistedCredentialLikeValueCount(values: string[]) {
  return values.filter(resemblesCredential).length;
}

export function safeReadbackValue(type: string, value: string): string | null {
  if (!value || value.length > 512 || resemblesCredential(value)) return null;
  switch (type) {
    case "package":
      return /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+@[~^<>=*xX0-9A-Za-z.+|:, -]{1,80}$/.test(value)
        ? value
        : null;
    case "import":
      return /^[A-Za-z0-9@._/-]{1,240}$/.test(value) ? value : null;
    case "sdk_call":
      return /^[A-Za-z0-9@._/$-]+(?:\.[A-Za-z0-9_$-]+)+$/.test(value) ? value : null;
    case "event":
      return /^[A-Za-z0-9_.:-]{3,160}$/.test(value) ? value : null;
    case "endpoint": {
      try {
        const url = new URL(value);
        if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password)
          return null;
        return `${url.origin}${url.pathname}`.slice(0, 512);
      } catch {
        return null;
      }
    }
    case "dynamic_endpoint":
      return value === "[dynamic]" ? value : null;
    case "environment_variable":
      return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value) ? value : null;
    case "schema":
      return /^[A-Za-z_$][A-Za-z0-9_$.]{0,159}$/.test(value) ? value : null;
    default:
      return null;
  }
}

export function safeSourceSpanMatch(
  referenceType: string,
  normalizedValue: string,
  path: string,
  source: string,
  startLine: number,
  endLine: number,
) {
  if (
    !isSafeReadbackPath(path) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine - startLine > 100
  )
    return false;
  const lines = source.split(/\r?\n/);
  const span = lines.slice(startLine - 1, endLine).join("\n");
  if (!span) return false;
  switch (referenceType) {
    case "package":
      if (path !== "package.json") return false;
      const packageDelimiter = normalizedValue.lastIndexOf("@");
      const packageName = normalizedValue.slice(0, packageDelimiter);
      return packageDelimiter > 0 && source.includes(JSON.stringify(packageName));
    case "import":
      return source.includes(normalizedValue);
    case "sdk_call": {
      const memberPath = normalizedValue.split(".").slice(1).join(".");
      return Boolean(memberPath) && span.includes(memberPath);
    }
    case "event":
      return span.includes(normalizedValue);
    case "endpoint": {
      try {
        const url = new URL(normalizedValue);
        return span.includes(url.hostname) || span.includes(url.pathname);
      } catch {
        return false;
      }
    }
    case "dynamic_endpoint":
      return /\bfetch\s*\(|\baxios\s*\(|\.request\s*\(/.test(span);
    case "environment_variable":
      return new RegExp(
        `process\\s*\\.\\s*env\\s*(?:\\.\\s*${normalizedValue}\\b|\\[\\s*[\"']${normalizedValue}[\"']\\s*\\])`,
      ).test(span);
    case "schema":
      return span.includes(normalizedValue.split(".").at(-1) ?? normalizedValue);
    default:
      return false;
  }
}

export function histogram<T extends Record<string, unknown>>(rows: T[], key: keyof T) {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = row[key];
    if (typeof value === "string") counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

export function classifySkipReason(reason: string, path: string) {
  const extension = path.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  const supported = new Set([".js", ".jsx", ".cjs", ".mjs", ".ts", ".tsx", ".cts", ".mts"]);
  const sourcePath = supported.has(extension);
  if (reason === "environment_file_excluded") return "EXPECTED_SECURITY_SKIP" as const;
  if (reason === "binary_or_non_source") return "EXPECTED_NON_SOURCE_SKIP" as const;
  if (reason === "unsupported_language") return "UNSUPPORTED_LANGUAGE_GAP" as const;
  if (reason === "parse_failed" || reason === "manifest_parse_failed")
    return "PARSE_COVERAGE_GAP" as const;
  if (
    [
      "file_count_limit",
      "parse_time_budget",
      "file_size_limit",
      "repository_byte_limit",
      "manifest_size_limit",
      "lockfile_size_limit",
      "traversal_entry_limit",
      "fact_count_limit",
    ].includes(reason)
  )
    return sourcePath
      ? ("SUPPORTED_SOURCE_COVERAGE_GAP" as const)
      : ("RESOURCE_BOUND_COVERAGE_GAP" as const);
  if (reason.startsWith("generated_directory:")) return "OTHER_INCOMPLETE" as const;
  if (reason === "generated_or_minified")
    return sourcePath
      ? ("SUPPORTED_SOURCE_COVERAGE_GAP" as const)
      : ("EXPECTED_NON_SOURCE_SKIP" as const);
  return "OTHER_INCOMPLETE" as const;
}

export function assessPartialCauses(reasons: Array<{ reason: string; path: string }>) {
  const counts = new Map<string, { reason: string; count: number; classification: string }>();
  for (const entry of reasons) {
    const classification = classifySkipReason(entry.reason, entry.path);
    const key = `${entry.reason}\0${classification}`;
    const current = counts.get(key) ?? { reason: entry.reason, count: 0, classification };
    current.count += 1;
    counts.set(key, current);
  }
  const causes = [...counts.values()].sort(
    (a, b) => b.count - a.count || a.reason.localeCompare(b.reason),
  );
  const sourceBounds = new Set([
    "file_count_limit",
    "parse_time_budget",
    "file_size_limit",
    "repository_byte_limit",
    "traversal_entry_limit",
    "fact_count_limit",
  ]);
  return {
    causes,
    partialPrimary: causes[0]?.reason ?? "no persisted skip reason explains partial coverage",
    supportedSourceSkippedByBounds: reasons.filter(
      ({ reason, path }) =>
        sourceBounds.has(reason) &&
        classifySkipReason(reason, path) === "SUPPORTED_SOURCE_COVERAGE_GAP",
    ).length,
    supportedSourceSkipped: reasons.filter(
      ({ reason, path }) =>
        classifySkipReason(reason, path) === "SUPPORTED_SOURCE_COVERAGE_GAP" &&
        !sourceBounds.has(reason),
    ).length,
  };
}

export type PersistedReadbackRun = {
  id: string;
  workspace_id: string;
  repository_id: string;
  product_id: string | null;
  commit_sha: string;
  status: string;
  coverage_state: CoverageState;
  files_discovered: number;
  files_analyzed: number;
  files_skipped: number;
  parse_failures: number;
  bytes_analyzed: number;
  analyzer_version: string;
  language_profile: string;
  analysis_profile: string;
};
