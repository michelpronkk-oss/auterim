import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const { loadEnvConfig } = createRequire(import.meta.url)("@next/env") as typeof import("@next/env");
loadEnvConfig(process.cwd());

const expectedProjectRef = "lnljaacbptrubppoypaz";
const productionOrigin = "https://auterim.com";
const purpose = "provider_catalog_acceptance";
let runId = `${new Date()
  .toISOString()
  .replace(/[-:.TZ]/g, "")
  .slice(0, 14)}-${randomUUID()}`;
const timeoutMs = 120_000;
let step = "configuration";
let userId: string | null = null;
let workspaceId: string | null = null;
let companyId: string | null = null;

type QaClient = SupabaseClient;
type ApiResult<T> = { response: Response; body: T | null };
type CatalogResult = {
  id: string;
  slug: string;
  name: string;
  category: string;
  authoritativeSourceCount: number;
  coverageStatus: "strong_coverage" | "partial_coverage" | "coverage_pending" | "coverage_unknown";
};
type WorkspaceDependency = {
  id: string;
  origin: string;
  monitoring_enabled: boolean;
  dependency_catalog: { slug: string; name: string } | Array<{ slug: string; name: string }>;
};

const expectedProviders = [
  { query: "Stripe", slug: "stripe", category: "payments", coverage: "partial_coverage" },
  {
    query: "Cloudflare",
    slug: "cloudflare",
    category: "infrastructure",
    coverage: "partial_coverage",
  },
  { query: "Vercel", slug: "vercel", category: "infrastructure", coverage: "partial_coverage" },
  { query: "Auth0", slug: "auth0", category: "identity", coverage: "partial_coverage" },
  {
    query: "MongoDB Atlas",
    slug: "mongodb-atlas",
    category: "databases",
    coverage: "partial_coverage",
  },
  { query: "Cohere", slug: "cohere", category: "ai", coverage: "partial_coverage" },
  { query: "Groq", slug: "groq", category: "ai", coverage: "partial_coverage" },
  { query: "Render", slug: "render", category: "infrastructure", coverage: "partial_coverage" },
  {
    query: "Docker Hub",
    slug: "docker-hub",
    category: "developer-tools",
    coverage: "partial_coverage",
  },
  { query: "Snyk", slug: "snyk", category: "security", coverage: "partial_coverage" },
  {
    query: "Amazon Web Services",
    slug: "aws",
    category: "infrastructure",
    coverage: "coverage_pending",
  },
] as const;

