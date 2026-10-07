import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { runs, tasks } from "@trigger.dev/sdk";
import { describe, it } from "vitest";
import { requiredEntitlementCases } from "../scripts/m15-validation/entitlement-matrix.mts";
import type { RequiredEntitlementCase } from "../scripts/m15-validation/entitlement-matrix.mts";
import { runPersistedSyntheticChange } from "@/lib/m15/persisted-synthetic-change";
import {
  createPinnedFixtureRepositoryProvider,
  runPersistedPreflightAcceptance,
} from "@/lib/m15/persisted-preflight-acceptance";
import { runPreflight } from "@/lib/preflight/preflight-service";
import type { dispatchRemediationPreparationTask } from "@/trigger/dispatch-remediation-preparation";
import type { dispatchRemediationValidationTask } from "@/trigger/dispatch-remediation-validation";
import type { CustomerImpactClassifier } from "@/lib/impact/impact";
import type { SemanticClassifier } from "@/lib/monitoring/classification";

// This suite is only invoked by the guarded M15 launcher against its disposable local stack.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QaClient = ReturnType<typeof createClient<any, "public", "public">>;

type LocalConfig = { url: string; publishableKey: string; serviceKey: string };
type CaseName = RequiredEntitlementCase;
type FixtureCase = {
  name: CaseName;
  taskId: "prepare-remediation" | "validate-remediation";
  queueId: string;
  workspaceId: string;
  userId: string;
  userEmail: string;
  userPassword: string;
  productId: string;
  dependencyId: string;
  impactAssessmentId: string;
  preflightRunId: string;
  newerPreflightRunId?: string;
  customerId?: string;
  subscriptionId?: string;
  proposalId?: string;
  validationQueueId?: string;
  statePrepared: true;
  queueStatus: "queued";
  sourceCatalogId: string;
};
type Fixture = {
  fixtureId: string;
  cases: FixtureCase[];
  users: string[];
  workspaces: string[];
  sourceCatalogIds: string[];
  dependencyCatalogIds: string[];
  phase: "six" | "seven";
  sixCaseProof?: CaseProof[];
};
type CaseProof = {
  status: "proven";
  name: CaseName;
  taskId: FixtureCase["taskId"];
  queueId: string;
  triggerRunId: string;
  dispatcherRunId: string;
  workerOutcome: "completed" | "denied";
  canonicalStatus: string;
};

const phase = process.env.AUTERIM_M15_ENTITLEMENT_PHASE;
const round = process.env.AUTERIM_M15_ENTITLEMENT_ROUND;
const fixtureId = process.env.AUTERIM_M15_ENTITLEMENT_FIXTURE_ID ?? "";
const enabled =
  process.env.AUTERIM_M15_LOCAL_INTEGRATION === "1" &&
  process.env.AUTERIM_M15_REAL_TRIGGER_TOPOLOGY === "1" &&
  ["prepare", "execute", "cleanup"].includes(phase ?? "") &&
  ["core", "stale"].includes(round ?? "");
const requested = Boolean(phase || round || fixtureId);
const cacheRoot = path.resolve(process.cwd(), "node_modules/.cache/m15-local");
const gateRoot = path.join(cacheRoot, "preclaim-gates");
const postWorkGateRoot = path.join(cacheRoot, "postwork-gates");
const outcomesPath = path.join(cacheRoot, "task-outcomes.jsonl");
const prepHoldAll = path.join(gateRoot, "prepare-remediation-hold-all");
const validationHoldAll = path.join(gateRoot, "validate-remediation-hold-all");
const caseNames: CaseName[] = requiredEntitlementCases.filter(
  (name) => name !== "stale_validation_work",
);

const semanticClassifier: SemanticClassifier = {
  providerId: "openai",
  modelId: "m15/local-deterministic",
  async classify() {
    return {
      inputTokens: 0,
      outputTokens: 0,
      classification: {
        material: true,
        category: "api_change",
        affectedEntities: ["fixture-client"],
        severityHint: "high",
        confidence: 0.99,
        summary: "A fixture API method was replaced.",
        evidence: [{ type: "changed", excerpt: "modernClient.send() is used" }],
        reasoningSummary: "Deterministic local entitlement fixture.",
      },
    };
  },
};

const impactClassifier: CustomerImpactClassifier = {
  providerId: "openai",
  modelId: "m15/local-deterministic",
  async classify(packet) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      result: {
        relevant: true,
        relevance: "high",
        severity: "high",
        affectedAreas: ["customer-facing product"],
        impactSummary: "The protected product uses the affected dependency.",
        whyItMatters: "The persisted fixture context confirms production use.",
        actionRequired: true,
        recommendedAction: "Review the verified replacement.",
        confidence: 0.99,
        missingContext: [],
        evidenceRefs: [
          { source: "global_evidence", excerpt: packet.globalChange.evidence[0]!.excerpt },
          { source: "dependency_context", excerpt: packet.context.contextNote },
        ],
      },
    };
  },
};

