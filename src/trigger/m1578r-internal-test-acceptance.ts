import { schemaTask, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getEnvironment, isIntegrationConfigured } from "@/lib/env/schema";
import { persistInternalTestSourceChange } from "@/lib/monitoring/internal-test-source";
import { inspectGitHubInstallationScope } from "@/lib/fix-engine/github-write-token";
import { sanitizeM1578RRunnerDiagnosticEvents } from "@/lib/fix-engine/runner-diagnostic-readback";
import type { semanticClassifyChangeTask } from "@/trigger/classify-source-change";
import type { evaluateSourceChangeIntelligenceTask } from "@/trigger/evaluate-source-change-intelligence";
import type { startFixEngineFromGraphTask } from "@/trigger/start-fix-engine-from-graph";

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
export const M1578R_FRESH_ACCEPTANCE_KEY = "m1578r-internal-qa-fix-engine-v2";
export const M1578R_FRESH_V3_ACCEPTANCE_KEY = "m1578r-internal-qa-fix-engine-v3";
export const M1578R_FRESH_FIXTURE_COMMIT_SHA = "94135df6f85bfb34ac83c046e5541e1ad8d73a86";
type FreshAcceptanceGeneration = "v2" | "v3";
const FRESH_ACCEPTANCE_CONFIG: Record<
  FreshAcceptanceGeneration,
  { acceptanceKey: string; fixtureCommitSha: string }
> = {
  v2: {
    acceptanceKey: M1578R_FRESH_ACCEPTANCE_KEY,
    fixtureCommitSha: M1578R_FRESH_FIXTURE_COMMIT_SHA,
  },
  v3: {
    acceptanceKey: M1578R_FRESH_V3_ACCEPTANCE_KEY,
    fixtureCommitSha: M1578R_FRESH_FIXTURE_COMMIT_SHA,
  },
};
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

const FreshEndpointReferenceSchema = z
  .object({
    id: z.string().uuid(),
    analysis_run_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    repository_id: z.string().uuid(),
    commit_sha: z.string().regex(/^[a-f0-9]{40,64}$/),
    reference_type: z.literal("endpoint"),
    normalized_value: z.string().min(1).max(512),
    path: z.string().min(1).max(1024),
    start_line: z.number().int().positive(),
    start_column: z.number().int().positive().nullable(),
    end_line: z.number().int().positive(),
    end_column: z.number().int().positive().nullable(),
    confidence_class: z.enum(["exact", "structural", "heuristic"]),
    extractor_type: z.string().min(1).max(80),
    redacted: z.boolean(),
    value_fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();

/** Operator readback exposes only safe URL literals and bounded source provenance. */
export function sanitizeFreshEndpointReferences(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) return null;
  const parsed = z.array(FreshEndpointReferenceSchema).max(100).safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.map((reference) => {
    let safeEndpoint: string | null = null;
    if (!reference.redacted) {
      try {
        const url = new URL(reference.normalized_value);
        if (
          (url.protocol === "https:" || url.protocol === "http:") &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        ) {
          // Keep the analyzer's original spelling so path and slash distinctions remain visible.
          safeEndpoint = reference.normalized_value;
        }
      } catch {
        // Malformed or potentially sensitive endpoint strings are omitted from operator output.
      }
    }
    const segments = reference.path.split("/");
    const containsSensitivePath = segments.some((segment) => {
      const normalizedSegment = segment.toLowerCase();
      return (
        /^\.env(?:$|\.)/.test(normalizedSegment) ||
        [
          ".npmrc",
          ".pypirc",
          "credential",
          "credentials",
          "secret",
          "secrets",
          "id_rsa",
          "id_ed25519",
        ].includes(normalizedSegment) ||
        /^(?:credentials?|secrets?)\.(?:json|ya?ml|toml)$/.test(normalizedSegment) ||
        /\.(?:pem|key|p12|pfx)$/.test(normalizedSegment)
      );
    });
    const safePath =
      !reference.path.startsWith("/") &&
      !/^[A-Za-z]:/.test(reference.path) &&
      !reference.path.includes("\\") &&
      !segments.includes("..") &&
      !reference.path.includes("\0") &&
      !containsSensitivePath
        ? reference.path
        : null;
    return {
      id: reference.id,
      analysisRunId: reference.analysis_run_id,
      repositoryId: reference.repository_id,
      commitSha: reference.commit_sha,
      referenceType: reference.reference_type,
      normalizedValue: safeEndpoint,
      valueFingerprint: reference.redacted ? reference.value_fingerprint : null,
      valueRedacted: reference.redacted || safeEndpoint === null,
      path: safePath,
      startLine: reference.start_line,
      startColumn: reference.start_column,
      endLine: reference.end_line,
      endColumn: reference.end_column,
      confidenceClass: reference.confidence_class,
      extractorType: reference.extractor_type,
    };
  });
}

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
  z.object({ action: z.literal("verify_fresh") }).strict(),
  z.object({ action: z.literal("create_fresh_source") }).strict(),
  z.object({ action: z.literal("dispatch_fresh_intelligence") }).strict(),
  z.object({ action: z.literal("read_fresh_status") }).strict(),
  z.object({ action: z.literal("start_fresh_fix_run") }).strict(),
  z.object({ action: z.literal("verify_fresh_v3") }).strict(),
  z.object({ action: z.literal("create_fresh_v3_source") }).strict(),
  z.object({ action: z.literal("dispatch_fresh_v3_intelligence") }).strict(),
  z.object({ action: z.literal("read_fresh_v3_status") }).strict(),
  z.object({ action: z.literal("start_fresh_v3_fix_run") }).strict(),
  z.object({ action: z.literal("diagnose_entitlement") }).strict(),
  z
    .object({
      action: z.literal("create_source"),
      fixtureCommitSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
    })
    .strict(),
]);

