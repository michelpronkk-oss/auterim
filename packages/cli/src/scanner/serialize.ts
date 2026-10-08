import {
  DISCOVERY_REGISTRY_VERSION,
  DISCOVERY_SCANNER_VERSION,
  DISCOVERY_SCHEMA_VERSION,
  type DiscoveryObservation,
  type SafeEvidenceMetadata,
  type ScanResult,
} from "./types.js";

const maximumObservations = 1_500;
const maximumPayloadBytes = 512 * 1024;
const slugs = /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/;
const identifiers = /^[A-Za-z0-9@_./:-]{1,180}$/;
const relativePaths = /^[A-Za-z0-9_./@ -]{1,240}$/;
const metadataKeys = new Set([
  "ecosystem",
  "manifestKind",
  "dependencyScope",
  "declaredVersion",
  "runtimeName",
  "configKind",
  "modelFamily",
  "gitHost",
  "gitOwner",
  "gitRepository",
  "gitBranch",
  "gitCommit",
]);

function invalid(): never {
  throw new Error("discovery_payload_invalid");
}

function boundedString(value: unknown, maximum: number, pattern?: RegExp): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    (pattern && !pattern.test(value))
  )
    return invalid();
  return value;
}

function nullableString(value: unknown, maximum: number, pattern?: RegExp): string | null {
  return value === null ? null : boundedString(value, maximum, pattern);
}

function boundedInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
    return invalid();
  return value as number;
}

function metadata(input: SafeEvidenceMetadata): SafeEvidenceMetadata {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.some(([key]) => !metadataKeys.has(key))) return invalid();
  const output: SafeEvidenceMetadata = {};
  const enums: Record<string, readonly string[]> = {
    ecosystem: ["npm", "python", "go", "cargo", "composer", "unknown"],
    manifestKind: [
      "package.json",
      "requirements.txt",
      "pyproject.toml",
      "go.mod",
      "Cargo.toml",
      "composer.json",
    ],
    dependencyScope: ["production", "optional", "development", "build", "unknown"],
    runtimeName: ["node", "python", "go", "rust", "php", "ruby", "unknown"],
    configKind: [
      "next",
      "vite",
      "nuxt",
      "svelte",
      "astro",
      "vercel",
      "sentry",
      "cloudflare",
      "docker",
      "runtime",
      "other",
    ],
    modelFamily: ["openai", "anthropic", "gemini", "cohere", "mistral"],
    gitHost: ["github.com", "gitlab.com", "bitbucket.org", "other"],
  };
  for (const [key, value] of entries) {
    if (key === "declaredVersion") {
      output.declaredVersion = boundedString(value, 80, /^[0-9a-zA-Z*^~<>=|.,+ _-]+$/);
    } else if (key === "gitCommit") {
      output.gitCommit = boundedString(value, 64, /^[a-f0-9]{40,64}$/i).toLowerCase();
    } else if (key === "gitOwner" || key === "gitRepository" || key === "gitBranch") {
      output[key] = boundedString(value, 180, /^[A-Za-z0-9_.\/-]+$/);
      if (output[key]!.split("/").some((part) => part === ".." || part === ".")) return invalid();
    } else {
      const choices = enums[key];
      if (!choices || typeof value !== "string" || !choices.includes(value)) return invalid();
      (output as Record<string, unknown>)[key] = value;
    }
  }
  return output;
}