describe("M15 focused execution-time entitlement matrix", () => {
  it.skipIf(!requested)(
    "proves canonical entitlement and stale-work decisions with Trigger workers",
    async () => {
      if (!enabled) {
        const missing = [
          process.env.AUTERIM_M15_LOCAL_INTEGRATION === "1" ? null : "local_integration",
          process.env.AUTERIM_M15_REAL_TRIGGER_TOPOLOGY === "1" ? null : "real_trigger_topology",
          ["prepare", "execute", "cleanup"].includes(phase ?? "") ? null : "phase",
          ["core", "stale"].includes(round ?? "") ? null : "round",
        ].filter(Boolean);
        throw new Error(`m15_entitlement_launcher_environment_invalid:${missing.join(",")}`);
      }
      await assertLocalGuard(phase === "execute");
      if (!/^[0-9a-f-]{36}$/i.test(fixtureId))
        throw new Error("m15_entitlement_fixture_id_invalid");
      const local = localConfiguration();
      const admin = createClient(local.url, local.serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const artifactPath = getArtifactPath(fixtureId);
      if (phase === "cleanup") {
        const fixture = await readFixture(
          artifactPath,
          fixtureId,
          round === "core" ? "six" : "seven",
        );
        await cleanupLocalFixture(admin, fixture, artifactPath);
        process.stdout.write(
          `M15_ENTITLEMENT_CLEANUP=${JSON.stringify({ complete: true, fixtureId, localOnly: true })}\n`,
        );
        return;
      }
      if (round === "core" && phase === "prepare") {
        await preparePhaseSix(admin, local, fixtureId, artifactPath);
        return;
      }
      if (round === "core" && phase === "execute") {
        const fixture = await readFixture(artifactPath, fixtureId, "six");
        try {
          const proofs = await executePreparationCases(
            admin,
            local,
            fixture.cases,
            "six",
            fixtureId,
          );
          fixture.sixCaseProof = proofs;
          await writeFixture(artifactPath, fixture);
          const checkpointPath = await writeCheckpoint(fixtureId, "six", proofs);
          process.stdout.write(
            `M15_ENTITLEMENT_CORE_MATRIX=${JSON.stringify({
              complete:
                proofs.length === 6 &&
                proofs.every(
                  (item) =>
                    item.workerOutcome ===
                    (item.name === "allowed_pro_execution" ? "completed" : "denied"),
                ),
              fixtureId,
              checkpointPath,
              cases: proofs,
            })}\n`,
          );
          if (proofs.length !== 6) throw new Error("m15_entitlement_six_case_count_invalid");
        } catch (error) {
          await cleanupLocalFixture(admin, fixture, artifactPath).catch(() => undefined);
          throw error;
        }
        return;
      }
      if (round === "stale" && phase === "prepare") {
        const fixture = await readFixture(artifactPath, fixtureId, "six");
        if (
          fixture.sixCaseProof?.length !== 6 ||
          fixture.sixCaseProof.some(
            (proof) =>
              proof.workerOutcome !==
              (proof.name === "allowed_pro_execution" ? "completed" : "denied"),
          )
        ) {
          throw new Error("m15_entitlement_six_case_proof_required_before_stale_validation");
        }
        const coreCheckpointPath = process.env.AUTERIM_M15_ENTITLEMENT_CORE_CHECKPOINT_PATH;
        if (!coreCheckpointPath || !isLocalCacheArtifact(coreCheckpointPath)) {
          throw new Error("m15_entitlement_core_checkpoint_path_invalid");
        }
        const coreCheckpoint = JSON.parse(await readFile(coreCheckpointPath, "utf8")) as {
          fixtureId?: unknown;
          stage?: unknown;
          cases?: unknown;
        };
        if (
          coreCheckpoint.fixtureId !== fixtureId ||
          coreCheckpoint.stage !== "six" ||
          !Array.isArray(coreCheckpoint.cases) ||
          coreCheckpoint.cases.length !== 6 ||
          coreCheckpoint.cases.some(
            (item) =>
              !item || typeof item !== "object" || !("status" in item) || item.status !== "proven",
          )
        )
          throw new Error("m15_entitlement_core_checkpoint_not_proven");
        await preparePhaseSeven(admin, local, fixture, artifactPath, coreCheckpointPath);
        return;
      }
      if (round === "stale" && phase === "execute") {
        const fixture = await readFixture(artifactPath, fixtureId, "seven");
        const staleCase = fixture.cases.find((item) => item.name === "stale_validation_work");
        if (!staleCase) throw new Error("m15_stale_validation_fixture_missing");
        try {
          const proof = await executeValidationCase(admin, staleCase);
          const proofs = [...(fixture.sixCaseProof ?? []), proof];
          const complete =
            proofs.length === 7 &&
            proofs.every(
              (item) =>
                item.workerOutcome ===
                (item.name === "allowed_pro_execution" ? "completed" : "denied"),
            );
          const checkpointPath = await writeCheckpoint(fixtureId, "stale", [proof]);
          if (complete) await cleanupLocalFixture(admin, fixture, artifactPath);
          process.stdout.write(
            `M15_ENTITLEMENT_STALE_MATRIX=${JSON.stringify({ complete, fixtureId, coreCheckpointPath: process.env.AUTERIM_M15_ENTITLEMENT_CORE_CHECKPOINT_PATH ?? null, checkpointPath, cases: [{ ...proof, status: "proven" }] })}\n`,
          );
          if (!complete) throw new Error("m15_entitlement_matrix_incomplete");
        } catch (error) {
          await cleanupLocalFixture(admin, fixture, artifactPath).catch(() => undefined);
          throw error;
        }
      }
    },
    600_000,
  );
});

async function preparePhaseSix(
  admin: QaClient,
  local: LocalConfig,
  fixtureId: string,
  artifactPath: string,
) {
  await assertWorkerGateFilesAbsent();
  await mkdir(gateRoot, { recursive: true });
  await createGate(prepHoldAll);
  const fixture: Fixture = {
    fixtureId,
    cases: [],
    users: [],
    workspaces: [],
    sourceCatalogIds: [],
    dependencyCatalogIds: [],
    phase: "six",
  };
  try {
    for (const name of caseNames) {
      const prepared = await prepareProductCase(admin, local, fixture, name);
      fixture.cases.push(prepared);
    }
    await assertPreparedCases(admin, fixture.cases);
    for (const item of fixture.cases.filter((candidate) =>
      [
        "subscription_downgraded",
        "product_archived",
        "dependency_disabled",
        "preflight_superseded",
      ].includes(candidate.name),
    )) {
      await createPostWorkGate("prepare-remediation", item.queueId);
    }
    await writeFixture(artifactPath, fixture);
    process.stdout.write(
      `M15_ENTITLEMENT_FIXTURE_PREPARED=${JSON.stringify({
        complete: true,
        round: "core",
        fixtureId,
        fixturePath: artifactPath,
        workerState: "stopped",
        phase: "core_prepare",
        cases: fixture.cases.map(({ name, queueId, queueStatus, statePrepared }) => ({
          name,
          queueId,
          queueStatus,
          statePrepared,
        })),
      })}\n`,
    );
  } catch (error) {
    await cleanupLocalFixture(admin, fixture, artifactPath).catch(() => undefined);
    throw error;
  }
}

async function prepareProductCase(
  admin: QaClient,
  local: LocalConfig,
  fixture: Fixture,
  name: CaseName,
): Promise<FixtureCase> {
  const nonce = `${fixture.fixtureId}-${name}-${randomUUID()}`;
  const safeDomain = `m15-${fixture.fixtureId.replaceAll("-", "").slice(0, 12)}-${name.replaceAll("_", "-")}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const email = `m15-entitlement-${name}-${fixture.fixtureId}@auterim.invalid`;
  const password = `Local-${randomUUID()}-Aa1!`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error("m15_entitlement_user_create_failed");
  fixture.users.push(created.data.user.id);
  const anonymousClient = createClient(local.url, local.publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signedIn = await anonymousClient.auth.signInWithPassword({ email, password });
  if (signedIn.error || !signedIn.data.session) throw new Error("m15_entitlement_auth_failed");
  const member = createClient(local.url, local.publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${signedIn.data.session.access_token}` } },
  });
  const onboarding = await admin.rpc("start_workspace_onboarding", {
    p_actor_user_id: created.data.user.id,
    p_workspace_name: `M15 Entitlement ${name}`,
    p_company_name: `M15 Entitlement ${name}`,
    p_website_url: `https://${safeDomain}.example/`,
    p_website_domain: `${safeDomain}.example`,
    p_idempotency_key: `m15-entitlement-${nonce}`,
    p_workspace_id: null,
  });
  const workspaceId = (onboarding.data as { workspaceId?: string } | null)?.workspaceId;
  if (onboarding.error || !workspaceId) {
    const errorCode =
      onboarding.error && typeof onboarding.error.code === "string"
        ? onboarding.error.code
        : "missing_workspace_id";
    throw new Error(`m15_entitlement_workspace_create_failed:${errorCode}`);
  }
  fixture.workspaces.push(workspaceId);
  const productResponse = await member
    .from("workspace_products")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("is_default", true)
    .single();
  if (productResponse.error || !productResponse.data)
    throw new Error("m15_entitlement_product_missing");
  const productId = productResponse.data.id as string;

  const slug = `m15-ent-${fixture.fixtureId.replaceAll("-", "").slice(0, 15)}-${name.replaceAll("_", "-")}`;
  const catalog = await admin
    .from("dependency_catalog")
    .insert({
      slug,
      name: `M15 Entitlement ${name}`,
      category: "developer-tools",
      website_url: "https://m15-qa.invalid/",
      enabled: true,
      metadata: { internal_qa: true },
    })
    .select("id")
    .single();
  if (catalog.error || !catalog.data) throw new Error("m15_entitlement_catalog_create_failed");
  fixture.dependencyCatalogIds.push(catalog.data.id as string);
  const added = await member.rpc("add_product_dependency_manually", {
    p_workspace_id: workspaceId,
    p_product_id: productId,
    p_dependency_slug: slug,
  });
  const dependencyId = (added.data as { workspaceDependencyId?: string } | null)
    ?.workspaceDependencyId;
  if (added.error || !dependencyId) throw new Error("m15_entitlement_dependency_create_failed");
  const context = await member.rpc("set_onboarding_dependency_context", {
    p_workspace_id: workspaceId,
    p_workspace_dependency_id: dependencyId,
    p_criticality: "critical",
    p_production_critical: true,
    p_used_for: ["customer-facing product"],
    p_context_note: "Uses fixture-client in the customer-facing product.",
    p_usage_metadata: {},
  });
  if (context.error) throw new Error("m15_entitlement_context_create_failed");

  for (const [step, next] of [
    ["dependencies_review", "context_setup"],
    ["context_setup", "notifications_setup"],
  ] as const) {
    const completed = await member.rpc("complete_onboarding_step", {
      p_workspace_id: workspaceId,
      p_step: step,
    });
    if (completed.error || completed.data !== next)
      throw new Error("m15_entitlement_onboarding_step_failed");
  }
  const prefs = await member.rpc("save_onboarding_notification_preferences", {
    p_workspace_id: workspaceId,
    p_important_changes: "instant",
    p_informational: "off",
    p_monthly_protection_report: false,
  });
  if (prefs.error) throw new Error("m15_entitlement_preferences_failed");
  const activated = await member.rpc("activate_workspace_protection", {
    p_workspace_id: workspaceId,
  });
  if (activated.error) throw new Error("m15_entitlement_workspace_activation_failed");

  const customerId = `m15-customer-${fixture.fixtureId}-${name}`;
  const subscriptionId = `m15-subscription-${fixture.fixtureId}-${name}`;
  const attached = await member.rpc("attach_workspace_dodo_customer", {
    p_workspace_id: workspaceId,
    p_customer_id: customerId,
  });
  if (attached.error) throw new Error("m15_entitlement_customer_attach_failed");
  await applySubscriptionState(admin, {
    name: "allowed_pro_execution",
    workspaceId,
    customerId,
    subscriptionId,
    plan: "pro",
    status: "active",
  });

  const source = await admin
    .from("source_catalog")
    .insert({
      dependency_id: catalog.data.id,
      name: `M15 entitlement source ${name} ${fixture.fixtureId}`,
      source_type: "changelog",
      url: `https://docs.m15-qa.invalid/${nonce}`,
      enabled: true,
    })
    .select("id")
    .single();
  if (source.error || !source.data) throw new Error("m15_entitlement_source_create_failed");
  fixture.sourceCatalogIds.push(source.data.id as string);

  const connection = await admin
    .from("repository_connections")
    .insert({
      workspace_id: workspaceId,
      provider: "github",
      installation_id: Math.floor(100_000_000 + Math.random() * 900_000_000),
      account_login: `m15-${fixture.fixtureId.slice(0, 8)}`,
      status: "connected",
      connected_by: created.data.user.id,
    })
    .select("id")
    .single();
  if (connection.error || !connection.data)
    throw new Error("m15_entitlement_repo_connection_failed");
  const repo = await admin
    .from("repositories")
    .insert({
      workspace_id: workspaceId,
      connection_id: connection.data.id,
      external_id: Math.floor(1_000_000_000 + Math.random() * 8_000_000_000),
      owner: "auterim-internal-qa",
      name: `m15-${fixture.fixtureId.slice(0, 8)}-${name}`,
      default_branch: "main",
      private: true,
      status: "available",
    })
    .select("id")
    .single();
  if (repo.error || !repo.data) throw new Error("m15_entitlement_repo_create_failed");
  const selected = await member.rpc("set_repository_protection", {
    p_repository_id: repo.data.id,
    p_selected: true,
    p_dependency_ids: [dependencyId],
  });
  if (selected.error) throw new Error("m15_entitlement_repo_select_failed");
  const policy = await member.rpc("set_product_remediation_policy", {
    p_workspace_id: workspaceId,
    p_product_id: productId,
    p_enabled: true,
    p_draft_pr_preparation_allowed: true,
    p_automatic_workflow_handoff_allowed: false,
    p_approval_required: true,
    p_allowed_repository_ids: [repo.data.id],
  });
  if (policy.error) throw new Error("m15_entitlement_policy_create_failed");

  const change = await runPersistedSyntheticChange(
    {
      sourceId: source.data.id,
      workspaceDependencyId: dependencyId,
      runIdPrefix: `m15-entitlement-${name}-${fixture.fixtureId}`,
      baselineContent: "legacyClient.send() was supported",
      changedContent: "modernClient.send() is used",
      decision: "material",
      internalQaEvidence: {
        oldExpression: "legacyClient.send()",
        newExpression: "modernClient.send()",
        evidenceSourceUrl: `https://docs.m15-qa.invalid/${nonce}`,
      },
    },
    {
      classifier: semanticClassifier,
      impactClassifier,
    },
  );
  const assessment = change.impactAssessments[0]?.result;
  if (!assessment || assessment.status !== "assessed" || typeof assessment.id !== "string") {
    throw new Error("m15_entitlement_impact_not_relevant");
  }
  const persistedImpact = await admin
    .from("impact_assessments")
    .select("id,status,relevant")
    .eq("id", assessment.id)
    .single();
  if (
    persistedImpact.error ||
    persistedImpact.data.id !== assessment.id ||
    persistedImpact.data.status !== "assessed" ||
    persistedImpact.data.relevant !== true
  ) {
    throw new Error("m15_entitlement_impact_not_relevant");
  }
  const oldSha = "a".repeat(40);
  const preflight = await runPersistedPreflightAcceptance({
    syntheticChange: change,
    customerImpactQueueId: change.impactAssessments[0]!.queueId,
    provider: fixtureRepository(oldSha, "verified"),
  });
  if (
    preflight.queueStatus !== "complete" ||
    preflight.preflight.status !== "completed" ||
    preflight.persisted?.verifiedImpact !== "verified"
  ) {
    throw new Error("m15_entitlement_verified_preflight_missing");
  }
  const queue = await admin
    .from("remediation_preparation_queue")
    .select("id,status,preflight_run_id,impact_assessment_id")
    .eq("preflight_run_id", preflight.preflight.runId)
    .single();
  if (
    queue.error ||
    queue.data.status !== "queued" ||
    queue.data.impact_assessment_id !== assessment.id
  )
    throw new Error("m15_entitlement_prep_queue_not_queued");

  if (name === "subscription_expired") {
    await applySubscriptionState(admin, {
      name,
      workspaceId,
      customerId,
      subscriptionId,
      plan: "pro",
      status: "expired",
    });
  }

  if (
    name !== "subscription_downgraded" &&
    name !== "preflight_superseded" &&
    name !== "product_archived" &&
    name !== "dependency_disabled"
  ) {
    await verifyMutation(
      admin,
      name,
      workspaceId,
      productId,
      dependencyId,
      preflight.preflight.runId,
      assessment.id,
    );
  }
  return {
    name,
    taskId: "prepare-remediation",
    queueId: queue.data.id,
    workspaceId,
    userId: created.data.user.id,
    userEmail: email,
    userPassword: password,
    productId,
    dependencyId,
    impactAssessmentId: assessment.id,
    preflightRunId: preflight.preflight.runId,
    customerId,
    subscriptionId,
    statePrepared: true,
    queueStatus: "queued",
    sourceCatalogId: source.data.id,
  };
}

