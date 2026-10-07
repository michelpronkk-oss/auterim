import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runs, tasks } from "@trigger.dev/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runHeldWorkerAuthorizationCase } from "./held-worker-entitlement-case.mts";
import type { dispatchRemediationPreparationTask } from "@/trigger/dispatch-remediation-preparation";
import type { dispatchRemediationValidationTask } from "@/trigger/dispatch-remediation-validation";

// The M15 acceptance database includes these tables before generated types are refreshed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QaClient = SupabaseClient<any, "public", "public">;

export const requiredEntitlementCases = [
  "allowed_pro_execution",
  "subscription_expired",
  "subscription_downgraded",
  "product_archived",
  "dependency_disabled",
  "preflight_superseded",
  "stale_validation_work",
] as const;

export type RequiredEntitlementCase = (typeof requiredEntitlementCases)[number];

type ReadyEntitlementCase = {
  status: "ready";
  taskId: "prepare-remediation" | "validate-remediation";
  queueId: string;
  expectedOutcome: "completed" | "persisted_before_retry" | "denied";
  /** Applies the canonical state change while the exact child is held before its claim. */
  mutateCanonicalState(): Promise<void>;
  /** Reads the canonical account/product/dependency/Preflight/proposal state after mutation. */
  verifyMutationApplied(): Promise<boolean>;
  /** Direct canonical DB assertions for the exact queue/run and the expected mutation. */
  verifyCanonicalOutcome(proof: {
    queueId: string;
    taskRunId: string;
    outcome: "completed" | "persisted_before_retry" | "denied";
    adminClient: QaClient;
  }): Promise<boolean>;
};

type UnsupportedEntitlementCase = {
  status: "unsupported";
  /** Specific missing canonical behavior/fixture; this case remains a failure. */
  reason: string;
};

export type EntitlementCasePlan = Record<
  RequiredEntitlementCase,
  ReadyEntitlementCase | UnsupportedEntitlementCase
>;

export type EntitlementCaseResult = {
  name: RequiredEntitlementCase;
  status: "proven" | "failed";
  reason?: string;
  taskId?: ReadyEntitlementCase["taskId"];
  queueId?: string;
  triggerRunId?: string;
  canonicalStatus?: string;
};

function makeCheckpointPath() {
  return path.resolve(
    process.cwd(),
    "node_modules/.cache/m15-local",
    `entitlement-matrix-${randomUUID()}.json`,
  );
}

/**
 * Execute the seven required authorization cases through the real remediation dispatchers
 * and child tasks. Callers must create queue work through the normal product path first.
 * A callback alone cannot establish a pass: the function also reads the canonical queue
 * and (for validation) attempt rows directly from the local database.
 */
