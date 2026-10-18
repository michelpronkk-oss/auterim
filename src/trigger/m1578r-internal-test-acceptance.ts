import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getEnvironment, isIntegrationConfigured } from "@/lib/env/schema";
import { persistInternalTestSourceChange } from "@/lib/monitoring/internal-test-source";
import { inspectGitHubInstallationScope } from "@/lib/fix-engine/github-write-token";
import { sanitizeM1578RRunnerDiagnosticEvents } from "@/lib/fix-engine/runner-diagnostic-readback";

const TARGET = {
  workspaceId: "e140d48e-9dc0-4552-a9a4-a81fe3872422",
  productId: "de1f2a12-de3c-4644-8892-b6c2d458a300",
  repositoryId: "b2abf377-2dbc-4b9c-b546-b0604f3ee4fe",
  preservedAuterimRepositoryId: "3b4f4fe6-cbbd-4bbd-a340-71f7c268e2c4",
  repositoryExternalId: 1409364414,
  preservedAuterimRepositoryExternalId: 1402431563,
  owner: "michelpronkk-oss",
  repository: "auterim-m15-github-qa",
  accountLogin: "michelpronkk-oss",
  dependencyId: "3cfb1bb7-1d76-4692-932b-24e94b66f346",
  workspaceDependencyId: "867eb92b-2ed2-4917-ac68-44a22773e369",
  fixRunId: "7de04a75-aefa-43a6-ba64-9fa4a70e0ec1",
} as const;

const SOURCE_ACCEPTANCE_KEY = "m1578r-internal-qa-fix-engine-v1";
const SOURCE_BASELINE =
  "Internal QA provider bulletin: endpoint https://api.openai.com/v1/auterim-m1578r-old is currently supported.";
const SOURCE_CHANGED =
  "Internal QA provider bulletin: endpoint https://api.openai.com/v1/auterim-m1578r-old is deprecated; use https://api.openai.com/v1/auterim-m1578r-new instead.";
export const M1578R_REQUIRED_FIXTURE_PATHS = [
  "package.json",
  "package-lock.json",
  "jest.config.js",
  "src/endpoint.js",
  "src/typecheck.ts",
  "test/endpoint.test.js",
  "tsconfig.json",
] as const;

export function hasExpectedActiveProductRepositoryMappings(
  mappings: Array<{ repository_id: string; status: string }>,
) {
  if (mappings.some((mapping) => !["active", "inactive"].includes(mapping.status))) return false;
  const activeRepositoryIds = mappings
    .filter((mapping) => mapping.status === "active")
    .map((mapping) => mapping.repository_id);
  const expectedRepositoryIds = new Set<string>([
    TARGET.repositoryId,
    TARGET.preservedAuterimRepositoryId,
  ]);
  return (
    activeRepositoryIds.length === expectedRepositoryIds.size &&
    new Set(activeRepositoryIds).size === expectedRepositoryIds.size &&
    activeRepositoryIds.every((repositoryId) => expectedRepositoryIds.has(repositoryId))
  );
}

export const M1578RInternalTestAcceptanceInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("verify") }).strict(),
  z.object({ action: z.literal("read_fix_status") }).strict(),
  z.object({ action: z.literal("diagnose_entitlement") }).strict(),
  z
    .object({
      action: z.literal("create_source"),
      fixtureCommitSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
    })
    .strict(),
]);