async function preparePhaseSeven(
  admin: QaClient,
  local: LocalConfig,
  fixture: Fixture,
  artifactPath: string,
  coreCheckpointPath: string,
) {
  const name = "stale_validation_work" as const;
  await createGate(prepHoldAll);
  const productCase = await prepareProductCase(admin, local, fixture, name);
  fixture.cases.push(productCase);
  fixture.phase = "seven";
  await writeFixture(artifactPath, fixture);
  process.stdout.write(
    `M15_ENTITLEMENT_FIXTURE_PREPARED=${JSON.stringify({
      complete: true,
      round: "stale",
      fixtureId: fixture.fixtureId,
      fixturePath: artifactPath,
      workerState: "stopped",
      phase: "stale_prepare",
      coreCheckpointPath,
      cases: [{ name, queueId: productCase.queueId, queueStatus: "queued", statePrepared: true }],
    })}\n`,
  );
}

async function executePreparationCases(
  admin: QaClient,
  local: LocalConfig,
  cases: FixtureCase[],
  batch: "six",
  fixtureId: string,
) {
  const prepCases = cases.filter((item) => item.taskId === "prepare-remediation");
  if (batch === "six" && prepCases.length !== 6)
    throw new Error("m15_entitlement_prepare_case_count_invalid");
  const proofs: CaseProof[] = [];
  const runIds = new Map<string, string>();
  try {
    const dispatcherRunId = await triggerDispatcher("preparation");
    await waitForRun(dispatcherRunId, "dispatch-remediation-preparation");
    await waitUntil(
      async () => {
        for (const item of prepCases) {
          const row = await admin
            .from("remediation_preparation_queue")
            .select("id,status,trigger_run_id")
            .eq("id", item.queueId)
            .single();
          if (row.error || row.data.status !== "dispatched" || !isRunId(row.data.trigger_run_id))
            return false;
        }
        return true;
      },
      60_000,
      "m15_entitlement_children_not_dispatched",
    );

    for (const item of prepCases) {
      const row = await admin
        .from("remediation_preparation_queue")
        .select("id,status,trigger_run_id")
        .eq("id", item.queueId)
        .single();
      if (row.error || row.data.status !== "dispatched" || !isRunId(row.data.trigger_run_id))
        throw new Error("m15_entitlement_child_run_missing");
      runIds.set(item.queueId, row.data.trigger_run_id);
    }

    // prepare-remediation has a legacy queue concurrency of two. Release only children which
    // have reached the exact pre-claim gate; product/dependency state changes below happen only
    // after the worker has completed preparation and reached the post-work completion gate.
    const pending = new Map(prepCases.map((item) => [item.queueId, item]));
    const deadline = Date.now() + 60_000;
    while (pending.size) {
      if (Date.now() >= deadline) {
        const unclaimed = [...pending.values()]
          .map(
            (item) => `${item.name}:${item.queueId}:${runIds.get(item.queueId) ?? "missing_run"}`,
          )
          .join(",");
        throw new Error(`m15_entitlement_child_not_claimed_within_bound:${unclaimed}`);
      }
      const started: FixtureCase[] = [];
      for (const item of pending.values()) {
        if (await markerExists(path.join(gateRoot, `prepare-remediation-${item.queueId}.started`)))
          started.push(item);
      }
      if (!started.length) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      for (const item of started) {
        const runId = runIds.get(item.queueId)!;
        const outcome = item.name === "allowed_pro_execution" ? "completed" : "denied";
        await releaseChild("prepare-remediation", item.queueId);
        if (item.name === "subscription_downgraded") {
          await waitForMarker(
            path.join(postWorkGateRoot, `prepare-remediation-${item.queueId}.started`),
            60_000,
            "m15_completion_entitlement_postwork_gate_not_reached",
          );
          if (!item.customerId || !item.subscriptionId)
            throw new Error("m15_completion_entitlement_identity_missing");
          await applySubscriptionState(admin, {
            name: `completion-downgrade-${fixtureId}`,
            workspaceId: item.workspaceId,
            customerId: item.customerId,
            subscriptionId: item.subscriptionId,
            plan: "core",
            status: "active",
          });
          const subscription = await admin
            .from("workspace_subscriptions")
            .select("plan,status")
            .eq("workspace_id", item.workspaceId)
            .single();
          if (
            subscription.error ||
            subscription.data.plan !== "core" ||
            subscription.data.status !== "active"
          )
            throw new Error("m15_completion_downgrade_not_persisted");
          await releasePostWorkGate("prepare-remediation", item.queueId);
        } else if (item.name === "preflight_superseded") {
          await waitForMarker(
            path.join(postWorkGateRoot, `prepare-remediation-${item.queueId}.started`),
            60_000,
            "m15_completion_preflight_postwork_gate_not_reached",
          );
          const newer = await createNewerPreflight(admin, item);
          item.newerPreflightRunId = newer;
          await releasePostWorkGate("prepare-remediation", item.queueId);
        } else if (item.name === "product_archived") {
          await waitForMarker(
            path.join(postWorkGateRoot, `prepare-remediation-${item.queueId}.started`),
            60_000,
            "m15_completion_product_archive_postwork_gate_not_reached",
          );
          const member = await authenticateFixtureMember(local, item);
          const successor = await member.rpc("create_workspace_product", {
            p_workspace_id: item.workspaceId,
            p_name: "M15 QA successor",
            p_surfaces: [],
          });
          if (successor.error) throw new Error("m15_completion_successor_product_create_failed");
          const archived = await member.rpc("archive_workspace_product", {
            p_workspace_id: item.workspaceId,
            p_product_id: item.productId,
          });
          if (archived.error) throw new Error("m15_completion_product_archive_failed");
          await verifyMutation(
            admin,
            item.name,
            item.workspaceId,
            item.productId,
            item.dependencyId,
            item.preflightRunId,
            item.impactAssessmentId,
          );
          await releasePostWorkGate("prepare-remediation", item.queueId);
        } else if (item.name === "dependency_disabled") {
          await waitForMarker(
            path.join(postWorkGateRoot, `prepare-remediation-${item.queueId}.started`),
            60_000,
            "m15_completion_dependency_disable_postwork_gate_not_reached",
          );
          const member = await authenticateFixtureMember(local, item);
          const disabled = await member.rpc("disable_workspace_dependency", {
            p_workspace_id: item.workspaceId,
            p_workspace_dependency_id: item.dependencyId,
          });
          if (disabled.error) throw new Error("m15_completion_dependency_disable_failed");
          await verifyMutation(
            admin,
            item.name,
            item.workspaceId,
            item.productId,
            item.dependencyId,
            item.preflightRunId,
            item.impactAssessmentId,
          );
          await releasePostWorkGate("prepare-remediation", item.queueId);
        }
        await waitForQueueOutcome(admin, item, outcome);
        await waitForRun(runId, "prepare-remediation");
        await verifyPrepOutcome(admin, item, runId, outcome);
        proofs.push({
          status: "proven",
          name: item.name,
          taskId: item.taskId,
          queueId: item.queueId,
          triggerRunId: runId,
          dispatcherRunId,
          workerOutcome: outcome,
          canonicalStatus: outcome === "completed" ? "completed" : "denied:execution_ineligible",
        });
        await writeCheckpoint(fixtureId, "six", proofs);
        pending.delete(item.queueId);
      }
    }
    return proofs;
  } finally {
    // Release every exact run before removing the gates. A failed assertion must not leave a
    // real Trigger worker parked in the acceptance-only preclaim/postwork barrier.
    for (const item of prepCases) {
      await releaseChild("prepare-remediation", item.queueId).catch(() => undefined);
      await releasePostWorkGate("prepare-remediation", item.queueId).catch(() => undefined);
    }
    await rm(prepHoldAll, { force: true });
    await Promise.all(
      [...runIds.values()].map((runId) =>
        waitForRun(runId, "prepare-remediation").catch(() => undefined),
      ),
    );
    for (const item of prepCases) {
      for (const suffix of ["hold", "started", "release"])
        await rm(path.join(gateRoot, `prepare-remediation-${item.queueId}.${suffix}`), {
          force: true,
        });
      for (const suffix of ["hold", "started", "release"])
        await rm(path.join(postWorkGateRoot, `prepare-remediation-${item.queueId}.${suffix}`), {
          force: true,
        });
    }
  }
}

