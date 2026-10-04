import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

type QaSupabaseClient = SupabaseClient;

const expectedProjectRef = "lnljaacbptrubppoypaz";
const productionOrigin = "https://auterim.com";
const websiteUrl = "https://cal.com/";
const timestamp = new Date()
  .toISOString()
  .replace(/[-:.TZ]/g, "")
  .slice(0, 14);
const safeRun = {
  step: "configuration",
  userId: null as string | null,
  workspaceId: null as string | null,
  companyId: null as string | null,
};
let userId = "";
let workspaceId = "";
let companyId = "";

function requireValue(value: string | undefined) {
  if (!value) throw new Error("required_configuration_missing");
  return value;
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

async function requestApi<T = Record<string, unknown>>(
  accessToken: string,
  path: string,
  init?: RequestInit,
) {
  const response = await fetch(`${productionOrigin}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  return { response, body };
}

async function countRows(client: QaSupabaseClient, table: string, column: string, value: string) {
  const { count, error } = await client
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq(column, value);
  if (error) throw new Error("verification_query_failed");
  return count ?? 0;
}

async function countsForWorkspace(admin: QaSupabaseClient, userId: string, workspaceId: string) {
  const [workspaces, memberships, companies, onboarding] = await Promise.all([
    countRows(admin, "workspaces", "created_by", userId),
    countRows(admin, "workspace_members", "user_id", userId),
    countRows(admin, "companies", "workspace_id", workspaceId),
    countRows(admin, "workspace_onboarding", "workspace_id", workspaceId),
  ]);
  const { count: owners, error } = await admin
    .from("workspace_members")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("role", "owner");
  if (error) throw new Error("verification_query_failed");
  return { workspaces, memberships, owners: owners ?? 0, companies, onboarding };
}

async function subscriptionForWorkspace(admin: QaSupabaseClient, workspaceId: string) {
  const { data, error } = await admin
    .from("workspace_subscriptions")
    .select("plan,status,trial_started_at,trial_ends_at")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error("trial_verification_failed");
  return data;
}

async function main() {
  safeRun.step = "configuration";
  assert(process.env.AUTERIM_INTERNAL_QA_PRODUCTION === "1", "qa_guard_not_enabled");
  const url = requireValue(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const publishableKey = requireValue(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  const secretKey = requireValue(
    process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
  assert(new URL(url).hostname.startsWith(`${expectedProjectRef}.`), "wrong_supabase_project");

  const admin = createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const publicClient = createClient(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  safeRun.step = "identity_bootstrap";
  const email = `auterim-internal-qa+${timestamp}-${randomBytes(6).toString("hex")}@auterim.invalid`;
  const password = randomBytes(36).toString("base64url");
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      internal_qa: true,
      purpose: "production_e2e",
      created_by: "auterim_internal_acceptance",
    },
    app_metadata: { internal_qa: true, purpose: "production_e2e" },
  });
  if (createError || !created.user) throw new Error("qa_identity_creation_failed");
  safeRun.userId = created.user.id;
  userId = created.user.id;

  const { data: signedIn, error: signInError } = await publicClient.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError || !signedIn.session || signedIn.user.id !== created.user.id)
    throw new Error("qa_identity_sign_in_failed");
  const accessToken = signedIn.session.access_token;

  safeRun.step = "empty_account_check";
  const emptyAccount = await requestApi<{ workspaces?: unknown[] }>(
    accessToken,
    "/api/account/status",
  );
  assert(
    emptyAccount.response.ok && Array.isArray(emptyAccount.body?.workspaces),
    "account_status_failed",
  );
  assert(emptyAccount.body.workspaces.length === 0, "qa_identity_was_not_fresh");

  safeRun.step = "company_submit";
  const idempotencyKey = randomUUID();
  const companyInput = {
    workspaceName: "Auterim Internal QA",
    companyName: "Auterim Internal QA",
    websiteUrl,
    idempotencyKey,
  };
  const started = await requestApi<{
    workspaceId?: string;
    companyId?: string;
    state?: string;
    discoveryQueued?: boolean;
  }>(accessToken, "/api/onboarding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(companyInput),
  });
  assert(started.response.status === 202 || started.response.ok, "company_submit_failed");
  assert(
    typeof started.body?.workspaceId === "string" && typeof started.body.companyId === "string",
    "company_submit_missing_ids",
  );
  safeRun.workspaceId = started.body.workspaceId;
  safeRun.companyId = started.body.companyId;
  workspaceId = started.body.workspaceId;
  companyId = started.body.companyId;

  const firstCounts = await countsForWorkspace(admin, userId, workspaceId);
  assert(
    firstCounts.workspaces === 1 &&
      firstCounts.memberships === 1 &&
      firstCounts.owners === 1 &&
      firstCounts.companies === 1 &&
      firstCounts.onboarding === 1,
    "first_submit_created_duplicate_records",
  );
  assert(!(await subscriptionForWorkspace(admin, workspaceId)), "trial_started_before_activation");

  safeRun.step = "company_resubmit_contract";
  const replay = await requestApi<{ workspaceId?: string; companyId?: string }>(
    accessToken,
    "/api/onboarding",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(companyInput),
    },
  );
  assert(replay.response.ok, "idempotent_company_retry_failed");
  assert(
    replay.body?.workspaceId === workspaceId && replay.body.companyId === companyId,
    "idempotent_company_retry_changed_identity",
  );

  const editedCompany = await requestApi<{ workspaceId?: string; companyId?: string }>(
    accessToken,
    "/api/onboarding",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...companyInput,
        workspaceId,
        workspaceName: "Auterim Internal QA Updated",
        companyName: "Auterim Internal QA Updated",
        idempotencyKey: randomUUID(),
      }),
    },
  );
  assert(editedCompany.response.ok, "existing_workspace_company_resubmit_failed");
  assert(
    editedCompany.body?.workspaceId === workspaceId && editedCompany.body.companyId === companyId,
    "company_resubmit_changed_canonical_ids",
  );

  const implicitSecondWorkspace = await requestApi(accessToken, "/api/onboarding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...companyInput, idempotencyKey: randomUUID() }),
  });
  assert(
    implicitSecondWorkspace.response.status === 403,
    "implicit_second_workspace_was_not_blocked",
  );
  const afterResubmitCounts = await countsForWorkspace(admin, userId, workspaceId);
  assert(
    afterResubmitCounts.workspaces === 1 &&
      afterResubmitCounts.memberships === 1 &&
      afterResubmitCounts.owners === 1 &&
      afterResubmitCounts.companies === 1 &&
      afterResubmitCounts.onboarding === 1,
    "company_resubmit_created_duplicate_records",
  );
  assert(!(await subscriptionForWorkspace(admin, workspaceId)), "trial_started_before_activation");

  safeRun.step = "discovery_wait";
  let onboarding: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await requestApi<Record<string, unknown>>(
      accessToken,
      `/api/onboarding?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    assert(result.response.ok && result.body, "onboarding_read_model_failed");
    onboarding = result.body;
    const discovery = onboarding.discovery as { status?: string } | undefined;
    if (discovery?.status && discovery.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  assert(onboarding, "onboarding_read_model_missing");
  const discoveryModel = onboarding.discovery as {
    status?: string | null;
    candidates?: Array<{
      candidateId: string;
      providerName: string;
      suggestedStatus: string;
    }>;
  };
  assert(discoveryModel.status && discoveryModel.status !== "running", "discovery_did_not_settle");

  safeRun.step = "persisted_discovery_verify";
  const { data: run, error: runError } = await admin
    .from("dependency_discovery_runs")
    .select(
      "id,status,started_at,finished_at,trigger_run_id,candidate_count,evidence_count,coverage",
    )
    .eq("workspace_id", workspaceId)
    .eq("company_id", companyId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runError || !run) throw new Error("discovery_run_verification_failed");
  const { data: onboardingRow, error: onboardingError } = await admin
    .from("workspace_onboarding")
    .select("discovery_task_id,state,activated_at")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (onboardingError || !onboardingRow) throw new Error("onboarding_state_verification_failed");
  const coverage = (run.coverage ?? {}) as Record<string, unknown>;
  const runtime = (coverage.runtime ?? {}) as Record<string, unknown>;
  assert(Boolean(onboardingRow.discovery_task_id), "trigger_task_id_missing");

  const { data: candidateRows, error: candidateError } = await admin
    .from("discovered_dependencies")
    .select("id,status,confidence_label,dependency_catalog(name,slug)")
    .eq("workspace_id", workspaceId)
    .eq("company_id", companyId);
  if (candidateError) throw new Error("candidate_verification_failed");
  const { data: evidenceRows, error: evidenceError } = await admin
    .from("dependency_discovery_evidence")
    .select("signal_type,provider_slug")
    .eq("run_id", run.id);
  if (evidenceError) throw new Error("evidence_verification_failed");
  const evidenceFamilies = [...new Set((evidenceRows ?? []).map((row) => row.signal_type))];
  const suspiciousCoverage =
    /authorization|cookie|requestbody|responsebody|htmlbody|scriptbody|localstorage|token=/i.test(
      JSON.stringify(coverage),
    );
  const suspiciousEvidence =
    /authorization|cookie|requestbody|responsebody|htmlbody|scriptbody|localstorage|token=/i.test(
      JSON.stringify(evidenceRows),
    );
  assert(!suspiciousCoverage && !suspiciousEvidence, "sensitive_discovery_material_detected");

  safeRun.step = "dependency_review";
  const candidates = discoveryModel.candidates ?? [];
  const suggestedCloudflare = candidates.find(
    (candidate) =>
      candidate.providerName.toLowerCase() === "cloudflare" &&
      candidate.suggestedStatus === "candidate",
  );
  const firstSuggestion = candidates.find((candidate) => candidate.suggestedStatus === "candidate");
  const selectedCandidate = suggestedCloudflare ?? firstSuggestion;
  let dependencyPath: "discovered_confirmed" | "manual_add";
  if (selectedCandidate) {
    const decision = await requestApi(accessToken, "/api/onboarding/dependencies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "decision",
        workspaceId,
        candidateId: selectedCandidate.candidateId,
        decision: "confirmed",
      }),
    });
    assert(decision.response.ok, "dependency_confirmation_failed");
    dependencyPath = "discovered_confirmed";
    for (const candidate of candidates) {
      if (
        candidate.candidateId === selectedCandidate.candidateId ||
        candidate.suggestedStatus !== "candidate"
      )
        continue;
      const rejected = await requestApi(accessToken, "/api/onboarding/dependencies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "decision",
          workspaceId,
          candidateId: candidate.candidateId,
          decision: "rejected",
        }),
      });
      assert(rejected.response.ok, "candidate_rejection_failed");
    }
  } else {
    const manual = await requestApi(accessToken, "/api/onboarding/dependencies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "manual_add",
        workspaceId,
        dependencySlug: "cloudflare",
      }),
    });
    assert(manual.response.ok, "manual_dependency_add_failed");
    dependencyPath = "manual_add";
  }

  const completedDependencies = await requestApi(accessToken, "/api/onboarding/steps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId, step: "dependencies_review" }),
  });
  assert(completedDependencies.response.ok, "dependency_step_failed");
  assert(!(await subscriptionForWorkspace(admin, workspaceId)), "trial_started_before_activation");
  const completedContext = await requestApi(accessToken, "/api/onboarding/steps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId, step: "context_setup" }),
  });
  assert(completedContext.response.ok, "context_step_failed");
  assert(!(await subscriptionForWorkspace(admin, workspaceId)), "trial_started_before_activation");

  safeRun.step = "preferences";
  const preferences = await requestApi(accessToken, "/api/onboarding/preferences", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId,
      importantChanges: "instant",
      informational: "off",
      monthlyProtectionReport: true,
    }),
  });
  assert(preferences.response.ok, "preferences_save_failed");
  const completedPreferences = await requestApi(accessToken, "/api/onboarding/steps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId, step: "notifications_setup" }),
  });
  assert(completedPreferences.response.ok, "preferences_step_failed");
  assert(!(await subscriptionForWorkspace(admin, workspaceId)), "trial_started_before_activation");

  safeRun.step = "activation";
  const activation = await requestApi<{
    workspaceId?: string;
    activatedAt?: string;
    protection?: unknown;
  }>(accessToken, "/api/onboarding/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  assert(activation.response.ok && activation.body?.activatedAt, "protection_activation_failed");
  const subscription = await subscriptionForWorkspace(admin, workspaceId);
  assert(
    subscription?.plan === "pro" &&
      subscription.status === "trialing" &&
      subscription.trial_started_at === activation.body.activatedAt,
    "trial_activation_contract_failed",
  );

  safeRun.step = "dashboard_read_models";
  const account = await requestApi<Record<string, unknown>>(
    accessToken,
    `/api/account/status?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  assert(account.response.ok && account.body, "active_account_read_model_failed");
  const protection = await requestApi<Record<string, unknown>>(
    accessToken,
    `/api/protection?workspaceId=${encodeURIComponent(workspaceId)}&view=today`,
  );
  assert(
    protection.response.ok && protection.body?.currentStep === "active",
    "protection_read_model_failed",
  );
  const browser = await chromium.launch({ headless: true });
  let dashboard: { bodyTextLength: number; workspaceSelected: boolean };
  try {
    const page = await browser.newPage();
    const login = await page.goto(`${productionOrigin}/login`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    assert(login?.ok(), "login_page_failed");
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL((url) => url.pathname === "/app", { timeout: 20_000 });
    await page
      .getByText("Auterim Internal QA", { exact: false })
      .first()
      .waitFor({ timeout: 20_000 });
    const selectedWorkspace = await page.evaluate(() =>
      window.localStorage.getItem("auterim-workspace-id"),
    );
    assert(selectedWorkspace === workspaceId, "dashboard_workspace_selection_failed");
    dashboard = {
      bodyTextLength: await page.locator("body").evaluate((body) => body.textContent?.length ?? 0),
      workspaceSelected: true,
    };
    assert(dashboard.bodyTextLength > 0, "dashboard_empty");
  } finally {
    await browser.close();
  }

  safeRun.step = "complete";
  console.log(
    JSON.stringify({
      status: "complete",
      userId,
      workspaceId,
      companyId,
      qaIdentity: "internal_qa production_e2e",
      companySubmitCounts: afterResubmitCounts,
      onboardingState: onboardingRow.state,
      discovery: {
        runId: run.id,
        triggerRunId: onboardingRow.discovery_task_id,
        status: run.status,
        candidateCount: run.candidate_count,
        evidenceCount: run.evidence_count,
        outcome: coverage.outcome,
        html: coverage.html,
        javascript: coverage.javascript,
        runtime,
        providers: [...new Set((candidateRows ?? []).map((row) => row.dependency_catalog))],
        evidenceFamilies,
        confidenceLabels: [...new Set((candidateRows ?? []).map((row) => row.confidence_label))],
        privacyCheck: "passed",
      },
      dependencyPath,
      activation: {
        activatedAt: activation.body.activatedAt,
        protection: activation.body.protection,
        trialStartedAt: subscription.trial_started_at,
        trialEndsAt: subscription.trial_ends_at,
      },
      dashboard: { ...dashboard, protectionStatus: protection.body.status },
      cleanup: "deferred; auth deletion ownership semantics not yet proven",
    }),
  );
}

main().catch(() => {
  console.error(
    JSON.stringify({
      status: "failed",
      step: safeRun.step,
      userId,
      workspaceId,
      companyId,
      error: "details_suppressed_to_protect_credentials_and_provider_payloads",
    }),
  );
  process.exitCode = 1;
});