export function freshAcceptanceDispatchKey(
  sourceChangeId: string,
  stage: "classify" | "intelligence" | "fix",
  generation: FreshAcceptanceGeneration = "v2",
) {
  if (!z.string().uuid().safeParse(sourceChangeId).success)
    throw new Error("invalid_source_change_id");
  return `m1578r-fresh-${generation}:${sourceChangeId}:${stage}`;
}

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
      .select(
        "id,profile_id,status,checks,duration_ms,patch_fingerprint,attempt_number,runner_job_id,runner_request_fingerprint,runner_result_fingerprint,runner_protocol,runner_version,runner_image,runner_result_signature_validated,created_at",
      )
      .eq("fix_run_id", TARGET.fixRunId)
      .eq("workspace_id", TARGET.workspaceId)
      .order("attempt_number"),
    client
      .from("fix_stage_runner_diagnostic_events")
      .select(
        "id,stage_id,attempt_number,failure_category,retryable,diagnostics,job_id,request_fingerprint,admission_state,created_at",
      )
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
      runnerJobId: verification.runner_job_id,
      runnerRequestFingerprint: verification.runner_request_fingerprint,
      runnerResultFingerprint: verification.runner_result_fingerprint,
      runnerProtocol: verification.runner_protocol,
      runnerVersion: verification.runner_version,
      runnerImage: verification.runner_image,
      runnerResultSignatureValidated: verification.runner_result_signature_validated,
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

function freshStatusUnavailable(category: string) {
  return { status: "unavailable", category } as const;
}

