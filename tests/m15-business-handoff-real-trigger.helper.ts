import { randomUUID } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tasks } from "@trigger.dev/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isM15LocalAcceptanceRuntime } from "@/lib/m15/local-trigger-proof";
import type { dispatchBusinessHandoffTask } from "@/trigger/dispatch-business-handoff";

// The M15 QA harness exercises schema additions before generated Database types are refreshed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QaClient = SupabaseClient<any, "public", "public">;

export type BusinessHandoffScenario = {
  /** Each scenario must use its own validated proposal and its matching repository. */
  proposalId: string;
  preflightRunId: string;
  repositoryId: string;
};

export type BusinessHandoffProof = {
  requestId: string;
  triggerRunId: string;
  finalStatus: "prepared" | "denied";
  errorCategory: string | null;
  policyVersionBeforeRelease: number;
  policyVersionAfterRelease: number;
  policyVersionAtMutation: number | null;
  observedAt: string;
};

const taskId = "prepare-business-handoff";
const gateRoot = path.resolve(process.cwd(), "node_modules/.cache/m15-local/preclaim-gates");
const outcomesPath = path.join(process.cwd(), "node_modules/.cache/m15-local/task-outcomes.jsonl");

function assertLocalTriggerAcceptance() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.AUTERIM_M15_REAL_TRIGGER_TOPOLOGY !== "1" ||
    process.env.AUTERIM_M15_LOCAL_ACCEPTANCE_PRECLAIM_GATE !== "1" ||
    !isM15LocalAcceptanceRuntime() ||
    path.win32.resolve(process.cwd()).toLowerCase() !== "c:\\users\\miche\\desktop\\auterim"
  ) {
    throw new Error("business_handoff_real_trigger_local_guard_failed");
  }
}

async function waitForFile(file: string, deadline: number, label: string) {
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`business_handoff_${label}_timeout`);
}