function requireValue(value: string | undefined, code: string) {
  if (!value) throw new Error(code);
  return value;
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

async function requestApi<T>(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  const response = await fetch(`${productionOrigin}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => null)) as T | null;
  return { response, body };
}

function asDependencyCatalog(value: WorkspaceDependency["dependency_catalog"]) {
  return Array.isArray(value) ? value[0] : value;
}

async function searchProvider(accessToken: string, target: (typeof expectedProviders)[number]) {
  const result = await requestApi<{ dependencies?: CatalogResult[] }>(
    accessToken,
    `/api/onboarding/dependencies?workspaceId=${encodeURIComponent(workspaceId!)}&q=${encodeURIComponent(target.query)}`,
  );
  assert(result.response.ok && Array.isArray(result.body?.dependencies), "provider_search_failed");
  const provider = result.body.dependencies.find((candidate) => candidate.slug === target.slug);
  assert(provider, `provider_search_missing_${target.slug}`);
  assert(provider.category === target.category, `provider_category_mismatch_${target.slug}`);
  assert(provider.coverageStatus === target.coverage, `provider_coverage_mismatch_${target.slug}`);
  assert(
    provider.coverageStatus === "coverage_pending"
      ? provider.authoritativeSourceCount === 0
      : provider.authoritativeSourceCount > 0,
    `provider_source_count_mismatch_${target.slug}`,
  );
  return provider;
}

async function loadWorkspaceDependencies(client: QaClient) {
  const { data, error } = await client
    .from("workspace_dependencies")
    .select("id,origin,monitoring_enabled,dependency_catalog!inner(slug,name)")
    .eq("workspace_id", workspaceId!);
  if (error) throw new Error("workspace_dependency_read_failed");
  return ((data ?? []) as unknown as WorkspaceDependency[]).map((row) => ({
    ...row,
    provider: asDependencyCatalog(row.dependency_catalog),
  }));
}

async function main() {
  assert(
    process.env.AUTERIM_INTERNAL_QA_PROVIDER_CATALOG_PRODUCTION === "1",
    "qa_guard_not_enabled",
  );
  const url = requireValue(process.env.NEXT_PUBLIC_SUPABASE_URL, "supabase_url_missing");
  const publishableKey = requireValue(
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    "supabase_publishable_key_missing",
  );
  const secretKey = requireValue(
    process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
    "supabase_server_key_missing",
  );
  assert(new URL(url).hostname.startsWith(`${expectedProjectRef}.`), "wrong_supabase_project");

  const admin = createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const productClient = createClient(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  step = "qa_identity_creation";
  const password = randomBytes(36).toString("base64url");
  const resumeUserId = process.env.AUTERIM_INTERNAL_QA_PROVIDER_CATALOG_RESUME_USER_ID;
  const resumeWorkspaceId = process.env.AUTERIM_INTERNAL_QA_PROVIDER_CATALOG_RESUME_WORKSPACE_ID;
  let email: string;
  if (resumeUserId || resumeWorkspaceId) {
    assert(resumeUserId && resumeWorkspaceId, "qa_resume_identity_and_workspace_required");
    const { data: existing, error: existingError } =
      await admin.auth.admin.getUserById(resumeUserId);
    const metadata = existing.user?.app_metadata;
    assert(
      !existingError &&
        existing.user?.id === resumeUserId &&
        metadata?.internal_qa === true &&
        metadata?.purpose === purpose &&
        metadata?.disposable === true &&
        metadata?.created_by === "auterim_provider_catalog_acceptance" &&
        typeof metadata?.qa_run_id === "string" &&
        typeof existing.user.email === "string",
      "qa_resume_identity_not_owned_by_this_harness",
    );
    runId = metadata.qa_run_id;
    const { data: rotated, error: rotateError } = await admin.auth.admin.updateUserById(
      resumeUserId,
      { password },
    );
    assert(!rotateError && rotated.user?.id === resumeUserId, "qa_resume_password_rotation_failed");
    userId = resumeUserId;
    email = existing.user.email!;
    workspaceId = resumeWorkspaceId;
    const { data: workspace, error: workspaceError } = await admin
      .from("workspaces")
      .select("created_by")
      .eq("id", resumeWorkspaceId)
      .maybeSingle();
    assert(
      !workspaceError && workspace?.created_by === resumeUserId,
      "qa_resume_workspace_owner_mismatch",
    );
    const { data: company, error: companyError } = await admin
      .from("companies")
      .select("id")
      .eq("workspace_id", resumeWorkspaceId)
      .maybeSingle();
    assert(!companyError && company?.id, "qa_resume_company_missing");
    companyId = company.id;
  } else {
    email = `auterim-internal-qa+${runId}@auterim.invalid`;
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        internal_qa: true,
        purpose,
        qa_run_id: runId,
        disposable: true,
        created_by: "auterim_provider_catalog_acceptance",
      },
      app_metadata: {
        internal_qa: true,
        purpose,
        qa_run_id: runId,
        disposable: true,
        created_by: "auterim_provider_catalog_acceptance",
      },
    });
    if (createError || !created.user) throw new Error("qa_identity_creation_failed");
    userId = created.user.id;
  }

  step = "qa_product_sign_in";
  const { data: signedIn, error: signInError } = await productClient.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError || !signedIn.session || signedIn.user.id !== userId)
    throw new Error("qa_product_sign_in_failed");
  const accessToken = signedIn.session.access_token;

  step = "qa_account_scope_check";
  if (!resumeWorkspaceId) {
    const account = await requestApi<{ workspaces?: unknown[] }>(
      accessToken,
      "/api/account/status",
    );
    assert(account.response.ok && Array.isArray(account.body?.workspaces), "account_status_failed");
    assert(account.body.workspaces.length === 0, "qa_identity_not_fresh");
  }

  const workspaceName = `Auterim Internal QA - Provider Catalog ${runId}`;
  if (!resumeWorkspaceId) {
    step = "workspace_creation_via_product_flow";
    const start = await requestApi<{
      workspaceId?: string;
      companyId?: string;
      state?: string;
      discoveryQueued?: boolean;
    }>(accessToken, "/api/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName,
        companyName: workspaceName,
        websiteUrl: "https://auterim.com/",
        idempotencyKey: randomUUID(),
      }),
    });
    workspaceId = start.body?.workspaceId ?? null;
    companyId = start.body?.companyId ?? null;
    assert(workspaceId && companyId, "qa_product_workspace_creation_failed");
    assert(start.response.ok, "qa_product_discovery_dispatch_failed");
  }

  step = "workspace_owner_membership_verification";
  const { data: workspaceOwner, error: workspaceOwnerError } = await productClient
    .from("workspace_members")
    .select("workspace_id,role")
    .eq("workspace_id", workspaceId!)
    .eq("user_id", userId!)
    .maybeSingle();
  assert(
    !workspaceOwnerError && workspaceOwner?.role === "owner",
    "qa_workspace_owner_membership_missing",
  );

  step = "wait_for_resumable_dependency_review";
  const deadline = Date.now() + timeoutMs;
  let onboarding: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const result = await requestApi<Record<string, unknown>>(
      accessToken,
      `/api/onboarding?workspaceId=${encodeURIComponent(workspaceId!)}`,
    );
    assert(result.response.ok && result.body, "onboarding_read_failed");
    onboarding = result.body;
    if (onboarding.currentStep === "dependencies_review") break;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  assert(onboarding?.currentStep === "dependencies_review", "qa_discovery_did_not_reach_review");

  step = "provider_search_acceptance";
  const searched: CatalogResult[] = [];
  for (const target of expectedProviders) searched.push(await searchProvider(accessToken, target));

  step = "dependency_selection_and_retry_acceptance";
  const addedIds = new Map<string, string>();
  for (const provider of searched) {
    const add = await requestApi<{ workspaceDependencyId?: string }>(
      accessToken,
      "/api/onboarding/dependencies",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "manual_add",
          workspaceId,
          dependencySlug: provider.slug,
        }),
      },
    );
    assert(
      add.response.ok && add.body?.workspaceDependencyId,
      `provider_add_failed_${provider.slug}`,
    );
    addedIds.set(provider.slug, add.body.workspaceDependencyId);
  }
  const groqRetry = await requestApi<{ workspaceDependencyId?: string }>(
    accessToken,
    "/api/onboarding/dependencies",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "manual_add", workspaceId, dependencySlug: "groq" }),
    },
  );
  assert(
    groqRetry.response.ok && groqRetry.body?.workspaceDependencyId === addedIds.get("groq"),
    "duplicate_add_changed_workspace_dependency",
  );

  step = "reload_and_pending_protection_acceptance";
  const reloaded = await requestApi<{
    currentStep?: string;
    confirmedDependencies?: Array<{ providerName?: string }>;
  }>(accessToken, `/api/onboarding?workspaceId=${encodeURIComponent(workspaceId!)}`);
  assert(
    reloaded.response.ok && reloaded.body?.currentStep === "dependencies_review",
    "onboarding_resume_failed",
  );
  const reloadedNames = new Set(
    (reloaded.body.confirmedDependencies ?? []).map((item) => item.providerName),
  );
  for (const provider of searched)
    assert(reloadedNames.has(provider.name), `dependency_missing_after_reload_${provider.slug}`);

  const workspaceDependencies = await loadWorkspaceDependencies(productClient);
  assert(
    workspaceDependencies.length === expectedProviders.length,
    "workspace_dependency_count_mismatch",
  );
  const pendingAws = workspaceDependencies.find((row) => row.provider?.slug === "aws");
  assert(pendingAws && pendingAws.origin === "manual", "pending_provider_provenance_missing");
  assert(!pendingAws.monitoring_enabled, "pending_provider_marked_protected");

  step = "dependency_deselection_acceptance";
  const deselectId = addedIds.get("snyk");
  assert(deselectId, "qa_deselection_target_missing");
  const { data: deleted, error: deleteError } = await productClient
    .from("workspace_dependencies")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("id", deselectId)
    .select("id");
  if (deleteError) throw new Error("qa_dependency_deselection_failed");
  assert(deleted?.length === 1, "qa_dependency_deselection_missing");
  const afterDeselect = await loadWorkspaceDependencies(productClient);
  assert(
    !afterDeselect.some((row) => row.provider?.slug === "snyk"),
    "qa_dependency_remained_after_deselect",
  );
  assert(
    afterDeselect.some((row) => row.provider?.slug === "groq"),
    "qa_deselection_removed_other_provider",
  );

  step = "no_trial_verification";
  const { data: subscription, error: subscriptionError } = await admin
    .from("workspace_subscriptions")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (subscriptionError) throw new Error("qa_subscription_check_failed");
  assert(!subscription, "qa_workspace_started_a_trial_or_subscription");

  console.log(
    JSON.stringify({
      status: "complete",
      purpose,
      qaRunId: runId,
      userId,
      workspaceId,
      companyId,
      workspaceName,
      resumedExistingQaWorkspace: Boolean(resumeWorkspaceId),
      onboardingStep: "dependencies_review",
      providerSearches: searched.map((provider) => ({
        slug: provider.slug,
        category: provider.category,
        coverageStatus: provider.coverageStatus,
        authoritativeSourceCount: provider.authoritativeSourceCount,
      })),
      selectedCount: expectedProviders.length,
      duplicateAddIdempotent: true,
      pendingAwsProtected: false,
      deselectedProvider: "snyk",
      trialOrSubscriptionCreated: false,
    }),
  );
}

main().catch((caught: unknown) => {
  const message = caught instanceof Error ? caught.message : "";
  const safeError = /^[a-z][a-z0-9_]{0,80}$/.test(message) ? message : "unexpected_qa_error";
  console.error(
    JSON.stringify({ status: "failed", step, error: safeError, userId, workspaceId, companyId }),
  );
  process.exitCode = 1;
});