/** Fixed-key readback. Every downstream query is derived from the versioned source row. */
async function inspectFreshM1578RAcceptance(generation: FreshAcceptanceGeneration = "v2") {
  const { acceptanceKey, fixtureCommitSha } = FRESH_ACCEPTANCE_CONFIG[generation];
  const client = createSupabaseServerClient();
  const { data: source, error: sourceError } = await client
    .from("source_catalog")
    .select(
      "id,workspace_id,scope_product_id,dependency_id,source_mode,processing_mode,internal_acceptance_key",
    )
    .eq("internal_acceptance_key", acceptanceKey)
    .maybeSingle();
  if (sourceError) return freshStatusUnavailable("fresh_source_read_failed");
  if (!source) return { status: "not_started", source: null } as const;
  if (
    source.workspace_id !== TARGET.workspaceId ||
    source.scope_product_id !== TARGET.productId ||
    source.dependency_id !== TARGET.dependencyId ||
    source.source_mode !== "internal_test" ||
    source.processing_mode !== "evidence_only"
  )
    return { status: "blocked", category: "fresh_source_scope_mismatch" } as const;

  const { data: changes, error: changeError } = await client
    .from("source_changes")
    .select("id,workspace_id,scope_product_id,source_mode,processing_mode,created_at")
    .eq("source_id", source.id)
    .order("created_at", { ascending: true })
    .limit(2);
  if (changeError) return freshStatusUnavailable("fresh_source_change_read_failed");
  if ((changes ?? []).length > 1)
    return { status: "blocked", category: "fresh_source_change_cardinality_invalid" } as const;
  const change = changes?.[0] ?? null;
  if (!change)
    return {
      status: "source_created",
      source: {
        id: source.id,
        sourceMode: source.source_mode,
        processingMode: source.processing_mode,
      },
      sourceChange: null,
    } as const;
  if (
    change.workspace_id !== TARGET.workspaceId ||
    change.scope_product_id !== TARGET.productId ||
    change.source_mode !== "internal_test" ||
    change.processing_mode !== "evidence_only"
  )
    return { status: "blocked", category: "fresh_source_change_scope_mismatch" } as const;

  const [classificationResult, decisionResult, routeResult] = await Promise.all([
    client
      .from("source_change_classifications")
      .select("id,status,material,category,decision_status,confidence,created_at")
      .eq("change_id", change.id)
      .order("created_at", { ascending: false })
      .limit(4),
    client
      .from("change_intelligence_decisions")
      .select(
        "id,status,provider,model,response_model,proposed_route,proposed_policy_state,policy_reason,policy_version,created_at",
      )
      .eq("source_change_id", change.id)
      .order("created_at", { ascending: false })
      .limit(4),
    client
      .from("intelligence_route_intents")
      .select(
        "id,workspace_id,route,route_target,policy_state,route_status,review_disposition,review_reason,created_at",
      )
      .eq("source_change_id", change.id)
      .order("created_at", { ascending: false })
      .limit(4),
  ]);
  if (classificationResult.error || decisionResult.error || routeResult.error)
    return freshStatusUnavailable("fresh_intelligence_read_failed");
  const routes = routeResult.data ?? [];
  if (routes.some((route) => route.workspace_id !== TARGET.workspaceId))
    return { status: "blocked", category: "fresh_route_scope_mismatch" } as const;
  const routeIds = routes.map((route) => route.id);
  const handoffResult = routeIds.length
    ? await client
        .from("code_analysis_route_handoffs")
        .select(
          "workspace_id,route_intent_id,analysis_run_id,product_id,repository_id,commit_sha,status",
        )
        .in("route_intent_id", routeIds)
        .eq("workspace_id", TARGET.workspaceId)
        .eq("product_id", TARGET.productId)
        .eq("repository_id", TARGET.repositoryId)
        .limit(8)
    : { data: [], error: null };
  if (handoffResult.error) return freshStatusUnavailable("fresh_analysis_handoff_read_failed");
  const handoffs = handoffResult.data ?? [];
  if (
    handoffs.some(
      (handoff) =>
        handoff.workspace_id !== TARGET.workspaceId ||
        handoff.product_id !== TARGET.productId ||
        handoff.repository_id !== TARGET.repositoryId ||
        handoff.commit_sha !== fixtureCommitSha,
    )
  )
    return { status: "blocked", category: "fresh_analysis_handoff_scope_mismatch" } as const;
  const analysisIds = [...new Set(handoffs.map((handoff) => handoff.analysis_run_id))];
  const analysisResult = analysisIds.length
    ? await client
        .from("code_analysis_runs")
        .select(
          "id,workspace_id,repository_id,commit_sha,analyzer_version,analysis_profile,status,coverage_state,files_discovered,files_analyzed,files_skipped,parse_failures",
        )
        .in("id", analysisIds)
        .eq("workspace_id", TARGET.workspaceId)
        .eq("repository_id", TARGET.repositoryId)
        .limit(8)
    : { data: [], error: null };
  if (analysisResult.error) return freshStatusUnavailable("fresh_analysis_read_failed");
  const analyses = analysisResult.data ?? [];
  const graphResult = await client
    .from("impact_graph_builds")
    .select(
      "id,workspace_id,product_id,repository_id,source_change_id,route_intent_id,analysis_run_id,commit_sha,analyzer_version,analysis_profile,graph_builder_version,policy_version,coverage_state,assessment_state,production_exposure_state,status,expected_node_count,expected_edge_count,completed_at",
    )
    .eq("source_change_id", change.id)
    .eq("workspace_id", TARGET.workspaceId)
    .eq("product_id", TARGET.productId)
    .eq("repository_id", TARGET.repositoryId)
    .eq("commit_sha", fixtureCommitSha)
    .order("created_at", { ascending: false })
    .limit(4);
  if (graphResult.error) return freshStatusUnavailable("fresh_graph_read_failed");
  const graphs = graphResult.data ?? [];
  if (
    graphs.some(
      (graph) =>
        graph.workspace_id !== TARGET.workspaceId ||
        graph.product_id !== TARGET.productId ||
        graph.repository_id !== TARGET.repositoryId ||
        graph.source_change_id !== change.id ||
        graph.commit_sha !== fixtureCommitSha,
    )
  )
    return { status: "blocked", category: "fresh_graph_scope_mismatch" } as const;
  const analysisById = new Map(analyses.map((analysis) => [analysis.id, analysis]));
  const handoffByRouteAndAnalysis = new Set(
    handoffs
      .filter((handoff) => handoff.status === "completed")
      .map((handoff) => `${handoff.route_intent_id}:${handoff.analysis_run_id}`),
  );
  if (
    graphs.some((graph) => {
      const analysis = analysisById.get(graph.analysis_run_id);
      return (
        !analysis ||
        analysis.status !== "completed" ||
        analysis.workspace_id !== TARGET.workspaceId ||
        analysis.repository_id !== TARGET.repositoryId ||
        analysis.commit_sha !== fixtureCommitSha ||
        !handoffByRouteAndAnalysis.has(`${graph.route_intent_id}:${graph.analysis_run_id}`)
      );
    })
  )
    return { status: "blocked", category: "fresh_graph_analysis_link_mismatch" } as const;
  const graphIds = graphs.map((graph) => graph.id);
  const [graphEdgeResult, endpointReferenceResult] = await Promise.all([
    graphIds.length
      ? client
          .from("impact_graph_edges")
          .select(
            "id,graph_build_id,workspace_id,source_change_id,analysis_run_id,product_id,repository_id,commit_sha,edge_type,edge_kind,evidence_type,code_relation_id,code_reference_id,evidence_path,evidence_start_line,evidence_start_column,evidence_end_line,evidence_end_column,confidence_class,edge_fingerprint",
          )
          .in("graph_build_id", graphIds)
          .eq("workspace_id", TARGET.workspaceId)
          .eq("source_change_id", change.id)
          .eq("product_id", TARGET.productId)
          .eq("repository_id", TARGET.repositoryId)
          .eq("commit_sha", fixtureCommitSha)
          .order("edge_fingerprint", { ascending: true })
          .limit(200)
      : Promise.resolve({ data: [], error: null }),
    analysisIds.length
      ? client
          .from("code_external_references")
          .select(
            "id,analysis_run_id,workspace_id,repository_id,commit_sha,reference_type,normalized_value,path,start_line,start_column,end_line,end_column,confidence_class,extractor_type,redacted,value_fingerprint",
            { count: "exact" },
          )
          .in("analysis_run_id", analysisIds)
          .eq("workspace_id", TARGET.workspaceId)
          .eq("repository_id", TARGET.repositoryId)
          .eq("commit_sha", fixtureCommitSha)
          .eq("reference_type", "endpoint")
          .order("path", { ascending: true })
          .order("start_line", { ascending: true })
          .limit(100)
      : Promise.resolve({ data: [], error: null, count: 0 }),
  ]);
  if (graphEdgeResult.error) return freshStatusUnavailable("fresh_graph_edge_read_failed");
  if (
    endpointReferenceResult.error ||
    (analysisIds.length > 0 && endpointReferenceResult.count === null)
  )
    return freshStatusUnavailable("fresh_endpoint_reference_read_failed");
  const graphEdges = graphEdgeResult.data ?? [];
  const endpointReferences = sanitizeFreshEndpointReferences(endpointReferenceResult.data ?? []);
  if (endpointReferences === null || (endpointReferenceResult.count ?? 0) > 100)
    return { status: "blocked", category: "fresh_endpoint_reference_read_bound_exceeded" } as const;
  if (
    graphEdges.some(
      (edge) =>
        !graphIds.includes(edge.graph_build_id) ||
        edge.workspace_id !== TARGET.workspaceId ||
        edge.source_change_id !== change.id ||
        edge.analysis_run_id !==
          graphs.find((graph) => graph.id === edge.graph_build_id)?.analysis_run_id ||
        edge.product_id !== TARGET.productId ||
        edge.repository_id !== TARGET.repositoryId ||
        edge.commit_sha !== fixtureCommitSha,
    )
  )
    return { status: "blocked", category: "fresh_graph_edge_scope_mismatch" } as const;
  const graphEdgeCountByBuild = new Map<string, number>();
  for (const edge of graphEdges)
    graphEdgeCountByBuild.set(
      edge.graph_build_id,
      (graphEdgeCountByBuild.get(edge.graph_build_id) ?? 0) + 1,
    );
  if (
    graphs.some(
      (graph) =>
        graph.status === "completed" &&
        graphEdgeCountByBuild.get(graph.id) !== graph.expected_edge_count,
    )
  )
    return { status: "blocked", category: "fresh_graph_edge_count_mismatch" } as const;
  const fixResult = await client
    .from("fix_runs")
    .select(
      "id,workspace_id,product_id,repository_id,source_change_id,graph_build_id,analysis_run_id,commit_sha,source_mode,processing_mode,provenance_mode,status,current_stage,risk_level,failure_category,review_disposition,review_reason,production_exposure_state",
    )
    .eq("source_change_id", change.id)
    .eq("workspace_id", TARGET.workspaceId)
    .eq("product_id", TARGET.productId)
    .eq("repository_id", TARGET.repositoryId)
    .eq("commit_sha", fixtureCommitSha)
    .order("created_at", { ascending: false })
    .limit(2);
  if (fixResult.error) return freshStatusUnavailable("fresh_fix_run_read_failed");
  const fixRuns = fixResult.data ?? [];
  if (fixRuns.length > 1)
    return { status: "blocked", category: "fresh_fix_run_cardinality_invalid" } as const;
  const fixRun = fixRuns[0] ?? null;
  if (
    fixRun &&
    (fixRun.source_mode !== "internal_test" ||
      fixRun.processing_mode !== "evidence_only" ||
      fixRun.provenance_mode !== "evidence_only" ||
      !graphIds.includes(fixRun.graph_build_id) ||
      fixRun.analysis_run_id !==
        graphs.find((graph) => graph.id === fixRun.graph_build_id)?.analysis_run_id ||
      fixRun.commit_sha !== fixtureCommitSha)
  )
    return { status: "blocked", category: "fresh_fix_run_scope_mismatch" } as const;

  let fixArtifacts: Record<string, unknown> | null = null;
  if (fixRun) {
    const [stages, attempts, diagnoses, plans, patches, verifications, diagnostics, risk] =
      await Promise.all([
        client
          .from("fix_stage_queue")
          .select("id,stage,status,attempt_count,failure_category,completed_at")
          .eq("fix_run_id", fixRun.id)
          .eq("workspace_id", TARGET.workspaceId)
          .order("created_at"),
        client
          .from("fix_model_attempts")
          .select("id,stage,attempt_number,provider,model,status,failure_category,created_at")
          .eq("fix_run_id", fixRun.id)
          .eq("workspace_id", TARGET.workspaceId)
          .order("created_at"),
        client
          .from("fix_diagnoses")
          .select(
            "id,provider,model,model_version,schema_version,prompt_contract_version,created_at",
          )
          .eq("fix_run_id", fixRun.id)
          .eq("workspace_id", TARGET.workspaceId)
          .limit(2),
        client
          .from("fix_plans")
          .select("id,plan_version,plan_fingerprint,provider,model,created_at")
          .eq("fix_run_id", fixRun.id)
          .eq("workspace_id", TARGET.workspaceId)
          .order("plan_version"),
        client
          .from("fix_patches")
          .select(
            "id,attempt_number,base_sha,patch_fingerprint,changed_paths,line_count,byte_count,status,created_at",
          )
          .eq("fix_run_id", fixRun.id)
          .eq("workspace_id", TARGET.workspaceId)
          .order("attempt_number"),
        client
          .from("fix_verification_runs")
          .select(
            "id,profile_id,status,checks,duration_ms,patch_fingerprint,attempt_number,runner_job_id,runner_request_fingerprint,runner_result_fingerprint,runner_protocol,runner_version,runner_image,runner_result_signature_validated,created_at",
          )
          .eq("fix_run_id", fixRun.id)
          .eq("workspace_id", TARGET.workspaceId)
          .order("attempt_number"),
        client
          .from("fix_stage_runner_diagnostic_events")
          .select(
            "id,stage_id,attempt_number,failure_category,retryable,diagnostics,job_id,request_fingerprint,admission_state,created_at",
          )
          .eq("fix_run_id", fixRun.id)
          .eq("workspace_id", TARGET.workspaceId)
          .eq("stage", "verify_patch")
          .order("attempt_number")
          .limit(4),
        client
          .from("fix_risk_assessments")
          .select(
            "id,risk_version,risk_level,review_required,review_reason,input_fingerprint,created_at",
          )
          .eq("fix_run_id", fixRun.id)
          .eq("workspace_id", TARGET.workspaceId)
          .maybeSingle(),
      ]);
    const results = [stages, attempts, diagnoses, plans, patches, verifications, diagnostics, risk];
    if (results.some((result) => result.error))
      return freshStatusUnavailable("fresh_fix_artifact_read_failed");
    const diagnosticEvents = sanitizeM1578RRunnerDiagnosticEvents(diagnostics.data ?? []);
    if (diagnosticEvents === null)
      return freshStatusUnavailable("fresh_runner_diagnostics_invalid");
    fixArtifacts = {
      stages: stages.data ?? [],
      modelAttempts: attempts.data ?? [],
      diagnoses: diagnoses.data ?? [],
      plans: plans.data ?? [],
      patches: patches.data ?? [],
      verificationRuns: (verifications.data ?? []).map((verification) => ({
        id: verification.id,
        profileId: verification.profile_id,
        status: verification.status,
        checks: sanitizeM1578RVerificationChecks(verification.checks),
        durationMs: verification.duration_ms,
        patchFingerprint: verification.patch_fingerprint,
        attemptNumber: verification.attempt_number,
        runnerJobId: verification.runner_job_id,
        runnerRequestFingerprint: verification.runner_request_fingerprint,
        runnerResultFingerprint: verification.runner_result_fingerprint,
        runnerProtocol: verification.runner_protocol,
        runnerVersion: verification.runner_version,
        runnerImage: verification.runner_image,
        runnerResultSignatureValidated: verification.runner_result_signature_validated,
        createdAt: verification.created_at,
      })),
      runnerDiagnosticEvents: diagnosticEvents,
      riskAssessment: risk.data,
    };
  }

  return {
    status: "readback",
    fixtureCommitSha,
    source: {
      id: source.id,
      sourceMode: source.source_mode,
      processingMode: source.processing_mode,
    },
    sourceChange: { id: change.id, createdAt: change.created_at },
    classifications: classificationResult.data ?? [],
    intelligenceDecisions: decisionResult.data ?? [],
    routeIntents: routes,
    repositoryHandoffs: handoffs,
    analyses,
    codeEndpointReferences: endpointReferences,
    graphBuilds: graphs,
    graphEdges,
    fixRun,
    fixArtifacts,
  } as const;
}