async function executeValidationCase(admin: QaClient, item: FixtureCase): Promise<CaseProof> {
  const prepQueue = await admin
    .from("remediation_preparation_queue")
    .select("id,status,trigger_run_id")
    .eq("preflight_run_id", item.preflightRunId)
    .single();
  if (prepQueue.error || !["queued", "dispatched"].includes(prepQueue.data.status))
    throw new Error("m15_stale_validation_setup_queue_not_queued");
  const prepDispatcherRunId = await triggerDispatcher("preparation");
  await waitForRun(prepDispatcherRunId, "dispatch-remediation-preparation");
  const prepDispatched = await admin
    .from("remediation_preparation_queue")
    .select("status,trigger_run_id")
    .eq("id", prepQueue.data.id)
    .single();
  if (
    prepDispatched.error ||
    prepDispatched.data.status !== "dispatched" ||
    !isRunId(prepDispatched.data.trigger_run_id)
  )
    throw new Error("m15_stale_validation_prep_dispatch_missing");
  await waitForMarker(
    path.join(gateRoot, `prepare-remediation-${prepQueue.data.id}.started`),
    60_000,
  );
  await releaseChild("prepare-remediation", prepQueue.data.id);
  await waitForRun(prepDispatched.data.trigger_run_id, "prepare-remediation");
  const preparedQueue = await admin
    .from("remediation_preparation_queue")
    .select("id,status,remediation_proposal_id")
    .eq("id", prepQueue.data.id)
    .single();
  if (
    preparedQueue.error ||
    preparedQueue.data.status !== "completed" ||
    !preparedQueue.data.remediation_proposal_id
  )
    throw new Error("m15_stale_validation_setup_proposal_missing");
  item.proposalId = preparedQueue.data.remediation_proposal_id;
  await assertRunOutcomeMarker(
    "prepare-remediation",
    prepQueue.data.id,
    prepDispatched.data.trigger_run_id,
    "completed",
  );

  const validationQueue = await admin
    .from("remediation_validation_queue")
    .select("id,status,attempt_count,remediation_proposal_id")
    .eq("remediation_proposal_id", item.proposalId)
    .single();
  if (validationQueue.error || validationQueue.data.status !== "queued")
    throw new Error("m15_stale_validation_setup_queue_not_queued");
  item.taskId = "validate-remediation";
  item.validationQueueId = validationQueue.data.id;
  item.queueId = validationQueue.data.id;
  await createGate(validationHoldAll);
  await createPostWorkGate("validate-remediation", item.queueId);

  const dispatcherRunId = await triggerDispatcher("validation");
  await waitForRun(dispatcherRunId, "dispatch-remediation-validation");
  const queue = await admin
    .from("remediation_validation_queue")
    .select("id,status,trigger_run_id,attempt_count,remediation_proposal_id,patch_fingerprint")
    .eq("id", item.queueId)
    .single();
  if (queue.error || queue.data.status !== "dispatched" || !isRunId(queue.data.trigger_run_id))
    throw new Error("m15_stale_validation_child_dispatch_missing");
  const runId = queue.data.trigger_run_id;
  await waitForMarker(path.join(gateRoot, `validate-remediation-${item.queueId}.started`), 60_000);
  await releaseChild("validate-remediation", item.queueId);
  await waitForMarker(
    path.join(postWorkGateRoot, `validate-remediation-${item.queueId}.started`),
    120_000,
    "m15_completion_validation_postwork_gate_not_reached",
  );
  item.newerPreflightRunId = await createNewerPreflight(admin, item);
  await releasePostWorkGate("validate-remediation", item.queueId);
  await waitForQueueOutcome(admin, item, "denied");
  await waitForRun(runId, "validate-remediation");
  await verifyValidationOutcome(admin, item, runId);
  for (const [taskId, queueId] of [
    ["prepare-remediation", prepQueue.data.id],
    ["validate-remediation", item.queueId],
  ]) {
    for (const suffix of ["hold", "started", "release"]) {
      await rm(path.join(gateRoot, `${taskId}-${queueId}.${suffix}`), { force: true });
      await rm(path.join(postWorkGateRoot, `${taskId}-${queueId}.${suffix}`), { force: true });
    }
  }
  return {
    status: "proven",
    name: item.name,
    taskId: item.taskId,
    queueId: item.queueId,
    triggerRunId: runId,
    dispatcherRunId,
    workerOutcome: "denied",
    canonicalStatus: "denied:execution_ineligible",
  };
}