type BillingSubscription = {
  plan?: unknown;
  status?: unknown;
  trialStartedAt?: unknown;
  trialEndsAt?: unknown;
  currentPeriodStart?: unknown;
  currentPeriodEnd?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Mirrors private.workspace_can_run_preflight for a safe, fixed-scope diagnostic. */
export function diagnosePreflightEntitlement(input: { snapshot: unknown; preflightRuns: number }) {
  const snapshot = asRecord(input.snapshot);
  const subscription = asRecord(snapshot?.subscription) as BillingSubscription | null;
  const nowValue = snapshot?.serverNow;
  const now = timestamp(nowValue);
  if (
    !snapshot ||
    now === null ||
    !Number.isSafeInteger(input.preflightRuns) ||
    input.preflightRuns < 0
  ) {
    return { status: "unavailable" as const, failureReasons: ["billing_snapshot_invalid"] };
  }

  const plan = typeof subscription?.plan === "string" ? subscription.plan : null;
  const subscriptionStatus = typeof subscription?.status === "string" ? subscription.status : null;
  const trialStartedAt =
    typeof subscription?.trialStartedAt === "string" ? subscription.trialStartedAt : null;
  const trialEndsAt =
    typeof subscription?.trialEndsAt === "string" ? subscription.trialEndsAt : null;
  const currentPeriodStart =
    typeof subscription?.currentPeriodStart === "string" ? subscription.currentPeriodStart : null;
  const currentPeriodEnd =
    typeof subscription?.currentPeriodEnd === "string" ? subscription.currentPeriodEnd : null;
  const monthStart = new Date(now).toISOString().slice(0, 7) + "-01T00:00:00.000Z";
  const usageWindowStart = currentPeriodStart ?? trialStartedAt ?? monthStart;
  const preflightLimit = plan === "pro" ? 500 : plan === "business" ? 5000 : 0;
  const failureReasons: string[] = [];

  if (!subscription) {
    failureReasons.push("subscription_missing");
  } else if (subscriptionStatus === "trialing") {
    if (plan !== "pro") failureReasons.push("trial_plan_not_pro");
    const trialStart = timestamp(trialStartedAt);
    const trialEnd = timestamp(trialEndsAt);
    if (trialStart === null || trialStart > now) failureReasons.push("trial_not_started");
    if (trialEnd === null) failureReasons.push("trial_end_missing");
    else if (trialEnd <= now) failureReasons.push("trial_expired");
  } else if (subscriptionStatus === "active") {
    if (plan !== "pro" && plan !== "business") failureReasons.push("plan_not_preflight_eligible");
    const periodEnd = timestamp(currentPeriodEnd);
    if (periodEnd === null || periodEnd <= now) failureReasons.push("current_period_expired");
  } else {
    if (
      subscriptionStatus === "expired" &&
      timestamp(trialEndsAt) !== null &&
      timestamp(trialEndsAt)! <= now
    ) {
      failureReasons.push("trial_expired");
    } else if (subscriptionStatus === "past_due") {
      failureReasons.push("subscription_past_due");
    } else {
      failureReasons.push("subscription_status_not_eligible");
    }
  }

  if (input.preflightRuns > preflightLimit) failureReasons.push("preflight_usage_limit_exceeded");
  return {
    status: failureReasons.length === 0 ? ("eligible" as const) : ("ineligible" as const),
    workspaceId: TARGET.workspaceId,
    plan,
    subscriptionStatus,
    trialStartedAt,
    trialEndsAt,
    currentPeriodStart,
    currentPeriodEnd,
    serverNow: nowValue,
    usageWindowStart,
    preflightRuns: input.preflightRuns,
    preflightLimit,
    failureReasons,
  };
}

type Readiness = {
  status: "ready" | "blocked";
  category?: string;
  checks: {
    protectedProduct: boolean;
    exactQaRepositoryMapping: boolean;
    exactRepositoryIdentity: boolean;
    activeOpenAiDependency: boolean;
    connectedGitHubInstallation: boolean;
    appIdentityMatches: boolean;
    installationIdentityMatches: boolean;
    expectedGitHubAccount: boolean;
    installationActive: boolean;
    selectedRepositoriesOnly: boolean;
    requiredWritePermissionsGranted: boolean;
    noUnexpectedWritePermissions: boolean;
    allowedInstallationRepositoryScope: boolean;
    fixtureFilesPresentOnDefaultBranch: boolean;
    supportedNpmLockfilePresent: boolean;
    fixtureCommitMatchesDefaultHead: boolean | null;
    productionVerificationStorageReadable: boolean;
    classifierConfigured: boolean;
    intelligenceConfigured: boolean;
    codingModelConfigured: boolean;
    verificationRunnerConfigured: boolean;
    dependencyCachePublicKeyConfigured: boolean;
    draftPrWritesDisabled: boolean;
  };
  repositoryIdentity: "michelpronkk-oss/auterim-m15-github-qa";
  defaultBranch: string | null;
  defaultBranchSha: string | null;
  visibleRepositoryCount: number | null;
  githubInstallation?: {
    repositorySelection: "selected" | "all" | null;
    permissions: Record<string, string> | null;
    visibleRepositories: Array<{ id: number; fullName: string }> | null;
  };
};

function safeFailureCategory(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^github_[a-z0-9_]{1,100}$/.test(message) ? message : "operator_preflight_failed";
}

async function inspectReadiness(expectedFixtureCommitSha?: string): Promise<Readiness> {
  const checks: Readiness["checks"] = {
    protectedProduct: false,
    exactQaRepositoryMapping: false,
    exactRepositoryIdentity: false,
    activeOpenAiDependency: false,
    connectedGitHubInstallation: false,
    appIdentityMatches: false,
    installationIdentityMatches: false,
    expectedGitHubAccount: false,
    installationActive: false,
    selectedRepositoriesOnly: false,
    requiredWritePermissionsGranted: false,
    noUnexpectedWritePermissions: false,
    allowedInstallationRepositoryScope: false,
    fixtureFilesPresentOnDefaultBranch: false,
    supportedNpmLockfilePresent: false,
    fixtureCommitMatchesDefaultHead: null,
    productionVerificationStorageReadable: false,
    classifierConfigured: false,
    intelligenceConfigured: false,
    codingModelConfigured: false,
    verificationRunnerConfigured: false,
    dependencyCachePublicKeyConfigured: false,
    draftPrWritesDisabled: false,
  };

  let environment: ReturnType<typeof getEnvironment>;
  try {
    environment = getEnvironment();
  } catch {
    return {
      status: "blocked",
      category: "environment_unavailable",
      checks,
      repositoryIdentity: "michelpronkk-oss/auterim-m15-github-qa",
      defaultBranch: null,
      defaultBranchSha: null,
      visibleRepositoryCount: null,
    };
  }

  checks.classifierConfigured = isIntegrationConfigured("classifier", environment);
  checks.intelligenceConfigured = isIntegrationConfigured("intelligence", environment);
  checks.codingModelConfigured = Boolean(
    environment.FIX_CODING_MODEL_PROVIDER &&
    environment.FIX_CODING_MODEL_NAME &&
    environment.FIX_CODING_MODEL_API_KEY,
  );
  checks.verificationRunnerConfigured = Boolean(
    environment.FIX_VERIFICATION_RUNNER_URL && environment.FIX_VERIFICATION_RUNNER_AUTH_SECRET,
  );
  checks.dependencyCachePublicKeyConfigured = Boolean(environment.FIX_DEPENDENCY_CACHE_PUBLIC_KEY);
  checks.draftPrWritesDisabled = environment.FIX_GITHUB_DRAFT_PR_WRITES === "0";

  const client = createSupabaseServerClient();
  const { data: storageBucket, error: storageError } = await client.storage
    .getBucket("fix-engine-verification-artifacts")
    .catch(() => ({ data: null, error: new Error("storage_read_failed") }));
  checks.productionVerificationStorageReadable =
    !storageError &&
    storageBucket?.id === "fix-engine-verification-artifacts" &&
    storageBucket.public === false;

  const [
    productResult,
    mappingResult,
    repositoryResult,
    dependencyResult,
    dependencyCatalogResult,
  ] = await Promise.all([
    client
      .from("workspace_products")
      .select("id,status")
      .eq("workspace_id", TARGET.workspaceId)
      .eq("id", TARGET.productId)
      .maybeSingle(),
    client
      .from("workspace_product_repositories")
      .select("id,repository_id,status")
      .eq("workspace_id", TARGET.workspaceId)
      .eq("protected_product_id", TARGET.productId),
    client
      .from("repositories")
      .select(
        "id,workspace_id,connection_id,external_id,owner,name,default_branch,status,selected_for_protection",
      )
      .eq("workspace_id", TARGET.workspaceId)
      .eq("id", TARGET.repositoryId)
      .maybeSingle(),
    client
      .from("workspace_dependencies")
      .select("id,workspace_id,protected_product_id,dependency_id,monitoring_enabled")
      .eq("workspace_id", TARGET.workspaceId)
      .eq("protected_product_id", TARGET.productId)
      .eq("dependency_id", TARGET.dependencyId)
      .eq("id", TARGET.workspaceDependencyId)
      .eq("monitoring_enabled", true)
      .maybeSingle(),
    client
      .from("dependency_catalog")
      .select("id,slug,enabled")
      .eq("id", TARGET.dependencyId)
      .maybeSingle(),
  ]);

  if (
    productResult.error ||
    mappingResult.error ||
    repositoryResult.error ||
    dependencyResult.error ||
    dependencyCatalogResult.error
  ) {
    return {
      status: "blocked",
      category: "canonical_scope_read_failed",
      checks,
      repositoryIdentity: "michelpronkk-oss/auterim-m15-github-qa",
      defaultBranch: null,
      defaultBranchSha: null,
      visibleRepositoryCount: null,
    };
  }

  const product = productResult.data;
  const mappings = mappingResult.data ?? [];
  const repository = repositoryResult.data;
  const dependency = dependencyResult.data;
  const provider = dependencyCatalogResult.data;
  checks.protectedProduct = product?.status === "protected";
  checks.exactQaRepositoryMapping = hasExpectedActiveProductRepositoryMappings(mappings);
  checks.exactRepositoryIdentity =
    repository?.id === TARGET.repositoryId &&
    repository.workspace_id === TARGET.workspaceId &&
    repository.owner.toLowerCase() === TARGET.owner &&
    repository.name.toLowerCase() === TARGET.repository &&
    repository.status === "available" &&
    repository.selected_for_protection === true &&
    Number(repository.external_id) === TARGET.repositoryExternalId &&
    typeof repository.default_branch === "string" &&
    /^[A-Za-z0-9_.-]{1,100}$/.test(repository.default_branch);
  checks.activeOpenAiDependency =
    dependency?.id === TARGET.workspaceDependencyId &&
    dependency.workspace_id === TARGET.workspaceId &&
    dependency.protected_product_id === TARGET.productId &&
    dependency.dependency_id === TARGET.dependencyId &&
    dependency.monitoring_enabled === true &&
    dependencyResult.data !== null &&
    provider?.id === TARGET.dependencyId &&
    provider.slug === "openai" &&
    provider.enabled === true;

  if (
    !checks.protectedProduct ||
    !checks.exactQaRepositoryMapping ||
    !checks.exactRepositoryIdentity ||
    !checks.activeOpenAiDependency
  ) {
    return {
      status: "blocked",
      category: "canonical_product_repository_scope_mismatch",
      checks,
      repositoryIdentity: "michelpronkk-oss/auterim-m15-github-qa",
      defaultBranch: repository?.default_branch ?? null,
      defaultBranchSha: null,
      visibleRepositoryCount: null,
    };
  }

  const { data: connection, error: connectionError } = await client
    .from("repository_connections")
    .select("id,workspace_id,installation_id,provider,status")
    .eq("workspace_id", TARGET.workspaceId)
    .eq("id", repository?.connection_id ?? "00000000-0000-0000-0000-000000000000")
    .maybeSingle();
  if (connectionError || !connection) {
    return {
      status: "blocked",
      category: "canonical_connection_unavailable",
      checks,
      repositoryIdentity: "michelpronkk-oss/auterim-m15-github-qa",
      defaultBranch: repository?.default_branch ?? null,
      defaultBranchSha: null,
      visibleRepositoryCount: null,
    };
  }
  const installationId = Number(connection.installation_id);
  checks.connectedGitHubInstallation =
    connection.workspace_id === TARGET.workspaceId &&
    connection.provider === "github" &&
    connection.status === "connected" &&
    Number.isSafeInteger(installationId) &&
    installationId > 0;
  if (!checks.connectedGitHubInstallation) {
    return {
      status: "blocked",
      category: "canonical_github_installation_mismatch",
      checks,
      repositoryIdentity: "michelpronkk-oss/auterim-m15-github-qa",
      defaultBranch: repository?.default_branch ?? null,
      defaultBranchSha: null,
      visibleRepositoryCount: null,
    };
  }

  let github: Awaited<ReturnType<typeof inspectGitHubInstallationScope>>;
  try {
    if (!environment.GITHUB_APP_ID || !environment.GITHUB_APP_PRIVATE_KEY)
      throw new Error("github_app_configuration_unavailable");
    if (!checks.exactRepositoryIdentity || !repository?.default_branch)
      throw new Error("github_canonical_repository_unavailable");
    github = await inspectGitHubInstallationScope({
      appId: environment.GITHUB_APP_ID,
      privateKey: environment.GITHUB_APP_PRIVATE_KEY,
      installationId,
      expectedAccountLogin: TARGET.accountLogin,
      repositoryId: TARGET.repositoryExternalId,
      owner: TARGET.owner,
      repository: TARGET.repository,
      defaultBranch: repository.default_branch,
      allowedRepositories: [
        {
          id: TARGET.repositoryExternalId,
          fullName: `${TARGET.owner}/${TARGET.repository}`,
        },
        {
          id: TARGET.preservedAuterimRepositoryExternalId,
          fullName: `${TARGET.owner}/auterim`,
        },
      ],
      requiredPaths: [...M1578R_REQUIRED_FIXTURE_PATHS],
    });
  } catch (error) {
    return {
      status: "blocked",
      category: safeFailureCategory(error),
      checks,
      repositoryIdentity: "michelpronkk-oss/auterim-m15-github-qa",
      defaultBranch: repository?.default_branch ?? null,
      defaultBranchSha: null,
      visibleRepositoryCount: null,
    };
  }

  checks.appIdentityMatches = github.appIdentityMatches;
  checks.installationIdentityMatches = github.installationIdentityMatches;
  checks.expectedGitHubAccount =
    github.accountLogin?.toLowerCase() === TARGET.accountLogin.toLowerCase();
  checks.installationActive = github.installationActive;
  checks.selectedRepositoriesOnly = github.selectedRepositoriesOnly;
  checks.requiredWritePermissionsGranted = github.requiredWritePermissionsGranted;
  checks.noUnexpectedWritePermissions = github.noUnexpectedWritePermissions;
  checks.allowedInstallationRepositoryScope = github.allowedRepositoryScopeMatches === true;
  checks.fixtureFilesPresentOnDefaultBranch = github.requiredPathsPresent === true;
  checks.supportedNpmLockfilePresent = github.npmLockfileFamily === "npm";
  checks.fixtureCommitMatchesDefaultHead = expectedFixtureCommitSha
    ? github.defaultBranchSha === expectedFixtureCommitSha.toLowerCase()
    : null;

  const required = [
    checks.protectedProduct,
    checks.exactQaRepositoryMapping,
    checks.exactRepositoryIdentity,
    checks.activeOpenAiDependency,
    checks.connectedGitHubInstallation,
    checks.appIdentityMatches,
    checks.installationIdentityMatches,
    checks.expectedGitHubAccount,
    checks.installationActive,
    checks.selectedRepositoriesOnly,
    checks.requiredWritePermissionsGranted,
    checks.noUnexpectedWritePermissions,
    checks.allowedInstallationRepositoryScope,
    checks.fixtureFilesPresentOnDefaultBranch,
    checks.supportedNpmLockfilePresent,
    checks.productionVerificationStorageReadable,
    checks.classifierConfigured,
    checks.intelligenceConfigured,
    checks.codingModelConfigured,
    checks.verificationRunnerConfigured,
    checks.dependencyCachePublicKeyConfigured,
    checks.draftPrWritesDisabled,
  ];
  if (expectedFixtureCommitSha) required.push(checks.fixtureCommitMatchesDefaultHead === true);

  return {
    status: required.every(Boolean) ? "ready" : "blocked",
    ...(required.every(Boolean) ? {} : { category: "acceptance_preflight_not_ready" }),
    checks,
    repositoryIdentity: "michelpronkk-oss/auterim-m15-github-qa",
    defaultBranch: github.defaultBranch,
    defaultBranchSha: github.defaultBranchSha,
    visibleRepositoryCount: github.visibleRepositoryCount,
    githubInstallation: {
      repositorySelection: github.repositorySelection ?? null,
      permissions: github.grantedPermissions ?? null,
      visibleRepositories: github.visibleRepositories ?? null,
    },
  };
}

export function sanitizeM1578RVerificationChecks(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const row = asRecord(candidate);
    if (!row) return [];
    const commandClass = row?.commandClass;
    const status = row?.status;
    if (
      typeof commandClass !== "string" ||
      !/^[a-z0-9_-]{1,80}$/.test(commandClass) ||
      (status !== "passed" && status !== "failed")
    ) {
      return [];
    }
    const diagnosticCategory =
      typeof row.diagnosticCategory === "string" &&
      /^[a-z0-9_]{1,100}$/.test(row.diagnosticCategory)
        ? row.diagnosticCategory
        : null;
    return [
      {
        commandClass,
        status,
        durationMs:
          Number.isSafeInteger(row.durationMs) && Number(row.durationMs) >= 0
            ? Number(row.durationMs)
            : null,
        outputBytes:
          Number.isSafeInteger(row.outputBytes) && Number(row.outputBytes) >= 0
            ? Number(row.outputBytes)
            : null,
        diagnosticCategory,
      },
    ];
  });
}