export async function proveM15EntitlementMatrix(input: {
  adminClient: QaClient;
  cases: EntitlementCasePlan;
}): Promise<{
  complete: boolean;
  checkpointPath?: string;
  cases: EntitlementCaseResult[];
}> {
  await assertLocalEntitlementMatrixGuard();
  const results: EntitlementCaseResult[] = [];
  const expectedTopology: Record<RequiredEntitlementCase, ReadyEntitlementCase["taskId"]> = {
    allowed_pro_execution: "prepare-remediation",
    subscription_expired: "prepare-remediation",
    subscription_downgraded: "prepare-remediation",
    product_archived: "prepare-remediation",
    dependency_disabled: "prepare-remediation",
    preflight_superseded: "prepare-remediation",
    stale_validation_work: "validate-remediation",
  };

  for (const name of requiredEntitlementCases) {
    const planned = input.cases[name];
    if (planned.status === "unsupported") {
      results.push({ name, status: "failed", reason: planned.reason });
      continue;
    }
    const allowedOutcomes =
      name === "allowed_pro_execution"
        ? process.env.AUTERIM_M15_LOCAL_ACCEPTANCE_POST_COMMIT_RETRY === "1"
          ? ["persisted_before_retry"]
          : ["completed"]
        : ["denied"];
    if (
      planned.taskId !== expectedTopology[name] ||
      !allowedOutcomes.includes(planned.expectedOutcome)
    ) {
      results.push({
        name,
        status: "failed",
        reason: "m15_entitlement_case_task_outcome_mismatch",
        taskId: planned.taskId,
        queueId: planned.queueId,
      });
      continue;
    }
    const expectedOutcome = planned.expectedOutcome;

    try {
      const proof = await runHeldWorkerAuthorizationCase({
        taskId: planned.taskId,
        queueId: planned.queueId,
        expectedOutcome,
        dispatchEligibleWork: () => dispatchAndWaitForChild(input.adminClient, planned),
        mutateCanonicalState: async () => {
          await planned.mutateCanonicalState();
          if (!(await planned.verifyMutationApplied())) {
            throw new Error("m15_canonical_mutation_not_persisted");
          }
        },
        verifyTriggerRunCompleted: async (taskRunId) => {
          const deadline = Date.now() + 60_000;
          while (Date.now() < deadline) {
            const run = await runs.retrieve(taskRunId);
            if (run.id !== taskRunId) return false;
            if (run.isCompleted) {
              return run.status === "COMPLETED" && !run.isFailed && !run.isCancelled;
            }
            if (run.isFailed || run.isCancelled) return false;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          return false;
        },
        verifyPersistedOutcome: async ({ taskRunId, queueId: exactQueueId, outcome }) => {
          if (
            outcome.taskId !== planned.taskId ||
            outcome.runId !== taskRunId ||
            outcome.queueId !== exactQueueId ||
            exactQueueId !== planned.queueId ||
            outcome.outcome !== expectedOutcome
          ) {
            return false;
          }

          const table =
            planned.taskId === "prepare-remediation"
              ? "remediation_preparation_queue"
              : "remediation_validation_queue";
          const { data: queue, error: queueError } = await input.adminClient
            .from(table)
            .select("id,status,error_category,trigger_run_id,attempt_count,remediation_proposal_id")
            .eq("id", exactQueueId)
            .maybeSingle();
          if (
            queueError ||
            !queue ||
            queue.id !== exactQueueId ||
            queue.trigger_run_id !== taskRunId ||
            queue.status !==
              (expectedOutcome === "persisted_before_retry" ? "completed" : expectedOutcome) ||
            (expectedOutcome === "denied" && queue.error_category !== "execution_ineligible")
          ) {
            return false;
          }
          if (planned.taskId === "prepare-remediation" && expectedOutcome === "completed") {
            if (typeof queue.remediation_proposal_id !== "string") return false;
            const { data: proposal, error: proposalError } = await input.adminClient
              .from("remediation_proposals")
              .select("id")
              .eq("id", queue.remediation_proposal_id)
              .maybeSingle();
            if (proposalError || proposal?.id !== queue.remediation_proposal_id) return false;
          }
          if (planned.taskId === "validate-remediation" && expectedOutcome === "denied") {
            const { data: attempt, error: attemptError } = await input.adminClient
              .from("remediation_validation_attempts")
              .select("queue_id,outcome,error_category")
              .eq("queue_id", exactQueueId)
              .eq("attempt_number", queue.attempt_count)
              .maybeSingle();
            if (
              attemptError ||
              attempt?.queue_id !== exactQueueId ||
              attempt.outcome !== "denied" ||
              attempt.error_category !== "execution_ineligible"
            ) {
              return false;
            }
          }
          return planned.verifyCanonicalOutcome({
            queueId: exactQueueId,
            taskRunId,
            outcome: expectedOutcome,
            adminClient: input.adminClient,
          });
        },
      });

      results.push({
        name,
        status: proof.persistedDenial ? "proven" : "failed",
        taskId: planned.taskId,
        queueId: planned.queueId,
        triggerRunId: proof.taskRunId,
        canonicalStatus: expectedOutcome,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      results.push({
        name,
        status: "failed",
        taskId: planned.taskId,
        reason: /^[a-z0-9_:]{1,180}$/.test(message) ? message : "case_execution_failed",
        queueId: planned.queueId,
      });
    }
  }

  const complete =
    results.length === requiredEntitlementCases.length &&
    results.every((result) => result.status === "proven") &&
    new Set(results.map((result) => result.queueId)).size === requiredEntitlementCases.length &&
    new Set(results.map((result) => result.triggerRunId)).size === requiredEntitlementCases.length;

  if (!complete) return { complete: false, cases: results };

  const checkpoint = {
    status: "m15_entitlement_matrix_proven",
    observedAt: new Date().toISOString(),
    taskIds: [...new Set(results.flatMap((result) => result.taskId ?? []))],
    caseCount: results.length,
    cases: results,
  };
  const checkpointPath = makeCheckpointPath();
  await mkdir(path.dirname(checkpointPath), { recursive: true });
  const file = await open(checkpointPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(checkpoint)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  return { complete: true, checkpointPath, cases: results };
}

async function dispatchAndWaitForChild(
  adminClient: QaClient,
  scenario: ReadyEntitlementCase,
): Promise<string> {
  const queueTable =
    scenario.taskId === "prepare-remediation"
      ? "remediation_preparation_queue"
      : "remediation_validation_queue";
  const queueFunction =
    scenario.taskId === "prepare-remediation"
      ? "list_remediation_preparation_queue"
      : "list_remediation_validation_queue";
  const { data: pending, error: pendingError } = await adminClient.rpc(queueFunction, {
    p_limit: 20,
  });
  if (pendingError || !Array.isArray(pending) || pending.length !== 1) {
    throw new Error("m15_entitlement_dispatcher_queue_not_isolated");
  }
  const pendingId = (pending[0] as { queue_id?: unknown }).queue_id;
  if (pendingId !== scenario.queueId) {
    throw new Error("m15_entitlement_queue_not_next_dispatch_candidate");
  }
  const scheduleId = `m15-entitlement-${scenario.queueId}`;
  const dispatch =
    scenario.taskId === "prepare-remediation"
      ? await tasks.trigger<typeof dispatchRemediationPreparationTask>(
          "dispatch-remediation-preparation",
          {
            type: "IMPERATIVE",
            scheduleId,
            timestamp: new Date(),
            timezone: "UTC",
            upcoming: [],
          },
        )
      : await tasks.trigger<typeof dispatchRemediationValidationTask>(
          "dispatch-remediation-validation",
          {
            type: "IMPERATIVE",
            scheduleId,
            timestamp: new Date(),
            timezone: "UTC",
            upcoming: [],
          },
        );
  if (!/^run_[A-Za-z0-9_-]+$/.test(dispatch.id)) {
    throw new Error("m15_entitlement_dispatcher_run_id_invalid");
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { data, error } = await adminClient
      .from(queueTable)
      .select("id,status,trigger_run_id")
      .eq("id", scenario.queueId)
      .maybeSingle();
    if (error || !data || data.id !== scenario.queueId) {
      throw new Error("m15_entitlement_queue_read_failed");
    }
    if (data.status === "dispatched" && typeof data.trigger_run_id === "string") {
      if (!/^run_[A-Za-z0-9_-]+$/.test(data.trigger_run_id)) {
        throw new Error("m15_entitlement_child_run_id_invalid");
      }
      return data.trigger_run_id;
    }
    if (["denied", "failed", "canceled", "validated", "validation_failed"].includes(data.status)) {
      throw new Error("m15_entitlement_queue_terminal_before_child_hold");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("m15_entitlement_child_dispatch_timeout");
}

async function assertLocalEntitlementMatrixGuard() {
  const root = process.env.AUTERIM_M15_LOCAL_REPO_ROOT;
  const localUrl = process.env.AUTERIM_M15_LOCAL_SUPABASE_URL;
  let localTarget = false;
  try {
    localTarget = Boolean(
      localUrl &&
      new Set(["http://127.0.0.1:65431", "http://localhost:65431", "http://[::1]:65431"]).has(
        new URL(localUrl).origin,
      ),
    );
  } catch {
    localTarget = false;
  }
  const triggerConfig = await readFile(path.resolve(process.cwd(), "trigger.config.ts"), "utf8");
  if (
    process.env.NODE_ENV === "production" ||
    process.env.AUTERIM_M15_LOCAL_INTEGRATION !== "1" ||
    process.env.AUTERIM_M15_REAL_TRIGGER_TOPOLOGY !== "1" ||
    process.env.AUTERIM_M15_LOCAL_ACCEPTANCE_DUPLICATE_DELIVERIES !== "1" ||
    process.env.AUTERIM_M15_LOCAL_ACCEPTANCE_PRECLAIM_GATE !== "1" ||
    !process.env.TRIGGER_SECRET_KEY?.startsWith("tr_dev_sk_") ||
    !localTarget ||
    !/project:\s*["']proj_hwqtxtyrvwykjirkrdoh["']/.test(triggerConfig) ||
    !root ||
    path.win32.resolve(root).toLowerCase() !== "c:\\users\\miche\\desktop\\auterim" ||
    path.win32.resolve(process.cwd()).toLowerCase() !== "c:\\users\\miche\\desktop\\auterim"
  ) {
    throw new Error("m15_entitlement_matrix_local_guard_rejected");
  }
}
