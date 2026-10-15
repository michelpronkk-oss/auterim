export const CODE_ANALYSIS_FAILURE_STAGES = [
  "environment_validation",
  "github_provider_setup",
  "repository_materialization",
  "snapshot_collection",
  "static_analysis",
  "analysis_persistence",
] as const;

export type CodeAnalysisFailureStage = (typeof CODE_ANALYSIS_FAILURE_STAGES)[number];

export const CODE_ANALYSIS_FAILURE_CATEGORIES = [
  "environment_invalid",
  "github_config_unavailable",
  "github_signing_failed",
  "github_private_key_unparseable",
  "github_private_key_not_rsa",
  "github_private_key_encrypted_unsupported",
  "github_private_key_format_unsupported",
  "github_local_sign_failed",
  "github_local_verify_failed",
  "github_auth_rejected",
  "github_installation_unavailable",
  "github_permission_denied",
  "github_commit_unavailable",
  "github_rate_limited",
  "github_provider_unavailable",
  "github_snapshot_unavailable",
  "github_snapshot_too_large",
  "github_snapshot_invalid",
  "github_archive_file_limit",
  "github_archive_expanded_limit",
  "snapshot_collection_failed",
  "repository_byte_limit",
  "repository_file_limit",
  "invalid_encoding",
  "static_analysis_failed",
  "parse_budget_exceeded",
  "fact_limit_exceeded",
  "analysis_persistence_failed",
  "analysis_failed",
] as const;

export type CodeAnalysisFailureCategory = (typeof CODE_ANALYSIS_FAILURE_CATEGORIES)[number];

export type NormalizedCodeAnalysisFailure = {
  stage: CodeAnalysisFailureStage | null;
  category: CodeAnalysisFailureCategory;
  retryable: boolean;
};

const CATEGORIES_BY_GITHUB_FAILURE: Record<string, CodeAnalysisFailureCategory> = {
  signing_failed: "github_signing_failed",
  github_private_key_unparseable: "github_private_key_unparseable",
  github_private_key_not_rsa: "github_private_key_not_rsa",
  github_private_key_encrypted_unsupported: "github_private_key_encrypted_unsupported",
  github_private_key_format_unsupported: "github_private_key_format_unsupported",
  github_local_sign_failed: "github_local_sign_failed",
  github_local_verify_failed: "github_local_verify_failed",
  app_jwt_rejected: "github_auth_rejected",
  installation_token_rejected: "github_auth_rejected",
  installation_not_found: "github_installation_unavailable",
  installation_unavailable: "github_installation_unavailable",
  permission_denied: "github_permission_denied",
  rate_limited: "github_rate_limited",
  provider_unavailable: "github_provider_unavailable",
  commit_unavailable: "github_commit_unavailable",
  snapshot_unavailable: "github_snapshot_unavailable",
  snapshot_too_large: "github_snapshot_too_large",
  snapshot_invalid: "github_snapshot_invalid",
  archive_file_limit: "github_archive_file_limit",
  archive_expanded_limit: "github_archive_expanded_limit",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Normalize failures to a strict, non-sensitive stage/category tuple. */
export function normalizeCodeAnalysisFailure(
  stage: CodeAnalysisFailureStage,
  error: unknown,
): NormalizedCodeAnalysisFailure {
  if (isRecord(error)) {
    const githubCategory =
      error.name === "GitHubAppInstallationError" && typeof error.category === "string"
        ? CATEGORIES_BY_GITHUB_FAILURE[error.category]
        : undefined;
    if (githubCategory) {
      return {
        stage,
        category: githubCategory,
        retryable:
          githubCategory === "github_rate_limited" ||
          githubCategory === "github_provider_unavailable",
      };
    }

    if (error.name === "CodeAnalysisStageError" && typeof error.category === "string") {
      const category = CODE_ANALYSIS_FAILURE_CATEGORIES.find((item) => item === error.category);
      if (category) {
        return {
          stage,
          category,
          retryable: error.retryable === true,
        };
      }
    }

    if (
      stage === "repository_materialization" &&
      typeof error.code === "string" &&
      ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(error.code)
    ) {
      return { stage, category: "github_provider_unavailable", retryable: true };
    }
  }

  if (stage === "environment_validation") {
    return { stage, category: "environment_invalid", retryable: false };
  }
  if (
    stage === "github_provider_setup" &&
    error instanceof Error &&
    error.message === "github_app_not_configured"
  ) {
    return { stage, category: "github_config_unavailable", retryable: false };
  }
  if (stage === "snapshot_collection") {
    return { stage, category: "snapshot_collection_failed", retryable: false };
  }
  if (stage === "static_analysis") {
    return { stage, category: "static_analysis_failed", retryable: false };
  }
  if (stage === "analysis_persistence") {
    return { stage, category: "analysis_persistence_failed", retryable: false };
  }
  return { stage, category: "analysis_failed", retryable: false };
}

export class CodeAnalysisStageError extends Error {
  readonly category: CodeAnalysisFailureCategory;
  readonly retryable: boolean;

  constructor(category: CodeAnalysisFailureCategory, retryable = false) {
    super("code_intelligence_stage_failed");
    this.name = "CodeAnalysisStageError";
    this.category = category;
    this.retryable = retryable;
  }
}

export async function executeCodeAnalysisStages<
  TEnvironment,
  TProvider,
  TSnapshot,
  TAnalysis,
>(input: {
  validateEnvironment: () => Promise<TEnvironment> | TEnvironment;
  setupProvider: (environment: TEnvironment) => Promise<TProvider> | TProvider;
  materialize: (provider: TProvider) => Promise<void>;
  collectSnapshot: () => Promise<TSnapshot>;
  analyze: (snapshot: TSnapshot) => Promise<TAnalysis> | TAnalysis;
  persist: (analysis: TAnalysis) => Promise<void>;
  cleanup: () => Promise<void>;
}) {
  let stage: CodeAnalysisFailureStage = "environment_validation";
  let primaryFailure: NormalizedCodeAnalysisFailure | null = null;
  let analysis: TAnalysis | null = null;
  let cleanupFailed = false;

  try {
    const environment = await input.validateEnvironment();
    stage = "github_provider_setup";
    const provider = await input.setupProvider(environment);
    stage = "repository_materialization";
    await input.materialize(provider);
    stage = "snapshot_collection";
    const snapshot = await input.collectSnapshot();
    stage = "static_analysis";
    analysis = await input.analyze(snapshot);
  } catch (error) {
    primaryFailure = normalizeCodeAnalysisFailure(stage, error);
  }

  try {
    await input.cleanup();
  } catch {
    cleanupFailed = true;
  }

  if (primaryFailure) {
    return { ok: false as const, failure: primaryFailure, cleanupFailed };
  }
  if (cleanupFailed) {
    return {
      ok: false as const,
      failure: { stage: null, category: "analysis_failed" as const, retryable: false },
      cleanupFailed: true,
    };
  }

  try {
    stage = "analysis_persistence";
    await input.persist(analysis as TAnalysis);
  } catch (error) {
    return {
      ok: false as const,
      failure: normalizeCodeAnalysisFailure(stage, error),
      cleanupFailed: false,
    };
  }

  return { ok: true as const, analysis: analysis as TAnalysis, cleanupFailed: false };
}
