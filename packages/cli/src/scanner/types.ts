export const DISCOVERY_SCHEMA_VERSION = "1.0.0" as const;
export const DISCOVERY_SCANNER_VERSION = "0.1.0" as const;
export const DISCOVERY_REGISTRY_VERSION = "m15.6-provider-map-1" as const;

export type ProviderCandidate = {
  status: "known" | "unknown";
  providerSlug: string | null;
  providerName: string | null;
};

export type EvidenceFamily =
  | "package_manifest"
  | "environment_variable_name"
  | "import_reference"
  | "provider_host"
  | "model_identifier"
  | "configuration_file"
  | "framework_runtime"
  | "lockfile_identity"
  | "git_remote";

export type PartialReason =
  | "cancelled"
  | "deadline"
  | "max_depth"
  | "max_directories"
  | "max_files"
  | "max_total_bytes"
  | "max_observations"
  | "symlink_skipped"
  | "root_unavailable"
  | "network_path_not_allowed"
  | "malformed_manifest"
  | "file_too_large"
  | "read_error";

export type SafeEvidenceMetadata = {
  ecosystem?: "npm" | "python" | "go" | "cargo" | "composer" | "unknown";
  manifestKind?:
    | "package.json"
    | "requirements.txt"
    | "pyproject.toml"
    | "go.mod"
    | "Cargo.toml"
    | "composer.json";
  dependencyScope?: "production" | "optional" | "development" | "build" | "unknown";
  declaredVersion?: string;
  runtimeName?: "node" | "python" | "go" | "rust" | "php" | "ruby" | "unknown";
  configKind?:
    | "next"
    | "vite"
    | "nuxt"
    | "svelte"
    | "astro"
    | "vercel"
    | "sentry"
    | "cloudflare"
    | "docker"
    | "runtime"
    | "other";
  modelFamily?: "openai" | "anthropic" | "gemini" | "cohere" | "mistral";
  gitHost?: "github.com" | "gitlab.com" | "bitbucket.org" | "other";
  gitOwner?: string;
  gitRepository?: string;
  gitBranch?: string;
  gitCommit?: string;
};

export type DiscoveryObservation = {
  id: string;
  evidenceFamily: EvidenceFamily;
  normalizedIdentifier: string;
  providerCandidate: ProviderCandidate;
  confidence: number;
  reasonCode:
    | "known_package_provider"
    | "unmapped_package"
    | "framework_package"
    | "environment_name"
    | "known_environment_provider"
    | "imported_provider_package"
    | "provider_host_reference"
    | "model_reference"
    | "configuration_identity"
    | "lockfile_identity"
    | "sanitized_git_origin";
  safeRelativePath: string | null;
  subproject: string | null;
  metadata: SafeEvidenceMetadata;
};

export type GitProjectIdentity = {
  host: "github.com" | "gitlab.com" | "bitbucket.org" | "other" | null;
  owner: string | null;
  repository: string | null;
  branch: string | null;
  commit: string | null;
};

export type ScanResult = {
  schemaVersion: typeof DISCOVERY_SCHEMA_VERSION;
  scannerVersion: typeof DISCOVERY_SCANNER_VERSION;
  registryVersion: typeof DISCOVERY_REGISTRY_VERSION;
  scanId: string;
  projectFingerprint: null;
  status: "complete" | "partial" | "cancelled" | "failed";
  projectSummary: {
    rootName: string;
    git: GitProjectIdentity;
  };
  stats: {
    filesVisited: number;
    directoriesVisited: number;
    manifestsParsed: number;
    sourceFilesInspected: number;
    observations: number;
    symlinksSkipped: number;
    ignoredDirectories: number;
    ignoredSensitiveFiles: number;
    ignoredSensitiveDirectories: number;
    totalBytesRead: number;
    truncated: boolean;
    partialReasons: PartialReason[];
    durationMs: number;
  };
  observations: DiscoveryObservation[];
};

export type ScanProjectOptions = {
  root: string;
  signal?: AbortSignal;
};

export type ScanDiff = {
  added: DiscoveryObservation[];
  removed: DiscoveryObservation[];
  changed: Array<{
    previous: DiscoveryObservation;
    current: DiscoveryObservation;
  }>;
  unchanged: number;
};