async function startFreshM1578RFixRun(generation: FreshAcceptanceGeneration = "v2") {
  const { fixtureCommitSha } = FRESH_ACCEPTANCE_CONFIG[generation];
  const status = await inspectFreshM1578RAcceptance(generation);
  if (status.status !== "readback" || !status.sourceChange?.id)
    return { status: "blocked", category: "fresh_acceptance_not_readable" } as const;
  const completedGraphs = status.graphBuilds.filter(
    (graph) => graph.status === "completed" && graph.commit_sha === fixtureCommitSha,
  );
  if (completedGraphs.length !== 1)
    return { status: "blocked", category: "fresh_graph_not_unique_and_complete" } as const;
  const graph = completedGraphs[0]!;
  const route = status.routeIntents.find((item) => item.id === graph.route_intent_id);
  if (
    !route ||
    route.workspace_id !== TARGET.workspaceId ||
    !["continue_candidate", "escalate", "insufficient_evidence"].includes(route.policy_state)
  )
    return { status: "blocked", category: "fresh_route_not_fix_eligible" } as const;
  const client = createSupabaseServerClient();
  const [observed, inferred] = await Promise.all([
    client
      .from("impact_graph_edges")
      .select("id", { count: "exact", head: true })
      .eq("graph_build_id", graph.id)
      .eq("workspace_id", TARGET.workspaceId)
      .eq("source_change_id", status.sourceChange.id)
      .eq("edge_kind", "observed"),
    client
      .from("impact_graph_edges")
      .select("id", { count: "exact", head: true })
      .eq("graph_build_id", graph.id)
      .eq("workspace_id", TARGET.workspaceId)
      .eq("source_change_id", status.sourceChange.id)
      .eq("edge_kind", "inferred"),
  ]);
  if (observed.error || inferred.error)
    return { status: "blocked", category: "fresh_graph_evidence_read_failed" } as const;
  if ((observed.count ?? 0) < 1 || (inferred.count ?? 0) < 1)
    return { status: "blocked", category: "fresh_graph_positive_evidence_required" } as const;
  const started = await tasks.trigger<typeof startFixEngineFromGraphTask>(
    "start-fix-engine-from-graph",
    { graphBuildId: graph.id },
    {
      idempotencyKey: freshAcceptanceDispatchKey(status.sourceChange.id, "fix", generation),
      idempotencyKeyTTL: "30d",
    },
  );
  return {
    status: "dispatched",
    graphBuildId: graph.id,
    startFixEngineRunId: started.id,
    idempotentKey: freshAcceptanceDispatchKey(status.sourceChange.id, "fix", generation),
  } as const;
}