async function triggerDispatcher(kind: "preparation" | "validation") {
  if (
    process.env.AUTERIM_M15_LOCAL_INTEGRATION !== "1" ||
    process.env.AUTERIM_M15_LOCAL_ACCEPTANCE_PRECLAIM_GATE !== "1" ||
    process.env.AUTERIM_M15_REAL_TRIGGER_TOPOLOGY !== "1" ||
    process.env.AUTERIM_M15_LOCAL_SUPABASE_URL !== "http://127.0.0.1:65431" ||
    !process.env.TRIGGER_SECRET_KEY?.startsWith("tr_dev_sk_")
  )
    throw new Error("m15_entitlement_trigger_dispatch_guard_failed");
  const timestamp = new Date();
  const schedulePayload = {
    type: "IMPERATIVE" as const,
    scheduleId: `m15-entitlement-${kind}-${fixtureId}`,
    timestamp,
    timezone: "UTC",
    upcoming: [],
  };
  const handle =
    kind === "preparation"
      ? await tasks.trigger<typeof dispatchRemediationPreparationTask>(
          "dispatch-remediation-preparation",
          schedulePayload,
        )
      : await tasks.trigger<typeof dispatchRemediationValidationTask>(
          "dispatch-remediation-validation",
          schedulePayload,
        );
  if (!isRunId(handle.id)) throw new Error("m15_entitlement_dispatcher_run_id_invalid");
  return handle.id;
}