async function inspectM1578RFixStatus() {
  const client = createSupabaseServerClient();
  const [
    runResult,
    stageResult,
    attemptResult,
    diagnosisResult,
    planResult,
    patchResult,
    verificationResult,
    runnerDiagnosticResult,
    recoveryThreeResult,
    riskResult,
    externalResult,
    prResult,
  ] = await Promise.all([
    client
      .from("fix_runs")
      .select(
        "id,workspace_id,product_id,repository_id,source_change_id,source_mode,processing_mode,provenance_mode,status,current_stage,risk_level,failure_category,commit_sha,review_disposition,review_reason,production_exposure_state",
      )
      .eq("id", TARGET.fixRunId)
      .eq("workspace_id", TARGET.workspaceId)
      .eq("product_id", TARGET.productId)
      .eq("repository_id", TARGET.repositoryId)
      .maybeSingle(),
    client
      .from("fix_stage_queue")
      .select("id,stage,status,attempt_count,operator_retry_count,failure_category")
      .eq("fix_run_id", TARGET.fixRunId)
      .eq("workspace_id", TARGET.workspaceId)
      .order("created_at"),
    client
      .from("fix_model_attempts")
      .select(
        "id,stage,attempt_number,provider,model,model_version,schema_version,prompt_contract_version,status,input_fingerprint,output_fingerprint,latency_ms,input_tokens,output_tokens,cost_microusd,failure_category",
      )
      .eq("fix_run_id", TARGET.fixRunId)
      .eq("workspace_id", TARGET.workspaceId)
      .order("created_at"),
    client
      .from("fix_diagnoses")
      .select(
        "id,provider,model,model_version,schema_version,prompt_contract_version,input_fingerprint,output_fingerprint,latency_ms,input_tokens,output_tokens,cost_microusd,created_at",
      )
      .eq("fix_run_id", TARGET.fixRunId)
      .eq("workspace_id", TARGET.workspaceId)
      .order("created_at"),
    client
      .from("fix_plans")
      .select(
        "id,plan_version,plan_fingerprint,provider,model,schema_version,prompt_contract_version,created_at",
      )
      .eq("fix_run_id", TARGET.fixRunId)
      .eq("workspace_id", TARGET.workspaceId)
      .order("plan_version"),
    client
      .from("fix_patches")
      .select(
        "id,plan_id,attempt_number,base_sha,patch_fingerprint,changed_paths,line_count,byte_count,status,created_at,expires_at",
      )
      .eq("fix_run_id", TARGET.fixRunId)
      .eq("workspace_id", TARGET.workspaceId)
      .order("attempt_number"),
    client
      .from("fix_verification_runs")
      .select("id,profile_id,status,checks,duration_ms,patch_fingerprint,attempt_number,created_at")
      .eq("fix_run_id", TARGET.fixRunId)
      .eq("workspace_id", TARGET.workspaceId)
      .order("attempt_number"),
    client
      .from("fix_stage_runner_diagnostic_events")
      .select("id,stage_id,attempt_number,failure_category,retryable,diagnostics,created_at")
      .eq("fix_run_id", TARGET.fixRunId)
      .eq("workspace_id", TARGET.workspaceId)
      .eq("stage", "verify_patch")
      .order("attempt_number")
      .limit(4),
    client
      .from("fix_verification_recovery_generation_three_authorizations")
      .select(
        "id,stage_id,recovery_generation,prior_run_failure_category,prior_stage_failure_category,prior_attempt_count,prior_operator_retry_count,patch_id,patch_fingerprint,cache_identity_key,cache_manifest_fingerprint,cache_archive_sha256,cache_tree_sha256,runner_attestation_account,runner_attestation_region,runner_attestation_instance_id,runner_image_id,runner_protocol,diagnostics_contract_version,authorized_at",
      )
      .eq("fix_run_id", TARGET.fixRunId)
      .eq("workspace_id", TARGET.workspaceId)
      .eq("stage", "verify_patch")
      .limit(1),
    client
      .from("fix_risk_assessments")
      .select(
        "id,risk_version,risk_level,review_required,review_reason,input_fingerprint,created_at",
      )
      .eq("fix_run_id", TARGET.fixRunId)
      .eq("workspace_id", TARGET.workspaceId)
      .maybeSingle(),
    client
      .from("fix_external_operations")
      .select("operation_kind,status,created_at")
      .eq("fix_run_id", TARGET.fixRunId)
      .eq("workspace_id", TARGET.workspaceId)
      .order("created_at"),
    client
      .from("fix_pr_outcomes")
      .select("status,merged,deployed,created_at")
      .eq("fix_run_id", TARGET.fixRunId)
      .eq("workspace_id", TARGET.workspaceId)
      .order("created_at"),
  ]);
  if (
    [
      runResult,
      stageResult,
      attemptResult,
      diagnosisResult,
      planResult,
      patchResult,
      verificationResult,
      runnerDiagnosticResult,
      recoveryThreeResult,
      riskResult,
      externalResult,
      prResult,
    ].some((result) => result.error)
  ) {
    return { status: "unavailable", category: "fix_status_readback_unavailable" } as const;
  }
  const run = runResult.data;
  if (!run) return { status: "not_found", category: "fix_status_readback_not_found" } as const;
  const runnerDiagnosticEvents = sanitizeM1578RRunnerDiagnosticEvents(
    runnerDiagnosticResult.data ?? [],
  );
  if (runnerDiagnosticEvents === null) {
    return { status: "unavailable", category: "runner_diagnostics_readback_invalid" } as const;
  }
  const scopeMatches =
    run.workspace_id === TARGET.workspaceId &&
    run.product_id === TARGET.productId &&
    run.repository_id === TARGET.repositoryId &&
    run.source_mode === "internal_test" &&
    run.processing_mode === "evidence_only" &&
    run.provenance_mode === "evidence_only";
  if (!scopeMatches) return { status: "blocked", category: "fix_status_scope_mismatch" } as const;
  return {
    status: "readback",
    scopeMatches,
    fixRun: {
      id: run.id,
      workspaceId: run.workspace_id,
      productId: run.product_id,
      repositoryId: run.repository_id,
      sourceChangeId: run.source_change_id,
      sourceMode: run.source_mode,
      processingMode: run.processing_mode,
      provenanceMode: run.provenance_mode,
      status: run.status,
      currentStage: run.current_stage,
      riskLevel: run.risk_level,
      failureCategory: run.failure_category,
      commitSha: run.commit_sha,
      reviewDisposition: run.review_disposition,
      reviewReason: run.review_reason,
      productionExposureState: run.production_exposure_state,
    },
    stages: stageResult.data ?? [],
    modelAttempts: attemptResult.data ?? [],
    diagnoses: diagnosisResult.data ?? [],
    plans: planResult.data ?? [],
    patches: patchResult.data ?? [],
    verificationRuns: (verificationResult.data ?? []).map((verification) => ({
      id: verification.id,
      profileId: verification.profile_id,
      status: verification.status,
      checks: sanitizeM1578RVerificationChecks(verification.checks),
      durationMs: verification.duration_ms,
      patchFingerprint: verification.patch_fingerprint,
      attemptNumber: verification.attempt_number,
      createdAt: verification.created_at,
    })),
    runnerDiagnosticEvents,
    generationThreeAuthorizations: (recoveryThreeResult.data ?? []).map((authorization) => ({
      id: authorization.id,
      stageId: authorization.stage_id,
      generation: authorization.recovery_generation,
      priorFailure: authorization.prior_run_failure_category,
      priorStageFailure: authorization.prior_stage_failure_category,
      priorAttemptCount: authorization.prior_attempt_count,
      priorOperatorRetryCount: authorization.prior_operator_retry_count,
      patchId: authorization.patch_id,
      patchFingerprint: authorization.patch_fingerprint,
      cacheIdentityKey: authorization.cache_identity_key,
      cacheManifestFingerprint: authorization.cache_manifest_fingerprint,
      cacheArchiveSha256: authorization.cache_archive_sha256,
      cacheTreeSha256: authorization.cache_tree_sha256,
      runnerAccount: authorization.runner_attestation_account,
      runnerRegion: authorization.runner_attestation_region,
      runnerInstanceId: authorization.runner_attestation_instance_id,
      runnerImageId: authorization.runner_image_id,
      runnerProtocol: authorization.runner_protocol,
      diagnosticsContractVersion: authorization.diagnostics_contract_version,
      authorizedAt: authorization.authorized_at,
    })),
    riskAssessment: riskResult.data,
    externalOperations: externalResult.data ?? [],
    prOutcomes: prResult.data ?? [],
  } as const;
}

