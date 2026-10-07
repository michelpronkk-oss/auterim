import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type Stage = { name: string; status: "PASS" | "FAIL"; detail: string };
type LocalCredentials = { apiUrl: string; publishableKey: string; serviceKey: string };
type Tenant = { userId: string; workspaceId: string; productId: string; policyVersion: number };
type LocalRow = Record<string, unknown>;
type LocalDatabase = {
  public: {
    Tables: Record<
      string,
      { Row: LocalRow; Insert: LocalRow; Update: LocalRow; Relationships: [] }
    >;
    Views: Record<string, { Row: LocalRow; Relationships: [] }>;
    Functions: Record<string, { Args: Record<string, unknown>; Returns: unknown }>;
  };
};
type LocalClient = SupabaseClient<LocalDatabase>;

const workdirArgument = process.argv[2];
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = process.cwd();
const isolatedWorkdir = path.resolve(repositoryRoot, "node_modules", ".cache", "m15-local");
const stages: Stage[] = [];
const cleanupWorkspaceIds: string[] = [];
const cleanupUserIds: string[] = [];
let currentStage = "LOCAL_AUTH_RLS";

function record(name: string, ok: boolean, detail: string) {
  stages.push({ name, status: ok ? "PASS" : "FAIL", detail });
}

function assert(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}

