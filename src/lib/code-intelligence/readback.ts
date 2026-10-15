import type { CoverageState } from "@/lib/code-intelligence/analyzer";
import ts from "typescript";

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

export type RelationProvenanceEntity = {
  entity_type: string;
  name: string;
  path: string;
  start_line: number | null;
  end_line: number | null;
};

function targetDeclarationMatchesSource(input: {
  path: string;
  source: string;
  entityType: string;
  name: string;
  startLine: number;
  endLine: number;
}) {
  const { path, source, entityType, name, startLine, endLine } = input;
  const scriptKind = /\.tsx$/i.test(path)
    ? ts.ScriptKind.TSX
    : /\.jsx?$/i.test(path) || /\.[cm]js$/i.test(path)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  const stack: ts.Node[] = [parsed];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const nodeStartLine = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
    const nodeEndLine = parsed.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    if (nodeStartLine === startLine && nodeEndLine === endLine) {
      if (
        entityType === "class" &&
        ts.isClassDeclaration(node) &&
        node.name?.text === name
      )
        return true;
      if (
        entityType === "method" &&
        ts.isMethodDeclaration(node) &&
        node.name.getText(parsed) === name
      )
        return true;
      if (
        entityType === "function" &&
        ((ts.isFunctionDeclaration(node) && node.name?.text === name) ||
          ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
            ts.isVariableDeclaration(node.parent) &&
            ts.isIdentifier(node.parent.name) &&
            node.parent.name.text === name))
      )
        return true;
    }
    node.forEachChild((child) => {
      stack.push(child);
    });
  }
  return false;
}

export function relationEvidenceMatchesSource(input: {
  relationType: string;
  path: string;
  startLine: number;
  endLine: number;
  extractorType: string;
  from: RelationProvenanceEntity;
  to: RelationProvenanceEntity;
  matchingTargetDeclarations: number;
  source: string;
  matchingExternalReference: boolean;
}) {
  const { relationType, path, startLine, endLine, extractorType, from, to, source } = input;
  if (
    !isSafeReadbackPath(path) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine - startLine > 200 ||
    from.path !== path ||
    to.path !== path
  )
    return false;
  const lines = source.split(/\r?\n/);
  if (endLine > lines.length) return false;
  const span = lines.slice(startLine - 1, endLine).join("\n");
  if (!span) return false;
  switch (relationType) {
    case "FILE_CONTAINS_SYMBOL": {
      if (from.entity_type !== "file") return false;
      if (to.entity_type === "module")
        return to.name === path.replace(/\.[^.]+$/, "") && startLine === 1;
      return (
        to.start_line !== null &&
        to.end_line !== null &&
        to.start_line >= startLine &&
        to.end_line <= endLine &&
        lines
          .slice(to.start_line - 1, to.end_line)
          .join("\n")
          .includes(to.name)
      );
    }
    case "IMPORTS_PACKAGE": {
      const delimiter = to.name.lastIndexOf("@");
      const packageName = delimiter > 0 ? to.name.slice(0, delimiter) : to.name;
      if (from.entity_type === "import" && to.entity_type === "package_dependency")
        return Boolean(packageName) && span.includes(from.name) && span.includes(packageName);
      if (from.entity_type === "file" && to.entity_type === "schema_reference")
        return (
          extractorType === "typescript-compiler-api:import-reference-v1" &&
          Boolean(to.name) &&
          span.includes(to.name)
        );
      return false;
    }
    case "IMPORTS_SYMBOL": {
      const symbol = to.name.split("#").at(-1) ?? "";
      return (
        from.entity_type === "import" &&
        to.entity_type === "import" &&
        Boolean(symbol) &&
        span.includes(symbol)
      );
    }
    case "CALLS_SYMBOL": {
      if (
        from.path !== to.path ||
        !to.name ||
        !["function", "method", "class"].includes(to.entity_type) ||
        !["file", "module", "function", "method", "class"].includes(from.entity_type) ||
        input.matchingTargetDeclarations !== 1 ||
        from.start_line === null ||
        from.end_line === null ||
        to.start_line === null ||
        to.end_line === null ||
        from.start_line > startLine ||
        from.end_line < endLine ||
        extractorType !== "typescript-compiler-api:same-file-call-site-v2"
      )
        return false;
      const escaped = to.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const targetLines = lines.slice(to.start_line - 1, to.end_line).join("\n");
      return (
        targetLines.includes(to.name) &&
        targetDeclarationMatchesSource({
          path,
          source,
          entityType: to.entity_type,
          name: to.name,
          startLine: to.start_line,
          endLine: to.end_line,
        }) &&
        new RegExp(`\\b${escaped}\\s*\\(`).test(span)
      );
    }
    case "REFERENCES_EXTERNAL":
    case "USES_ENV_NAME":
    case "HANDLES_EVENT":
    case "CALLS_ENDPOINT":
    case "REFERENCES_SCHEMA":
      return input.matchingExternalReference;
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
  if (reason === "parse_failed" || reason === "manifest_parse_failed" || reason === "invalid_encoding")
    return "PARSE_COVERAGE_GAP" as const;
  if (
    [
      "file_count_limit",
      "parse_time_budget",
      "ast_node_limit",
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
    (a, b) => b.count - a.count || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0),
  );
  const sourceBounds = new Set([
    "file_count_limit",
    "parse_time_budget",
    "ast_node_limit",
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
  supported_files_discovered: number;
  supported_files_analyzed: number;
  supported_files_skipped_by_bound: number;
  unsupported_language_files: number;
  coverage_reason_counts: Record<string, number>;
  persisted_entity_count: number;
  persisted_relation_count: number;
  persisted_reference_count: number;
  persisted_skip_count: number;
  analyzer_version: string;
  language_profile: string;
  analysis_profile: string;
};