function safeObservation(input: DiscoveryObservation): DiscoveryObservation {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const expectedKeys = [
    "id",
    "evidenceFamily",
    "normalizedIdentifier",
    "providerCandidate",
    "confidence",
    "reasonCode",
    "safeRelativePath",
    "subproject",
    "metadata",
  ];
  if (
    Object.keys(input as unknown as Record<string, unknown>).some(
      (key) => !expectedKeys.includes(key),
    )
  )
    return invalid();
  const id = boundedString(input.id, 32, /^[a-f0-9]{32}$/);
  const family = input.evidenceFamily;
  if (
    ![
      "package_manifest",
      "environment_variable_name",
      "import_reference",
      "provider_host",
      "model_identifier",
      "configuration_file",
      "framework_runtime",
      "lockfile_identity",
      "git_remote",
    ].includes(family)
  )
    return invalid();
  const candidate = input.providerCandidate;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return invalid();
  const candidateKeys = Object.keys(candidate as unknown as Record<string, unknown>);
  if (candidateKeys.some((key) => !["status", "providerSlug", "providerName"].includes(key)))
    return invalid();
  let providerCandidate: DiscoveryObservation["providerCandidate"];
  if (candidate.status === "known") {
    providerCandidate = {
      status: "known",
      providerSlug: boundedString(candidate.providerSlug, 80, slugs),
      providerName: boundedString(candidate.providerName, 100, /^[A-Za-z0-9 .&'()-]+$/),
    };
  } else if (
    candidate.status === "unknown" &&
    candidate.providerSlug === null &&
    candidate.providerName === null
  ) {
    providerCandidate = { status: "unknown", providerSlug: null, providerName: null };
  } else return invalid();
  const confidence = input.confidence;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  )
    return invalid();
  const reasonCodes = [
    "known_package_provider",
    "unmapped_package",
    "framework_package",
    "environment_name",
    "known_environment_provider",
    "imported_provider_package",
    "provider_host_reference",
    "model_reference",
    "configuration_identity",
    "lockfile_identity",
    "sanitized_git_origin",
  ];
  if (!reasonCodes.includes(input.reasonCode)) return invalid();
  const safeRelativePath =
    input.safeRelativePath === null
      ? null
      : boundedString(input.safeRelativePath, 240, relativePaths);
  if (
    safeRelativePath &&
    (safeRelativePath.startsWith("/") ||
      safeRelativePath.split("/").some((part) => part === ".." || part === "."))
  )
    return invalid();
  const subproject =
    input.subproject === null ? null : boundedString(input.subproject, 180, relativePaths);
  if (
    subproject &&
    (subproject.startsWith("/") ||
      subproject.split("/").some((part) => part === ".." || part === "."))
  )
    return invalid();
  return {
    id,
    evidenceFamily: family,
    normalizedIdentifier: boundedString(input.normalizedIdentifier, 180, identifiers),
    providerCandidate,
    confidence,
    reasonCode: input.reasonCode,
    safeRelativePath,
    subproject,
    metadata: metadata(input.metadata),
  };
}

export function serializeDiscoveryPayload(result: ScanResult): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) return invalid();
  const resultKeys = [
    "schemaVersion",
    "scannerVersion",
    "registryVersion",
    "scanId",
    "projectFingerprint",
    "status",
    "projectSummary",
    "stats",
    "observations",
  ];
  if (
    Object.keys(result as unknown as Record<string, unknown>).some(
      (key) => !resultKeys.includes(key),
    )
  )
    return invalid();
  if (
    result.schemaVersion !== DISCOVERY_SCHEMA_VERSION ||
    result.scannerVersion !== DISCOVERY_SCANNER_VERSION ||
    result.registryVersion !== DISCOVERY_REGISTRY_VERSION ||
    result.projectFingerprint !== null ||
    !["complete", "partial", "cancelled", "failed"].includes(result.status) ||
    !Array.isArray(result.observations) ||
    result.observations.length > maximumObservations
  )
    return invalid();
  const summary = result.projectSummary;
  if (
    !summary ||
    typeof summary !== "object" ||
    Object.keys(summary).some((key) => !["rootName", "git"].includes(key))
  )
    return invalid();
  const git = summary.git;
  if (
    !git ||
    typeof git !== "object" ||
    Object.keys(git).some(
      (key) => !["host", "owner", "repository", "branch", "commit"].includes(key),
    )
  )
    return invalid();
  const safeGit = {
    host:
      git.host === null
        ? null
        : ["github.com", "gitlab.com", "bitbucket.org", "other"].includes(git.host)
          ? git.host
          : invalid(),
    owner: nullableString(git.owner, 120, /^[A-Za-z0-9_.-]+$/),
    repository: nullableString(git.repository, 120, /^[A-Za-z0-9_.-]+$/),
    branch: nullableString(git.branch, 180, /^[A-Za-z0-9_.\/-]+$/),
    commit: nullableString(git.commit, 64, /^[a-f0-9]{40,64}$/i)?.toLowerCase() ?? null,
  };
  if (safeGit.branch?.split("/").some((part) => part === ".." || part === ".")) return invalid();
  const stats = result.stats;
  if (!stats || typeof stats !== "object") return invalid();
  const statKeys = [
    "filesVisited",
    "directoriesVisited",
    "manifestsParsed",
    "sourceFilesInspected",
    "observations",
    "symlinksSkipped",
    "ignoredDirectories",
    "ignoredSensitiveFiles",
    "ignoredSensitiveDirectories",
    "totalBytesRead",
    "truncated",
    "partialReasons",
    "durationMs",
  ];
  if (Object.keys(stats).some((key) => !statKeys.includes(key))) return invalid();
  if (typeof stats.truncated !== "boolean") return invalid();
  const partialReasons = [
    "cancelled",
    "deadline",
    "max_depth",
    "max_directories",
    "max_files",
    "max_total_bytes",
    "max_observations",
    "symlink_skipped",
    "root_unavailable",
    "network_path_not_allowed",
    "malformed_manifest",
    "file_too_large",
    "read_error",
  ];
  if (
    !Array.isArray(stats.partialReasons) ||
    stats.partialReasons.some((reason) => !partialReasons.includes(reason))
  )
    return invalid();
  const observations = result.observations
    .map(safeObservation)
    .sort(
      (left, right) =>
        left.evidenceFamily.localeCompare(right.evidenceFamily) ||
        left.normalizedIdentifier.localeCompare(right.normalizedIdentifier) ||
        (left.safeRelativePath ?? "").localeCompare(right.safeRelativePath ?? "") ||
        left.id.localeCompare(right.id),
    );
  if (new Set(observations.map((item) => item.id)).size !== observations.length) return invalid();
  const output = {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    scannerVersion: DISCOVERY_SCANNER_VERSION,
    registryVersion: DISCOVERY_REGISTRY_VERSION,
    scanId: boundedString(result.scanId, 36, /^[0-9a-f-]{36}$/i),
    projectFingerprint: null,
    status: result.status,
    projectSummary: {
      rootName: boundedString(summary.rootName, 100, /^[A-Za-z0-9_.-]+$/),
      git: safeGit,
    },
    stats: {
      filesVisited: boundedInteger(stats.filesVisited, 4_000),
      directoriesVisited: boundedInteger(stats.directoriesVisited, 600),
      manifestsParsed: boundedInteger(stats.manifestsParsed, 4_000),
      sourceFilesInspected: boundedInteger(stats.sourceFilesInspected, 600),
      observations: boundedInteger(stats.observations, maximumObservations),
      symlinksSkipped: boundedInteger(stats.symlinksSkipped, 4_000),
      ignoredDirectories: boundedInteger(stats.ignoredDirectories, 4_000),
      ignoredSensitiveFiles: boundedInteger(stats.ignoredSensitiveFiles, 4_000),
      ignoredSensitiveDirectories: boundedInteger(stats.ignoredSensitiveDirectories, 4_000),
      totalBytesRead: boundedInteger(stats.totalBytesRead, 4 * 1024 * 1024),
      truncated: stats.truncated === true,
      partialReasons: [...new Set(stats.partialReasons)].sort(),
      durationMs: boundedInteger(stats.durationMs, 60_000),
    },
    observations,
  };
  if (output.stats.observations !== observations.length) return invalid();
  if (
    (output.status === "complete") !==
    (!output.stats.truncated && output.stats.partialReasons.length === 0)
  )
    return invalid();
  if (
    output.status === "failed" &&
    (!output.stats.truncated || !output.stats.partialReasons.length)
  )
    return invalid();
  const serialized = JSON.stringify(output);
  if (Buffer.byteLength(serialized, "utf8") > maximumPayloadBytes) return invalid();
  return serialized;
}