async function waitForTaskOutcome(requestId: string, allowed: Set<string>, deadline: number) {
  while (Date.now() < deadline) {
    try {
      const { readFile } = await import("node:fs/promises");
      const rows = (await readFile(outcomesPath, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [
              JSON.parse(line) as {
                taskId?: string;
                queueId?: string;
                runId?: string;
                outcome?: string;
              },
            ];
          } catch {
            return [];
          }
        });
      const row = rows.find(
        (item) =>
          item.taskId === taskId &&
          item.queueId === requestId &&
          item.runId &&
          item.outcome &&
          allowed.has(item.outcome),
      );
      if (row?.runId && row.outcome) return { runId: row.runId, outcome: row.outcome };
    } catch {
      // The guarded worker creates this file when it records its first local task outcome.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("business_handoff_real_trigger_outcome_timeout");
}

async function executeHeldRequest(input: {
  memberClient: QaClient;
  adminClient: QaClient;
  workspaceId: string;
  scenario: BusinessHandoffScenario;
  idempotencyKey: string;
  expectedStatus: "prepared" | "denied";
  mutateWhileHeld?: () => Promise<number | null>;
  expectPolicyVersionChange?: boolean;
}): Promise<BusinessHandoffProof> {
  assertLocalTriggerAcceptance();
  const holdAll = path.join(gateRoot, `${taskId}-hold-all`);
  await mkdir(gateRoot, { recursive: true });
  await writeFile(holdAll, randomUUID(), { flag: "wx", mode: 0o600 });
  let requestId: string | undefined;
  let releasePath: string | undefined;
  try {
    const { data: run, error: runError } = await input.adminClient
      .from("preflight_runs")
      .select("workspace_id")
      .eq("id", input.scenario.preflightRunId)
      .single();
    if (runError || run?.workspace_id !== input.workspaceId) {
      throw new Error("business_handoff_fixture_workspace_mismatch");
    }
    const { data, error } = await input.memberClient.rpc("request_business_handoff", {
      p_workspace_id: input.workspaceId,
      p_preflight_run_id: input.scenario.preflightRunId,
      p_repository_id: input.scenario.repositoryId,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error || !data?.id || data.remediationProposalId !== input.scenario.proposalId) {
      throw new Error("business_handoff_request_creation_failed");
    }
    requestId = data.id as string;
    const queuedPolicyVersion = data.policyVersion as number;
    if (!Number.isInteger(queuedPolicyVersion) || queuedPolicyVersion < 1) {
      throw new Error("business_handoff_queued_policy_version_invalid");
    }
    releasePath = path.join(gateRoot, `${taskId}-${requestId}.release`);
    const startedPath = path.join(gateRoot, `${taskId}-${requestId}.started`);
    const dispatch = await tasks.trigger<typeof dispatchBusinessHandoffTask>(
      "dispatch-business-handoff",
      {
        type: "IMPERATIVE",
        // Give every QA dispatch a distinct schedule identity. Reusing one ID can
        // coalesce consecutive imperative schedule runs and strand later requests queued.
        scheduleId: `m15-local-${requestId}`,
        timestamp: new Date(),
        timezone: "UTC",
        upcoming: [],
      },
    );
    if (!/^run_[A-Za-z0-9_-]+$/.test(dispatch.id)) {
      throw new Error("business_handoff_dispatch_run_id_invalid");
    }
    const dispatchedDeadline = Date.now() + 120_000;
    while (Date.now() < dispatchedDeadline) {
      const { data: current, error: readError } = await input.adminClient
        .from("business_handoff_requests")
        .select("id,status,trigger_run_id")
        .eq("id", requestId)
        .single();
      if (readError || !current) throw new Error("business_handoff_request_poll_failed");
      if (current.status === "failed" || current.status === "denied") {
        throw new Error("business_handoff_request_terminal_before_worker_hold");
      }
      try {
        await access(startedPath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    await waitForFile(startedPath, Date.now() + 1_000, "preclaim_hold");

    // The stable hold-all marker is removed only after this exact request is known to be
    // parked immediately before the canonical claim RPC. No later handoff can inherit it.
    await rm(holdAll, { force: true });
    const mutationPolicyVersion = input.mutateWhileHeld ? await input.mutateWhileHeld() : null;
    if (
      input.expectPolicyVersionChange &&
      (mutationPolicyVersion === null || mutationPolicyVersion <= queuedPolicyVersion)
    ) {
      throw new Error("business_handoff_policy_version_did_not_advance");
    }
    await writeFile(releasePath, "release", { flag: "wx", mode: 0o600 });

    const terminalDeadline = Date.now() + 45_000;
    let row: {
      status: string;
      trigger_run_id: string | null;
      error_category: string | null;
      policy_version: number;
    } | null = null;
    while (Date.now() < terminalDeadline) {
      const result = await input.adminClient
        .from("business_handoff_requests")
        .select("status,trigger_run_id,error_category,policy_version")
        .eq("id", requestId)
        .single();
      if (result.error || !result.data) throw new Error("business_handoff_terminal_poll_failed");
      row = result.data;
      if (["prepared", "denied", "failed"].includes(row.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (row?.status !== input.expectedStatus || !row.trigger_run_id) {
      throw new Error(`business_handoff_expected_${input.expectedStatus}_not_persisted`);
    }
    const outcome = await waitForTaskOutcome(
      requestId,
      new Set([input.expectedStatus]),
      Date.now() + 10_000,
    );
    if (outcome.runId !== row.trigger_run_id) {
      throw new Error("business_handoff_trigger_run_correlation_mismatch");
    }
    if (row.policy_version !== queuedPolicyVersion) {
      throw new Error("business_handoff_queued_policy_version_changed");
    }
    if (input.expectedStatus === "denied" && row.error_category !== "execution_ineligible") {
      throw new Error("business_handoff_denial_not_at_execution_recheck");
    }
    return {
      requestId,
      triggerRunId: outcome.runId,
      finalStatus: input.expectedStatus,
      errorCategory: row.error_category,
      policyVersionBeforeRelease: queuedPolicyVersion,
      policyVersionAfterRelease: row.policy_version,
      policyVersionAtMutation: mutationPolicyVersion,
      observedAt: new Date().toISOString(),
    };
  } finally {
    await rm(holdAll, { force: true });
    if (releasePath) await rm(releasePath, { force: true });
    if (requestId) await rm(path.join(gateRoot, `${taskId}-${requestId}.started`), { force: true });
  }
}

async function setPolicy(
  memberClient: QaClient,
  input: {
    workspaceId: string;
    productId: string;
    enabled: boolean;
    handoffAllowed: boolean;
    approvalRequired: boolean;
    repositoryId: string;
  },
) {
  const { data, error } = await memberClient.rpc("set_product_remediation_policy", {
    p_workspace_id: input.workspaceId,
    p_product_id: input.productId,
    p_enabled: input.enabled,
    p_draft_pr_preparation_allowed: true,
    p_automatic_workflow_handoff_allowed: input.handoffAllowed,
    p_approval_required: input.approvalRequired,
    p_allowed_repository_ids: [input.repositoryId],
  });
  if (error || typeof data?.policy_version !== "number") {
    throw new Error("business_handoff_canonical_policy_mutation_failed");
  }
  return data.policy_version as number;
}

async function setPlan(
  adminClient: QaClient,
  input: {
    customerId: string;
    subscriptionId: string;
    plan: "business" | "pro";
  },
) {
  const eventAt = new Date().toISOString();
  const { data, error } = await adminClient.rpc("process_dodo_subscription_event", {
    p_event_id: `m15-handoff-${input.plan}-${randomUUID()}`,
    p_event_type: "subscription.updated",
    p_customer_id: input.customerId,
    p_subscription_id: input.subscriptionId,
    p_product_id: `m15-${input.plan}`,
    p_plan: input.plan,
    p_status: "active",
    p_period_start: eventAt,
    p_period_end: new Date(Date.now() + 86_400_000).toISOString(),
    p_cancel_at_period_end: false,
    p_event_at: eventAt,
  });
  if (error || data !== "processed")
    throw new Error("business_handoff_canonical_plan_mutation_failed");
}

/**
 * Exercises the persisted handoff boundary through the live Trigger Development worker.
 * The caller supplies four separate validated proposal/repository pairs created by the
 * normal Preflight/remediation/validation topology. The helper itself only creates the
 * handoff requests through the authenticated RPC and mutates policy/billing through their
 * canonical operations while the child is held before its execution-time recheck.
 */
export async function proveBusinessHandoffRealTrigger(input: {
  memberClient: QaClient;
  adminClient: QaClient;
  workspaceId: string;
  productId: string;
  customerId: string;
  subscriptionId: string;
  scenarios: {
    allow: BusinessHandoffScenario;
    policyDenied: BusinessHandoffScenario;
    policyVersionChanged: BusinessHandoffScenario;
    downgradeDenied: BusinessHandoffScenario;
  };
}): Promise<
  Record<
    "allow" | "policyDenied" | "policyVersionChanged" | "downgradeDenied",
    BusinessHandoffProof
  >
> {
  assertLocalTriggerAcceptance();
  const logicalActions = Object.values(input.scenarios).map(
    (scenario) => `${scenario.proposalId}:${scenario.repositoryId}`,
  );
  if (new Set(logicalActions).size !== logicalActions.length) {
    throw new Error("business_handoff_scenarios_must_use_distinct_proposal_repository_pairs");
  }

  await setPlan(input.adminClient, {
    customerId: input.customerId,
    subscriptionId: input.subscriptionId,
    plan: "business",
  });
  await setPolicy(input.memberClient, {
    workspaceId: input.workspaceId,
    productId: input.productId,
    enabled: true,
    handoffAllowed: true,
    approvalRequired: true,
    repositoryId: input.scenarios.allow.repositoryId,
  });
  const allow = await executeHeldRequest({
    memberClient: input.memberClient,
    adminClient: input.adminClient,
    workspaceId: input.workspaceId,
    scenario: input.scenarios.allow,
    idempotencyKey: `m15-business-allow-${randomUUID()}`,
    expectedStatus: "prepared",
  });

  await setPolicy(input.memberClient, {
    workspaceId: input.workspaceId,
    productId: input.productId,
    enabled: true,
    handoffAllowed: true,
    approvalRequired: true,
    repositoryId: input.scenarios.policyDenied.repositoryId,
  });
  const policyDenied = await executeHeldRequest({
    memberClient: input.memberClient,
    adminClient: input.adminClient,
    workspaceId: input.workspaceId,
    scenario: input.scenarios.policyDenied,
    idempotencyKey: `m15-business-policy-denied-${randomUUID()}`,
    expectedStatus: "denied",
    mutateWhileHeld: async () =>
      setPolicy(input.memberClient, {
        workspaceId: input.workspaceId,
        productId: input.productId,
        enabled: false,
        handoffAllowed: false,
        approvalRequired: true,
        repositoryId: input.scenarios.policyDenied.repositoryId,
      }),
    expectPolicyVersionChange: true,
  });

  await setPolicy(input.memberClient, {
    workspaceId: input.workspaceId,
    productId: input.productId,
    enabled: true,
    handoffAllowed: true,
    approvalRequired: true,
    repositoryId: input.scenarios.policyVersionChanged.repositoryId,
  });
  const policyVersionChanged = await executeHeldRequest({
    memberClient: input.memberClient,
    adminClient: input.adminClient,
    workspaceId: input.workspaceId,
    scenario: input.scenarios.policyVersionChanged,
    idempotencyKey: `m15-business-policy-version-${randomUUID()}`,
    expectedStatus: "denied",
    mutateWhileHeld: async () =>
      // The policy remains eligible, but its version changes. The child must reject the
      // queued request because it was authorized under an older policy snapshot.
      setPolicy(input.memberClient, {
        workspaceId: input.workspaceId,
        productId: input.productId,
        enabled: true,
        handoffAllowed: true,
        // Keep the policy valid and still eligible while setPolicy advances its
        // canonical version. The queued request must be denied as stale V1 even
        // though the current V2 policy continues to permit this operation.
        approvalRequired: true,
        repositoryId: input.scenarios.policyVersionChanged.repositoryId,
      }),
    expectPolicyVersionChange: true,
  });

  await setPolicy(input.memberClient, {
    workspaceId: input.workspaceId,
    productId: input.productId,
    enabled: true,
    handoffAllowed: true,
    approvalRequired: true,
    repositoryId: input.scenarios.downgradeDenied.repositoryId,
  });
  const downgradeDenied = await executeHeldRequest({
    memberClient: input.memberClient,
    adminClient: input.adminClient,
    workspaceId: input.workspaceId,
    scenario: input.scenarios.downgradeDenied,
    idempotencyKey: `m15-business-downgrade-${randomUUID()}`,
    expectedStatus: "denied",
    mutateWhileHeld: async () => {
      await setPlan(input.adminClient, {
        customerId: input.customerId,
        subscriptionId: input.subscriptionId,
        plan: "pro",
      });
      return null;
    },
  });

  return { allow, policyDenied, policyVersionChanged, downgradeDenied };
}
