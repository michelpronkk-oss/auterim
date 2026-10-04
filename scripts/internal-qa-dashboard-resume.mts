import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const expectedProjectRef = "lnljaacbptrubppoypaz";
const productionOrigin = "https://auterim.com";
let step = "configuration";

function required(value: string | undefined, code: string) {
  if (!value) throw new Error(code);
  return value;
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

async function requestApi<T>(accessToken: string, path: string) {
  const response = await fetch(`${productionOrigin}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => null)) as T | null;
  return { response, body };
}

async function main() {
  assert(process.env.AUTERIM_INTERNAL_QA_PRODUCTION === "1", "qa_guard_not_enabled");
  const userId = required(process.env.AUTERIM_INTERNAL_QA_USER_ID, "qa_user_id_missing");
  const workspaceId = required(
    process.env.AUTERIM_INTERNAL_QA_WORKSPACE_ID,
    "qa_workspace_id_missing",
  );
  const url = required(process.env.NEXT_PUBLIC_SUPABASE_URL, "supabase_url_missing");
  const publishableKey = required(
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    "supabase_publishable_key_missing",
  );
  const secretKey = required(
    process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
    "supabase_server_key_missing",
  );
  assert(new URL(url).hostname.startsWith(`${expectedProjectRef}.`), "wrong_supabase_project");
  const admin = createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const publicClient = createClient(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  step = "qa_identity_validation";
  const { data: identity, error: identityError } = await admin.auth.admin.getUserById(userId);
  if (identityError || !identity.user) throw new Error("qa_identity_not_found");
  assert(identity.user.app_metadata?.internal_qa === true, "identity_not_internal_qa");
  assert(identity.user.app_metadata?.purpose === "production_e2e", "identity_purpose_mismatch");

  step = "qa_workspace_validation";
  const { data: workspace, error: workspaceError } = await admin
    .from("workspaces")
    .select("id,name,created_by")
    .eq("id", workspaceId)
    .eq("created_by", userId)
    .maybeSingle();
  if (workspaceError || !workspace) throw new Error("qa_workspace_not_owned_by_identity");
  assert(workspace.name === "Auterim Internal QA", "workspace_name_mismatch");
  const { data: onboarding, error: onboardingError } = await admin
    .from("workspace_onboarding")
    .select("state,activated_at")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (onboardingError || !onboarding) throw new Error("qa_onboarding_state_missing");
  assert(onboarding.state === "active", "qa_workspace_not_active");

  const password = randomBytes(36).toString("base64url");
  const { error: passwordError } = await admin.auth.admin.updateUserById(userId, { password });
  if (passwordError || !identity.user.email) throw new Error("qa_password_rotation_failed");
  const { data: signedIn, error: signInError } = await publicClient.auth.signInWithPassword({
    email: identity.user.email,
    password,
  });
  if (signInError || !signedIn.session) throw new Error("qa_sign_in_failed");
  const accessToken = signedIn.session.access_token;

  step = "account_read_model";
  const account = await requestApi<{
    role?: string;
    onboarding?: { currentStep?: string; activation?: unknown; company?: { name?: string } };
  }>(accessToken, `/api/account/status?workspaceId=${encodeURIComponent(workspaceId)}`);
  assert(account.response.ok && account.body, "account_read_model_failed");
  assert(account.body.role === "owner", "qa_workspace_owner_missing");
  assert(account.body.onboarding?.currentStep === "active", "account_onboarding_not_active");
  assert(
    account.body.onboarding?.company?.name === "Auterim Internal QA",
    "account_company_mismatch",
  );

  step = "protection_read_model";
  const protection = await requestApi<{
    currentStep?: string;
    status?: string;
  }>(accessToken, `/api/protection?workspaceId=${encodeURIComponent(workspaceId)}&view=today`);
  assert(protection.response.ok && protection.body, "protection_read_model_failed");
  assert(protection.body.currentStep === "active", "protection_step_not_active");

  step = "dashboard_ui_login";
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const login = await page.goto(`${productionOrigin}/login`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    assert(login?.ok(), "login_page_failed");
    await page.locator('input[name="email"]').fill(identity.user.email);
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole("button", { name: /sign in/i }).click();
    step = "dashboard_ui_route";
    try {
      await page.waitForURL((next) => next.pathname === "/app", { timeout: 20_000 });
    } catch {
      const currentPath = new URL(page.url()).pathname;
      const statusMessage = (
        await page
          .locator('[role="status"]')
          .textContent()
          .catch(() => "")
      )
        ?.toLowerCase()
        .trim();
      const loginRejected = statusMessage?.includes("sign-in failed") ?? false;
      const routeError =
        currentPath === "/app/onboarding"
          ? "dashboard_redirected_to_onboarding"
          : currentPath === "/login"
            ? "dashboard_login_did_not_redirect"
            : "dashboard_route_unexpected";
      throw new Error(loginRejected ? "dashboard_login_rejected" : routeError);
    }
    await page.waitForTimeout(8_000);
    const dashboardProbe = await page.evaluate(() => {
      const text = document.body.innerText;
      return {
        todayHeading: Array.from(document.querySelectorAll("h1")).some(
          (heading) => heading.textContent?.trim() === "Today",
        ),
        companyVisible: text.includes("Auterim Internal QA"),
        loadingVisible: text.includes("Loading your protection workspace"),
        unavailableVisible: text.includes("We couldn’t load your protection workspace"),
        signedOutVisible: text.includes("Sign in to see your dependencies"),
      };
    });
    console.log(JSON.stringify({ dashboardProbe }));
    assert(dashboardProbe.todayHeading, "dashboard_today_page_missing");
    assert(dashboardProbe.companyVisible, "dashboard_company_missing");
    const selectedWorkspaceId = await page.evaluate(() =>
      window.localStorage.getItem("auterim-workspace-id"),
    );
    assert(selectedWorkspaceId === workspaceId, "dashboard_selected_workspace_mismatch");
    const workspaceSelector = page.locator('select[aria-label="Select workspace"]');
    const selectorCount = await workspaceSelector.count();
    assert(selectorCount > 0, "dashboard_workspace_selector_missing");
    assert(
      (await workspaceSelector.first().inputValue()) === workspaceId,
      "dashboard_selector_value_mismatch",
    );
    const dashboardTextLength = await page
      .locator("body")
      .evaluate((body) => body.textContent?.length ?? 0);
    assert(dashboardTextLength > 0, "dashboard_empty");
    console.log(
      JSON.stringify({
        status: "complete",
        userId,
        workspaceId,
        company: account.body.onboarding.company.name,
        onboardingState: onboarding.state,
        activatedAt: onboarding.activated_at,
        accountStatus: account.response.status,
        protectionStatus: protection.response.status,
        dashboard: { route: "/app", selectedWorkspaceId, selectorCount, dashboardTextLength },
        credentials: "ephemeral_and_not_reported",
      }),
    );
  } finally {
    await browser.close();
  }
}

main().catch((caught: unknown) => {
  const message = caught instanceof Error ? caught.message : "";
  const safeError = /^[a-z][a-z0-9_]{0,80}$/.test(message)
    ? message
    : caught instanceof Error && /^[A-Za-z]+$/.test(caught.name)
      ? `runtime_${caught.name.toLowerCase()}`
      : "unexpected_runtime_error";
  console.error(JSON.stringify({ status: "failed", step, error: safeError }));
  process.exitCode = 1;
});