function statusEnvironment(workdir: string): LocalCredentials {
  const command = process.platform === "win32" ? "supabase.exe" : "supabase";
  const status = spawnSync(command, ["status", "--workdir", workdir, "--output", "env"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024,
  });
  if (status.error || status.status !== 0) throw new Error("local_supabase_status_unavailable");

  const values = new Map<string, string>();
  for (const line of (status.stdout ?? "").split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const name = line.slice(0, equals).trim();
    const value = line
      .slice(equals + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    values.set(name, value);
  }
  const apiUrl = values.get("API_URL") ?? values.get("REST_URL");
  const publishableKey = values.get("PUBLISHABLE_KEY") ?? values.get("ANON_KEY");
  const serviceKey = values.get("SERVICE_ROLE_KEY") ?? values.get("SECRET_KEY");
  if (!apiUrl || !publishableKey || !serviceKey) throw new Error("local_supabase_keys_unavailable");
  if (
    !new Set(["http://127.0.0.1:65431", "http://localhost:65431", "http://[::1]:65431"]).has(
      new URL(apiUrl).origin,
    )
  ) {
    throw new Error("local_supabase_host_required");
  }
  return { apiUrl, publishableKey, serviceKey };
}

function createUserClient(local: LocalCredentials, accessToken: string): LocalClient {
  return createClient<LocalDatabase>(local.apiUrl, local.publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function row<T>(
  query: PromiseLike<{ data: T | null; error: unknown }>,
  code: string,
): Promise<T> {
  const result = await query;
  if (result.error || result.data === null) throw new Error(code);
  return result.data;
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

function permissionDenied(error: unknown) {
  return errorCode(error) === "42501";
}

function deniedWrite(result: { error: unknown; data: unknown }, allowFiltered = false) {
  if (result.error) return permissionDenied(result.error);
  if (!allowFiltered) return false;
  return result.data === null || (Array.isArray(result.data) && result.data.length === 0);
}

async function createWorkspaceAndProduct(
  admin: LocalClient,
  client: LocalClient,
  userId: string,
  suffix: string,
  nonce: string,
): Promise<Tenant> {
  const onboarding = await row(
    admin.rpc("start_workspace_onboarding", {
      p_actor_user_id: userId,
      p_workspace_name: `M15 RLS ${suffix.toUpperCase()}`,
      p_company_name: `M15 RLS ${suffix.toUpperCase()}`,
      p_website_url: `https://m15-${suffix}-${nonce}.example/`,
      p_website_domain: `m15-${suffix}-${nonce}.example`,
      p_idempotency_key: `m15-${suffix}-${nonce}`,
      p_workspace_id: null,
    }),
    "local_qa_workspace_create_failed",
  );
  const workspaceId = (onboarding as { workspaceId?: string }).workspaceId;
  assert(workspaceId, "local_qa_workspace_id_missing");
  cleanupWorkspaceIds.push(workspaceId);

  const product = await row<{ id: string }>(
    client
      .from("workspace_products")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("is_default", true)
      .single(),
    "local_qa_default_product_missing",
  );
  return { userId, workspaceId, productId: product.id as string, policyVersion: 0 };
}

async function savePolicy(client: LocalClient, tenant: Tenant) {
  const policy = await row(
    client.rpc("set_product_remediation_policy", {
      p_workspace_id: tenant.workspaceId,
      p_product_id: tenant.productId,
      p_enabled: true,
      p_draft_pr_preparation_allowed: true,
      p_automatic_workflow_handoff_allowed: true,
      p_approval_required: true,
      p_allowed_repository_ids: [],
    }),
    "local_qa_policy_write_failed",
  );
  return {
    ...tenant,
    policyVersion: Number((policy as { policy_version: number }).policy_version),
  };
}

async function createUsers(local: LocalCredentials, admin: LocalClient, nonce: string) {
  const tenants: Tenant[] = [];
  const clients: LocalClient[] = [];
  for (const suffix of ["a", "b"]) {
    const email = `m15-${suffix}-${nonce}@auterim.invalid`;
    const password = `Local-${randomUUID()}-Aa1!`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error("local_qa_user_create_failed");
    const userId = created.data.user.id;
    cleanupUserIds.push(userId);

    const signInClient = createClient<LocalDatabase>(local.apiUrl, local.publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const signedIn = await signInClient.auth.signInWithPassword({ email, password });
    if (signedIn.error || !signedIn.data.user || !signedIn.data.session) {
      throw new Error("local_qa_user_auth_failed");
    }
    clients.push(createUserClient(local, signedIn.data.session.access_token));
    tenants.push(await createWorkspaceAndProduct(admin, clients.at(-1)!, userId, suffix, nonce));
  }
  return { clients, tenants };
}

async function verifyTenantReads(clients: LocalClient[], tenants: Tenant[]) {
  for (let index = 0; index < tenants.length; index += 1) {
    const own = tenants[index]!;
    const other = tenants[index === 0 ? 1 : 0]!;
    const client = clients[index]!;

    const products = await row(
      client.from("workspace_products").select("id,workspace_id").order("workspace_id"),
      "local_qa_product_read_failed",
    );
    assert(
      Array.isArray(products) &&
        products.length === 1 &&
        products[0]?.id === own.productId &&
        products[0]?.workspace_id === own.workspaceId,
      "local_qa_product_rls_failed",
    );

    const policies = await row(
      client
        .from("product_remediation_policies")
        .select("workspace_id,product_id,policy_version,human_review_required,approval_required")
        .order("product_id"),
      "local_qa_policy_read_failed",
    );
    assert(
      Array.isArray(policies) &&
        policies.length === 1 &&
        policies[0]?.workspace_id === own.workspaceId &&
        policies[0]?.product_id === own.productId &&
        policies[0]?.policy_version === own.policyVersion &&
        policies[0]?.human_review_required === true &&
        policies[0]?.approval_required === true,
      "local_qa_policy_rls_failed",
    );

    const foreignProduct = await client
      .from("workspace_products")
      .select("id")
      .eq("id", other.productId)
      .maybeSingle();
    const foreignPolicy = await client
      .from("product_remediation_policies")
      .select("product_id")
      .eq("product_id", other.productId)
      .maybeSingle();
    assert(
      !foreignProduct.error &&
        foreignProduct.data === null &&
        !foreignPolicy.error &&
        foreignPolicy.data === null,
      "local_qa_cross_tenant_read_failed",
    );

    const foreignMutation = await client.rpc("set_product_remediation_policy", {
      p_workspace_id: other.workspaceId,
      p_product_id: other.productId,
      p_enabled: true,
      p_draft_pr_preparation_allowed: true,
      p_automatic_workflow_handoff_allowed: true,
      p_approval_required: true,
      p_allowed_repository_ids: [],
    });
    assert(foreignMutation.error?.code === "42501", "local_qa_cross_tenant_policy_write_allowed");
  }
}

async function main() {
  if (path.resolve(repositoryRoot) !== scriptRoot) {
    throw new Error("auterim_repository_root_required");
  }
  if (!workdirArgument || path.resolve(workdirArgument) !== isolatedWorkdir) {
    throw new Error("exact_isolated_local_workdir_required");
  }
  const config = await readFile(path.join(isolatedWorkdir, "supabase", "config.toml"), "utf8");
  if (!/^project_id\s*=\s*"auterim-m15-acceptance"\s*$/m.test(config)) {
    throw new Error("isolated_local_supabase_project_required");
  }
  const apiPort = config.match(/^\[api\][\s\S]*?^port\s*=\s*(\d+)\s*$/m)?.[1];
  if (!apiPort) throw new Error("isolated_local_supabase_api_port_missing");

  currentStage = "LOCAL_STACK";
  const local = statusEnvironment(isolatedWorkdir);
  if (new URL(local.apiUrl).port !== apiPort) {
    throw new Error("isolated_local_supabase_api_mismatch");
  }
  const admin = createClient<LocalDatabase>(local.apiUrl, local.serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const anon = createClient<LocalDatabase>(local.apiUrl, local.publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const nonce = randomUUID();
  let tenants: Tenant[] = [];
  let clients: LocalClient[] = [];

  try {
    currentStage = "AUTH_JWT_AND_WORKSPACES";
    ({ clients, tenants } = await createUsers(local, admin, nonce));
    record("AUTH_JWT", clients.length === 2, "two local Auth users signed in and used bearer JWTs");
    record(
      "WORKSPACE_PRODUCT_RLS",
      tenants.length === 2,
      "workspace and default products came from the onboarding RPC and trigger",
    );

    currentStage = "OWNER_POLICY_RPC";
    tenants = [
      await savePolicy(clients[0]!, tenants[0]!),
      await savePolicy(clients[1]!, tenants[1]!),
    ];
    record(
      "POLICY_PERSISTENCE",
      tenants.every((tenant) => tenant.policyVersion === 1),
      "both owners saved policy through the authenticated RPC",
    );

    currentStage = "TENANT_RLS";
    await verifyTenantReads(clients, tenants);
    record(
      "TENANT_ISOLATION",
      true,
      "each JWT read only its own product/policy; cross-tenant policy mutation was rejected",
    );

    currentStage = "CLIENT_WRITE_BOUNDARY";
    const [
      productWrite,
      policyWrite,
      queueInsert,
      attemptInsert,
      preparationInsert,
      resolutionInsert,
    ] = await Promise.all([
      clients[0]!
        .from("workspace_products")
        .update({ name: `m15-forged-${nonce}` })
        .eq("id", tenants[0]!.productId)
        .select("id")
        .maybeSingle(),
      clients[0]!
        .from("product_remediation_policies")
        .update({ enabled: false })
        .eq("workspace_id", tenants[0]!.workspaceId)
        .eq("product_id", tenants[0]!.productId)
        .select("product_id")
        .maybeSingle(),
      clients[0]!
        .from("remediation_validation_queue")
        .insert({
          workspace_id: tenants[0]!.workspaceId,
          remediation_proposal_id: randomUUID(),
          patch_fingerprint: "a".repeat(64),
        })
        .select("id"),
      clients[0]!.from("remediation_validation_attempts").insert({
        workspace_id: tenants[0]!.workspaceId,
        queue_id: randomUUID(),
        attempt_number: 1,
        patch_fingerprint: "b".repeat(64),
        outcome: "validated",
        duration_ms: 1,
      }),
      clients[0]!.from("remediation_preparation_queue").insert({
        workspace_id: tenants[0]!.workspaceId,
        preflight_run_id: randomUUID(),
        impact_assessment_id: randomUUID(),
      }),
      clients[0]!.from("customer_risk_resolutions").insert({
        workspace_id: tenants[0]!.workspaceId,
        impact_assessment_id: randomUUID(),
        resolution_kind: "reviewed",
        resolved_by: tenants[0]!.userId,
      }),
    ]);
    const writeFailureSummary = [
      productWrite,
      policyWrite,
      queueInsert,
      attemptInsert,
      preparationInsert,
      resolutionInsert,
    ]
      .map((result) => errorCode(result.error) ?? (result.data === null ? "no_row" : "rows"))
      .join("_");
    assert(
      deniedWrite(productWrite, true) &&
        deniedWrite(policyWrite, true) &&
        deniedWrite(queueInsert) &&
        deniedWrite(attemptInsert) &&
        deniedWrite(preparationInsert) &&
        deniedWrite(resolutionInsert),
      `local_qa_write_denied_${writeFailureSummary}`,
    );

    const [queueRead, attemptRead, preparationRead, resolutionRead, replacementRead] =
      await Promise.all([
        clients[0]!
          .from("remediation_validation_queue")
          .select("id")
          .eq("workspace_id", tenants[1]!.workspaceId),
        clients[0]!
          .from("remediation_validation_attempts")
          .select("id")
          .eq("workspace_id", tenants[1]!.workspaceId),
        clients[0]!
          .from("remediation_preparation_queue")
          .select("id")
          .eq("workspace_id", tenants[1]!.workspaceId),
        clients[0]!
          .from("customer_risk_resolutions")
          .select("id")
          .eq("workspace_id", tenants[1]!.workspaceId),
        clients[0]!.from("source_remediation_replacements").select("id").limit(1),
      ]);
    assert(
      !queueRead.error &&
        queueRead.data.length === 0 &&
        !attemptRead.error &&
        attemptRead.data.length === 0 &&
        !preparationRead.error &&
        preparationRead.data.length === 0 &&
        !resolutionRead.error &&
        resolutionRead.data.length === 0 &&
        permissionDenied(replacementRead.error),
      "local_qa_validation_or_replacement_read_boundary_failed",
    );
    const workerRpc = await clients[0]!.rpc("list_remediation_validation_queue", { p_limit: 1 });
    assert(permissionDenied(workerRpc.error), "local_qa_client_worker_rpc_allowed");
    const preparationWorkerRpc = await clients[0]!.rpc("claim_remediation_preparation", {
      p_queue_id: randomUUID(),
      p_attempt: 1,
    });
    assert(
      permissionDenied(preparationWorkerRpc.error),
      "local_qa_client_preparation_worker_rpc_allowed",
    );
    record(
      "VALIDATION_AND_REPLACEMENT_BOUNDARIES",
      true,
      "member cannot write worker-owned rows or invoke worker claims; tenant reads remain scoped",
    );
    record(
      "VALIDATION_ROW_ISOLATION",
      false,
      "no service-produced queue/attempt rows were supplied; the helper does not seed lifecycle tables directly",
    );

    currentStage = "ANON_BOUNDARY";
    const anonReads = await Promise.all([
      anon.from("workspace_products").select("id"),
      anon.from("product_remediation_policies").select("product_id"),
      anon.from("remediation_validation_queue").select("id"),
      anon.from("remediation_validation_attempts").select("id"),
      anon.from("remediation_preparation_queue").select("id"),
      anon.from("customer_risk_resolutions").select("id"),
      anon.from("source_remediation_replacements").select("id"),
    ]);
    assert(
      anonReads.every(
        (result) =>
          (permissionDenied(result.error) && result.data === null) ||
          (!result.error && result.data?.length === 0),
      ),
      "local_qa_anon_read_boundary_failed",
    );
    record("ANON_BOUNDARY", true, "anonymous JWT sees no tenant or internal evidence rows");
  } finally {
    for (const workspaceId of cleanupWorkspaceIds) {
      const result = await admin.from("workspaces").delete().eq("id", workspaceId);
      if (result.error)
        record("QA_CLEANUP", false, `workspace_delete_${errorCode(result.error) ?? "failed"}`);
    }
    for (const userId of cleanupUserIds) {
      const result = await admin.auth.admin.deleteUser(userId);
      if (result.error)
        record("QA_CLEANUP", false, `user_delete_${errorCode(result.error) ?? "failed"}`);
    }
  }

  if (!stages.some((stage) => stage.name === "QA_CLEANUP")) {
    record("QA_CLEANUP", true, "local QA workspace and Auth user cleanup completed");
  }

  const passed = stages.filter((stage) => stage.status === "PASS").length;
  const failed = stages.filter((stage) => stage.status === "FAIL").length;
  process.stdout.write(
    `${JSON.stringify({ acceptance: failed === 0 ? "PASS" : "FAIL", passed, failed, stages }, null, 2)}\n`,
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const safeCode =
    error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message)
      ? error.message
      : "unexpected_local_error";
  record(currentStage, false, safeCode);
  process.stdout.write(
    `${JSON.stringify({ acceptance: "FAIL", passed: stages.filter((stage) => stage.status === "PASS").length, failed: stages.filter((stage) => stage.status === "FAIL").length, stages }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