/**
 * Operator-only, fixed-scope M15.78R entry point. The verify action is read-only;
 * create_source invokes the existing idempotent internal-test persistence flow.
 * No IDs, source text, provider result, or downstream evidence are caller-controlled.
 */
export const m1578rInternalTestAcceptanceTask = schemaTask({
  id: "m1578r-internal-test-acceptance",
  schema: M1578RInternalTestAcceptanceInputSchema,
  retry: { maxAttempts: 1 },
  maxDuration: 180,
  queue: { concurrencyLimit: 1 },
  run: async (input) => {
    if (input.action === "read_fix_status") return inspectM1578RFixStatus();
    if (input.action === "diagnose_entitlement") {
      const client = createSupabaseServerClient();
      const { data: snapshot, error: snapshotError } = await client.rpc(
        "get_workspace_billing_snapshot_service",
        { p_workspace_id: TARGET.workspaceId },
      );
      if (snapshotError) {
        return { status: "unavailable", failureReasons: ["billing_snapshot_unavailable"] } as const;
      }
      const snapshotRecord = asRecord(snapshot);
      const subscription = asRecord(snapshotRecord?.subscription);
      const now = timestamp(snapshotRecord?.serverNow);
      if (!snapshotRecord || now === null) {
        return { status: "unavailable", failureReasons: ["billing_snapshot_invalid"] } as const;
      }
      const currentPeriodStart =
        typeof subscription?.currentPeriodStart === "string"
          ? subscription.currentPeriodStart
          : null;
      const trialStartedAt =
        typeof subscription?.trialStartedAt === "string" ? subscription.trialStartedAt : null;
      const usageWindowStart =
        currentPeriodStart ??
        trialStartedAt ??
        `${new Date(now).toISOString().slice(0, 7)}-01T00:00:00.000Z`;
      const { count, error: usageError } = await client
        .from("preflight_runs")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", TARGET.workspaceId)
        .gte("created_at", usageWindowStart);
      if (usageError || count === null) {
        return { status: "unavailable", failureReasons: ["preflight_usage_unavailable"] } as const;
      }
      return diagnosePreflightEntitlement({ snapshot, preflightRuns: count });
    }

    const readiness = await inspectReadiness(
      input.action === "create_source" ? input.fixtureCommitSha : undefined,
    );
    if (readiness.status !== "ready" || input.action === "verify") return readiness;

    try {
      const created = await persistInternalTestSourceChange({
        workspaceId: TARGET.workspaceId,
        productId: TARGET.productId,
        dependencyId: TARGET.dependencyId,
        acceptanceKey: SOURCE_ACCEPTANCE_KEY,
        baseline: SOURCE_BASELINE,
        changed: SOURCE_CHANGED,
      });
      const { data: provenance, error } = await createSupabaseServerClient()
        .from("source_changes")
        .select("workspace_id,source_mode,processing_mode")
        .eq("id", created.sourceChangeId)
        .maybeSingle();
      const provenanceMatches =
        !error &&
        provenance?.workspace_id === TARGET.workspaceId &&
        provenance.source_mode === "internal_test" &&
        provenance.processing_mode === "evidence_only";
      return {
        ...readiness,
        status: provenanceMatches ? "source_created" : "blocked",
        ...(provenanceMatches ? {} : { category: "internal_source_provenance_unverified" }),
        sourceId: created.sourceId,
        sourceChangeId: created.sourceChangeId,
        replayed: created.replayed,
        provenanceMatches,
      };
    } catch (error) {
      return {
        ...readiness,
        status: "blocked",
        category: safeFailureCategory(error),
      };
    }
  },
});