async function dispatchFreshM1578RIntelligence(generation: FreshAcceptanceGeneration = "v2") {
  const status = await inspectFreshM1578RAcceptance(generation);
  if (status.status !== "readback" || !status.sourceChange?.id)
    return { status: "blocked", category: "fresh_acceptance_not_readable" } as const;
  if (
    !status.classifications.some(
      (classification) =>
        classification.status === "classified" && classification.decision_status === "classified",
    )
  )
    return { status: "waiting", category: "fresh_classification_not_persisted" } as const;
  if (status.intelligenceDecisions.length > 0)
    return {
      status: "already_evaluated",
      sourceChangeId: status.sourceChange.id,
      decisionCount: status.intelligenceDecisions.length,
    } as const;
  const started = await tasks.trigger<typeof evaluateSourceChangeIntelligenceTask>(
    "evaluate-source-change-intelligence",
    { sourceChangeId: status.sourceChange.id },
    {
      idempotencyKey: freshAcceptanceDispatchKey(
        status.sourceChange.id,
        "intelligence",
        generation,
      ),
      idempotencyKeyTTL: "30d",
    },
  );
  return {
    status: "dispatched",
    sourceChangeId: status.sourceChange.id,
    intelligenceRunId: started.id,
    idempotentKey: freshAcceptanceDispatchKey(status.sourceChange.id, "intelligence", generation),
  } as const;
}