async function waitForQueueOutcome(
  admin: QaClient,
  item: FixtureCase,
  outcome: "completed" | "denied",
) {
  const table =
    item.taskId === "prepare-remediation"
      ? "remediation_preparation_queue"
      : "remediation_validation_queue";
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { data, error } = await admin
      .from(table)
      .select("id,status,error_category")
      .eq("id", item.queueId)
      .maybeSingle();
    if (
      !error &&
      data?.id === item.queueId &&
      data.status === outcome &&
      (outcome !== "denied" || data.error_category === "execution_ineligible")
    )
      return;
    if (
      !error &&
      data?.id === item.queueId &&
      ["completed", "denied", "failed", "validation_failed", "canceled"].includes(data.status)
    ) {
      throw new Error(
        `m15_entitlement_queue_terminal_outcome_mismatch:${item.name}:${data.status}:${data.error_category ?? "none"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const { data, error } = await admin
    .from(table)
    .select("id,status,error_category")
    .eq("id", item.queueId)
    .maybeSingle();
  const status = error ? "read_failed" : (data?.status ?? "missing");
  const category = error ? (error.code ?? "unknown") : (data?.error_category ?? "none");
  throw new Error(`m15_entitlement_queue_outcome_timeout:${item.name}:${status}:${category}`);
}

async function verifyPrepOutcome(
  admin: QaClient,
  item: FixtureCase,
  runId: string,
  outcome: "completed" | "denied",
) {
  const queue = await admin
    .from("remediation_preparation_queue")
    .select("id,status,error_category,trigger_run_id,remediation_proposal_id,attempt_count")
    .eq("id", item.queueId)
    .single();
  if (queue.error || queue.data.trigger_run_id !== runId || queue.data.status !== outcome)
    throw new Error("m15_entitlement_prep_outcome_identity_mismatch");
  if (outcome === "denied") {
    if (
      queue.data.error_category !== "execution_ineligible" ||
      queue.data.remediation_proposal_id !== null
    )
      throw new Error("m15_entitlement_prep_deny_not_canonical");
  } else {
    if (!queue.data.remediation_proposal_id)
      throw new Error("m15_entitlement_allow_proposal_missing");
    const proposal = await admin
      .from("remediation_proposals")
      .select("id,workspace_id,preflight_run_id,proposal_kind,patch_fingerprint")
      .eq("id", queue.data.remediation_proposal_id)
      .single();
    if (
      proposal.error ||
      proposal.data.workspace_id !== item.workspaceId ||
      proposal.data.preflight_run_id !== item.preflightRunId ||
      proposal.data.proposal_kind !== "patch" ||
      !proposal.data.patch_fingerprint
    )
      throw new Error("m15_entitlement_allow_proposal_invalid");
  }
  await assertRunOutcomeMarker("prepare-remediation", item.queueId, runId, outcome);
}

async function verifyValidationOutcome(admin: QaClient, item: FixtureCase, runId: string) {
  const queue = await admin
    .from("remediation_validation_queue")
    .select(
      "id,status,error_category,trigger_run_id,attempt_count,remediation_proposal_id,patch_fingerprint",
    )
    .eq("id", item.queueId)
    .single();
  if (
    queue.error ||
    queue.data.trigger_run_id !== runId ||
    queue.data.status !== "denied" ||
    queue.data.error_category !== "execution_ineligible" ||
    queue.data.remediation_proposal_id !== item.proposalId
  )
    throw new Error("m15_stale_validation_queue_deny_invalid");
  const attempt = await admin
    .from("remediation_validation_attempts")
    .select("queue_id,attempt_number,patch_fingerprint,outcome,error_category")
    .eq("queue_id", item.queueId)
    .eq("attempt_number", queue.data.attempt_count)
    .single();
  if (
    attempt.error ||
    attempt.data.outcome !== "denied" ||
    attempt.data.error_category !== "execution_ineligible" ||
    attempt.data.patch_fingerprint !== queue.data.patch_fingerprint
  )
    throw new Error("m15_stale_validation_attempt_missing");
  const proposal = await admin
    .from("remediation_proposals")
    .select("id,patch_fingerprint,patch_validation_status")
    .eq("id", item.proposalId)
    .single();
  if (
    proposal.error ||
    proposal.data.patch_validation_status !== "validation_failed" ||
    proposal.data.patch_fingerprint !== queue.data.patch_fingerprint
  )
    throw new Error("m15_stale_validation_proposal_state_invalid");
  const newer = await admin
    .from("preflight_runs")
    .select("id,status,verified_impact,created_at")
    .eq("id", item.newerPreflightRunId!)
    .single();
  if (newer.error || newer.data.status !== "completed" || newer.data.verified_impact === "verified")
    throw new Error("m15_stale_validation_newer_evidence_missing");
  await assertRunOutcomeMarker("validate-remediation", item.queueId, runId, "denied");
}

async function assertRunOutcomeMarker(
  taskId: string,
  queueId: string,
  runId: string,
  outcome: string,
) {
  await waitUntil(
    async () => {
      try {
        const rows = (await readFile(outcomesPath, "utf8"))
          .split(/\r?\n/)
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                taskId?: string;
                queueId?: string;
                runId?: string;
                outcome?: string;
              },
          );
        return rows.some(
          (row) =>
            row.taskId === taskId &&
            row.queueId === queueId &&
            row.runId === runId &&
            row.outcome === outcome,
        );
      } catch {
        return false;
      }
    },
    60_000,
    "m15_entitlement_exact_worker_outcome_marker_missing",
  );
}

async function verifyMutation(
  admin: QaClient,
  name: FixtureCase["name"],
  workspaceId: string,
  productId: string,
  dependencyId: string,
  oldPreflightRunId: string,
  impactAssessmentId: string,
  newerPreflightRunId?: string,
) {
  if (
    name === "subscription_downgraded" ||
    name === "subscription_expired" ||
    name === "allowed_pro_execution"
  ) {
    const subscription = await admin
      .from("workspace_subscriptions")
      .select("plan,status,current_period_end")
      .eq("workspace_id", workspaceId)
      .single();
    const expected =
      name === "subscription_downgraded"
        ? { plan: "core", status: "active" }
        : name === "subscription_expired"
          ? { plan: "pro", status: "expired" }
          : { plan: "pro", status: "active" };
    if (
      subscription.error ||
      subscription.data.plan !== expected.plan ||
      subscription.data.status !== expected.status
    )
      throw new Error("m15_entitlement_subscription_state_not_persisted");
  }
  if (name === "product_archived") {
    const product = await admin
      .from("workspace_products")
      .select("status")
      .eq("id", productId)
      .eq("workspace_id", workspaceId)
      .single();
    if (product.error || product.data.status !== "archived")
      throw new Error("m15_entitlement_product_archive_not_persisted");
  }
  if (name === "dependency_disabled") {
    const dependency = await admin
      .from("workspace_dependencies")
      .select("monitoring_enabled")
      .eq("id", dependencyId)
      .eq("workspace_id", workspaceId)
      .single();
    if (dependency.error || dependency.data.monitoring_enabled !== false)
      throw new Error("m15_entitlement_dependency_disable_not_persisted");
  }
  if (name === "preflight_superseded") {
    if (!newerPreflightRunId) throw new Error("m15_entitlement_newer_preflight_missing");
    const runs = await admin
      .from("preflight_runs")
      .select("id,status,verified_impact,created_at")
      .in("id", [oldPreflightRunId, newerPreflightRunId])
      .eq("workspace_id", workspaceId)
      .eq("impact_assessment_id", impactAssessmentId);
    if (runs.error || runs.data?.length !== 2)
      throw new Error("m15_entitlement_preflight_pair_not_persisted");
    const oldRun = runs.data.find((run: { id: string }) => run.id === oldPreflightRunId);
    const newer = runs.data.find((run: { id: string }) => run.id === newerPreflightRunId);
    if (
      !oldRun ||
      !newer ||
      oldRun.status !== "completed" ||
      oldRun.verified_impact !== "verified" ||
      newer.status !== "completed" ||
      newer.verified_impact === "verified" ||
      (newer.created_at === oldRun.created_at && newer.id <= oldRun.id) ||
      newer.created_at < oldRun.created_at
    )
      throw new Error("m15_entitlement_newer_preflight_not_persisted");
  }
}

async function applySubscriptionState(
  admin: QaClient,
  input: {
    name: string;
    workspaceId: string;
    customerId: string;
    subscriptionId: string;
    plan: "core" | "pro";
    status: "active" | "expired";
  },
) {
  const now = new Date();
  const eventAt = now.toISOString();
  const { data, error } = await admin.rpc("process_dodo_subscription_event", {
    p_event_id: `m15-entitlement-${input.name}-${randomUUID()}`,
    p_event_type: input.status === "expired" ? "subscription.expired" : "subscription.updated",
    p_customer_id: input.customerId,
    p_subscription_id: input.subscriptionId,
    p_product_id: `m15-${input.plan}`,
    p_plan: input.plan,
    p_status: input.status,
    p_period_start: new Date(now.getTime() - 60_000).toISOString(),
    p_period_end: new Date(
      now.getTime() + (input.status === "expired" ? -1 : 86_400_000),
    ).toISOString(),
    p_cancel_at_period_end: false,
    p_event_at: eventAt,
  });
  if (error || data !== "processed") throw new Error("m15_entitlement_billing_event_not_processed");
}

function fixtureRepository(commitSha: string, outcome: "verified" | "not_found") {
  return createPinnedFixtureRepositoryProvider({
    outcome,
    commitSha,
    affectedEntity: "fixture-client",
    filePath: "src/client.ts",
    fileContents:
      'export const configuredEntity = "fixture-client"; const legacyClient = { send: () => "old" }; const modernClient = { send: () => "new" }; export const client = legacyClient.send();',
  });
}

function localConfiguration(): LocalConfig {
  const workdir = "node_modules/.cache/m15-local";
  const executable = process.platform === "win32" ? "supabase.exe" : "supabase";
  const status = spawnSync(executable, ["status", "--workdir", workdir, "--output", "env"], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32_000,
  });
  if (status.error || status.status !== 0)
    throw new Error("m15_entitlement_local_supabase_status_unavailable");
  const values = new Map<string, string>();
  for (const line of (status.stdout ?? "").split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0)
      values.set(
        line.slice(0, index).trim(),
        line
          .slice(index + 1)
          .trim()
          .replace(/^['"]|['"]$/g, ""),
      );
  }
  const url = values.get("API_URL");
  const publishableKey = values.get("PUBLISHABLE_KEY") ?? values.get("ANON_KEY");
  const serviceKey = values.get("SERVICE_ROLE_KEY") ?? values.get("SECRET_KEY");
  if (
    !url ||
    !publishableKey ||
    !serviceKey ||
    !new Set(["http://127.0.0.1:65431", "http://localhost:65431", "http://[::1]:65431"]).has(
      new URL(url).origin,
    )
  )
    throw new Error("m15_entitlement_local_supabase_guard_rejected");
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = publishableKey;
  process.env.SUPABASE_SECRET_KEY = serviceKey;
  process.env.AUTERIM_M15_LOCAL_SUPABASE_URL = url;
  process.env.AUTERIM_M15_LOCAL_SUPABASE_SECRET_KEY = serviceKey;
  return { url, publishableKey, serviceKey };
}

async function assertLocalGuard(execute: boolean) {
  const triggerConfig = await readFile(path.resolve(process.cwd(), "trigger.config.ts"), "utf8");
  if (
    process.env.NODE_ENV === "production" ||
    process.env.AUTERIM_M15_LOCAL_INTEGRATION !== "1" ||
    process.env.AUTERIM_M15_LOCAL_ACCEPTANCE_PRECLAIM_GATE !== "1" ||
    process.env.AUTERIM_M15_LOCAL_REPO_ROOT?.toLowerCase() !==
      "c:\\users\\miche\\desktop\\auterim" ||
    process.cwd().toLowerCase() !== "c:\\users\\miche\\desktop\\auterim" ||
    !/project:\s*["']proj_hwqtxtyrvwykjirkrdoh["']/.test(triggerConfig) ||
    (execute &&
      (process.env.AUTERIM_M15_REAL_TRIGGER_TOPOLOGY !== "1" ||
        !process.env.TRIGGER_SECRET_KEY?.startsWith("tr_dev_sk_")))
  )
    throw new Error("m15_entitlement_local_guard_rejected");
}

function getArtifactPath(id: string) {
  return path.join(cacheRoot, `entitlement-fixture-${id}.json`);
}

function isLocalCacheArtifact(value: string) {
  const resolved = path.resolve(value).toLowerCase();
  const root = cacheRoot.toLowerCase();
  return resolved.startsWith(`${root}${path.sep.toLowerCase()}`);
}

async function readFixture(
  filePath: string,
  id: string,
  expectedPhase: Fixture["phase"],
): Promise<Fixture> {
  const fixture = JSON.parse(await readFile(filePath, "utf8")) as Fixture;
  if (fixture.fixtureId !== id || fixture.phase !== expectedPhase || !Array.isArray(fixture.cases))
    throw new Error("m15_entitlement_fixture_artifact_invalid");
  return fixture;
}

async function writeFixture(filePath: string, fixture: Fixture) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(fixture)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rm(filePath, { force: true });
  const { rename } = await import("node:fs/promises");
  await rename(temporary, filePath);
}

async function writeCheckpoint(id: string, stage: string, cases: CaseProof[]) {
  const checkpoint = path.join(cacheRoot, `entitlement-checkpoint-${id}-${stage}.json`);
  const handle = await open(checkpoint, "w", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({ fixtureId: id, stage, observedAt: new Date().toISOString(), cases })}\n`,
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  return checkpoint;
}

async function assertPreparedCases(admin: QaClient, cases: FixtureCase[]) {
  if (cases.length !== 6 || new Set(cases.map((item) => item.queueId)).size !== 6)
    throw new Error("m15_entitlement_prepared_case_identity_invalid");
  for (const item of cases) {
    const { data, error } = await admin
      .from("remediation_preparation_queue")
      .select("id,status,preflight_run_id,impact_assessment_id")
      .eq("id", item.queueId)
      .single();
    if (
      error ||
      data.status !== "queued" ||
      data.preflight_run_id !== item.preflightRunId ||
      data.impact_assessment_id !== item.impactAssessmentId ||
      item.statePrepared !== true
    )
      throw new Error("m15_entitlement_prepared_queue_not_canonical");
  }
}

async function createGate(filePath: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const file = await open(filePath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") return null;
    throw error;
  });
  await file?.close();
}

async function assertWorkerGateFilesAbsent() {
  for (const marker of [prepHoldAll, validationHoldAll]) {
    try {
      await access(marker);
      throw new Error("m15_entitlement_stale_gate_artifact");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function waitForMarker(
  marker: string,
  timeoutMs: number,
  failure = "m15_entitlement_worker_preclaim_not_reached",
) {
  await waitUntil(
    async () => {
      try {
        await access(marker);
        return true;
      } catch {
        return false;
      }
    },
    timeoutMs,
    failure,
  );
}

async function createPostWorkGate(
  taskId: "prepare-remediation" | "validate-remediation",
  queueId: string,
) {
  await createGate(path.join(postWorkGateRoot, `${taskId}-${queueId}.hold`));
}

async function releasePostWorkGate(
  taskId: "prepare-remediation" | "validate-remediation",
  queueId: string,
) {
  await mkdir(postWorkGateRoot, { recursive: true });
  await writeFile(path.join(postWorkGateRoot, `${taskId}-${queueId}.release`), "release", {
    flag: "wx",
    mode: 0o600,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}

async function authenticateFixtureMember(local: LocalConfig, item: FixtureCase): Promise<QaClient> {
  const anonymous = createClient(local.url, local.publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signedIn = await anonymous.auth.signInWithPassword({
    email: item.userEmail,
    password: item.userPassword,
  });
  if (signedIn.error || !signedIn.data.session)
    throw new Error("m15_completion_fixture_member_auth_failed");
  return createClient(local.url, local.publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${signedIn.data.session.access_token}` } },
  });
}

async function createNewerPreflight(admin: QaClient, item: FixtureCase) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  const newer = await runPreflight({
    impactAssessmentId: item.impactAssessmentId,
    provider: fixtureRepository("d".repeat(40), "not_found"),
  });
  if (newer.status === "ineligible" || !newer.runId || newer.runId === item.preflightRunId)
    throw new Error("m15_completion_newer_preflight_missing");
  const row = await admin
    .from("preflight_runs")
    .select("id,status,verified_impact,created_at")
    .eq("id", newer.runId)
    .single();
  if (
    row.error ||
    row.data.status !== "completed" ||
    row.data.verified_impact === "verified" ||
    row.data.id === item.preflightRunId
  )
    throw new Error("m15_completion_newer_preflight_not_current");
  return newer.runId;
}

async function markerExists(marker: string) {
  try {
    await access(marker);
    return true;
  } catch {
    return false;
  }
}

async function releaseChild(taskId: string, queueId: string) {
  const marker = path.join(gateRoot, `${taskId}-${queueId}.release`);
  await mkdir(gateRoot, { recursive: true });
  await writeFile(marker, "release", { flag: "wx", mode: 0o600 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
}

async function waitForRun(runId: string, taskId: string) {
  let lastStatus = "unobserved";
  await waitUntil(
    async () => {
      try {
        const run = await runs.retrieve(runId);
        if (run.id !== runId) throw new Error("m15_entitlement_run_identity_mismatch");
        lastStatus = String(run.status)
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, "_")
          .slice(0, 40);
        if (run.isFailed || run.isCancelled) {
          throw new Error(`m15_entitlement_trigger_run_failed:${taskId}:${runId}:${lastStatus}`);
        }
        return run.isCompleted && run.status === "COMPLETED";
      } catch (error) {
        if (
          error instanceof Error &&
          /^m15_entitlement_(?:run_identity_mismatch|trigger_run_failed):/.test(error.message)
        ) {
          throw error;
        }
        const status =
          error && typeof error === "object" && "status" in error
            ? Number(error.status)
            : error && typeof error === "object" && "statusCode" in error
              ? Number(error.statusCode)
              : NaN;
        lastStatus = Number.isFinite(status) ? `api_${status}` : "api_unavailable";
        return false;
      }
    },
    60_000,
    `m15_entitlement_trigger_run_not_claimed_or_completed:${taskId}:${runId}:${lastStatus}`,
  );
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number, failure: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(failure);
}

function isRunId(value: unknown): value is string {
  return typeof value === "string" && /^run_[A-Za-z0-9_-]+$/.test(value);
}

async function cleanupLocalFixture(admin: QaClient, fixture: Fixture, artifactPath: string) {
  for (const [taskId, queueIds] of [
    [
      "prepare-remediation",
      fixture.cases
        .filter((item) => item.taskId === "prepare-remediation")
        .map((item) => item.queueId),
    ],
    [
      "validate-remediation",
      fixture.cases
        .filter((item) => item.taskId === "validate-remediation")
        .map((item) => item.queueId),
    ],
  ] as const) {
    for (const queueId of queueIds) {
      for (const suffix of ["hold", "release", "started"])
        await rm(path.join(gateRoot, `${taskId}-${queueId}.${suffix}`), { force: true });
    }
  }
  await rm(prepHoldAll, { force: true });
  await rm(validationHoldAll, { force: true });
  for (const workspaceId of fixture.workspaces) {
    const { error } = await admin
      .from("workspace_members")
      .delete()
      .eq("workspace_id", workspaceId);
    if (error) throw new Error("m15_entitlement_cleanup_membership_failed");
    await admin.from("workspaces").delete().eq("id", workspaceId);
  }
  for (const userId of fixture.users) {
    const result = await admin.auth.admin.deleteUser(userId);
    if (result.error) await admin.auth.admin.updateUserById(userId, { ban_duration: "876000h" });
  }
  if (fixture.sourceCatalogIds.length)
    await admin
      .from("source_catalog")
      .update({ enabled: false })
      .in("id", fixture.sourceCatalogIds);
  if (fixture.dependencyCatalogIds.length)
    await admin
      .from("dependency_catalog")
      .update({ enabled: false })
      .in("id", fixture.dependencyCatalogIds);
  await rm(artifactPath, { force: true });
}