async function createFreshM1578RSource(generation: FreshAcceptanceGeneration) {
  const { acceptanceKey, fixtureCommitSha } = FRESH_ACCEPTANCE_CONFIG[generation];
  const readiness = await inspectReadiness(fixtureCommitSha);
  if (readiness.status !== "ready") return readiness;
  try {
    const created = await persistInternalTestSourceChange({
      workspaceId: TARGET.workspaceId,
      productId: TARGET.productId,
      dependencyId: TARGET.dependencyId,
      acceptanceKey,
      baseline: SOURCE_BASELINE,
      changed: SOURCE_CHANGED,
    });
    const persisted = await inspectFreshM1578RAcceptance(generation);
    if (persisted.status !== "readback" || persisted.sourceChange?.id !== created.sourceChangeId)
      return { status: "blocked", category: "fresh_source_persistence_unverified" } as const;
    const classificationRun = await tasks.trigger<typeof semanticClassifyChangeTask>(
      "classify-source-change",
      { sourceChangeId: created.sourceChangeId },
      {
        idempotencyKey: freshAcceptanceDispatchKey(created.sourceChangeId, "classify", generation),
        idempotencyKeyTTL: "30d",
      },
    );
    return {
      ...readiness,
      status: "source_created_classifier_dispatched",
      sourceId: created.sourceId,
      sourceChangeId: created.sourceChangeId,
      fixtureCommitSha,
      acceptanceKey,
      replayed: created.replayed,
      classifierRunId: classificationRun.id,
    } as const;
  } catch (error) {
    return {
      ...readiness,
      status: "blocked",
      category: safeFailureCategory(error),
    } as const;
  }
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
    if (input.action === "read_fresh_status") return inspectFreshM1578RAcceptance();
    if (input.action === "verify_fresh") return inspectReadiness(M1578R_FRESH_FIXTURE_COMMIT_SHA);
    if (input.action === "dispatch_fresh_intelligence") return dispatchFreshM1578RIntelligence();
    if (input.action === "start_fresh_fix_run") return startFreshM1578RFixRun();
    if (input.action === "read_fresh_v3_status") return inspectFreshM1578RAcceptance("v3");
    if (input.action === "verify_fresh_v3")
      return inspectReadiness(FRESH_ACCEPTANCE_CONFIG.v3.fixtureCommitSha);
    if (input.action === "dispatch_fresh_v3_intelligence")
      return dispatchFreshM1578RIntelligence("v3");
    if (input.action === "start_fresh_v3_fix_run") return startFreshM1578RFixRun("v3");
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

    if (input.action === "create_fresh_source") return createFreshM1578RSource("v2");
    if (input.action === "create_fresh_v3_source") return createFreshM1578RSource("v3");

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
