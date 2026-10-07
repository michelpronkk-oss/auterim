import { access, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

const allowedTaskIds = new Set([
  "run-preflight",
  "prepare-remediation",
  "validate-remediation",
  "prepare-business-handoff",
]);
const localSupabaseOrigins = new Set([
  "http://127.0.0.1:65431",
  "http://localhost:65431",
  "http://[::1]:65431",
]);

type LocalTaskOutcome = {
  taskId: string;
  runId: string;
  queueId: string;
  queueAttempt: number;
  triggerAttempt: number;
  outcome: string;
};

export type HeldWorkerAuthorizationCaseInput = {
  taskId: string;
  queueId: string;
  expectedOutcome: string;
  timeoutMs?: number;
  /** Create/advance eligible work through the normal service/RPC path and return its exact Trigger run ID. */
  dispatchEligibleWork(): Promise<string>;
  /** Apply the canonical entitlement/policy/resource mutation while the real worker is held before claim. */
  mutateCanonicalState(): Promise<void>;
  /** Independently confirm the exact returned Trigger run reached a terminal success state. */
  verifyTriggerRunCompleted(taskRunId: string): Promise<boolean>;
  /** Read canonical persisted state after that exact Trigger run finishes. */
  verifyPersistedOutcome(proof: {
    taskRunId: string;
    queueId: string;
    outcome: LocalTaskOutcome;
  }): Promise<boolean>;
};

/**
 * Drive one real Trigger Development worker across a deterministic pre-claim boundary.
 * Callbacks must use the normal persisted service/RPC and read paths; this helper only
 * coordinates the already-installed local QA hold and observes the worker result.
 */
export async function runHeldWorkerAuthorizationCase(input: HeldWorkerAuthorizationCaseInput) {
  assertLocalAcceptanceGuard(input);

  const gateDirectory = path.resolve(process.cwd(), "node_modules/.cache/m15-local/preclaim-gates");
  const outcomePath = path.resolve(
    process.cwd(),
    "node_modules/.cache/m15-local/task-outcomes.jsonl",
  );
  const holdPath = path.join(gateDirectory, `${input.taskId}-${input.queueId}.hold`);
  const startedPath = path.join(gateDirectory, `${input.taskId}-${input.queueId}.started`);
  const releasePath = path.join(gateDirectory, `${input.taskId}-${input.queueId}.release`);
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 120_000, 5_000), 180_000);

  await mkdir(gateDirectory, { recursive: true });
  for (const marker of [holdPath, startedPath, releasePath]) {
    try {
      await access(marker);
      throw new Error("m15_preclaim_gate_artifact_already_exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const hold = await open(holdPath, "wx", 0o600);
  await hold.close();

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    const marker = await open(releasePath, "wx", 0o600);
    await marker.close();
  };

  try {
    const taskRunId = await input.dispatchEligibleWork();
    if (!/^run_[A-Za-z0-9_-]+$/.test(taskRunId)) {
      throw new Error("m15_trigger_task_run_id_invalid");
    }

    await waitForMarker(startedPath, timeoutMs, "m15_trigger_worker_preclaim_not_reached");
    await input.mutateCanonicalState();
    await release();

    const outcome = await waitForWorkerOutcome({
      outcomePath,
      taskId: input.taskId,
      queueId: input.queueId,
      taskRunId,
      expectedOutcome: input.expectedOutcome,
      timeoutMs,
    });
    if (!(await input.verifyTriggerRunCompleted(taskRunId))) {
      throw new Error("m15_exact_trigger_run_terminal_success_not_proven");
    }
    const persisted = await input.verifyPersistedOutcome({
      taskRunId,
      queueId: input.queueId,
      outcome,
    });
    if (!persisted) throw new Error("m15_worker_denial_persistence_not_proven");

    return {
      taskId: input.taskId,
      queueId: input.queueId,
      taskRunId,
      workerOutcome: outcome.outcome,
      triggerAttempt: outcome.triggerAttempt,
      persistedDenial: true as const,
    };
  } finally {
    await release().catch(() => undefined);
    await Promise.all(
      [holdPath, startedPath, releasePath].map((marker) => rm(marker, { force: true })),
    );
  }
}

function assertLocalAcceptanceGuard(input: HeldWorkerAuthorizationCaseInput) {
  const configuredRoot = process.env.AUTERIM_M15_LOCAL_REPO_ROOT;
  const localUrl = process.env.AUTERIM_M15_LOCAL_SUPABASE_URL;
  let validLocalUrl = false;
  try {
    validLocalUrl = Boolean(localUrl && localSupabaseOrigins.has(new URL(localUrl).origin));
  } catch {
    validLocalUrl = false;
  }
  if (
    process.env.NODE_ENV === "production" ||
    process.env.AUTERIM_M15_LOCAL_INTEGRATION !== "1" ||
    process.env.AUTERIM_M15_LOCAL_ACCEPTANCE_DUPLICATE_DELIVERIES !== "1" ||
    process.env.AUTERIM_M15_LOCAL_ACCEPTANCE_PRECLAIM_GATE !== "1" ||
    !validLocalUrl ||
    !configuredRoot ||
    path.win32.resolve(configuredRoot).toLowerCase() !== "c:\\users\\miche\\desktop\\auterim" ||
    path.win32.resolve(process.cwd()).toLowerCase() !== "c:\\users\\miche\\desktop\\auterim" ||
    !allowedTaskIds.has(input.taskId) ||
    !/^[0-9a-f-]{36}$/i.test(input.queueId) ||
    !/^[a-z_]{1,40}$/.test(input.expectedOutcome)
  ) {
    throw new Error("m15_held_worker_local_acceptance_guard_rejected");
  }
}

async function waitForMarker(markerPath: string, timeoutMs: number, errorCode: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(markerPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(errorCode);
}

async function waitForWorkerOutcome(input: {
  outcomePath: string;
  taskId: string;
  queueId: string;
  taskRunId: string;
  expectedOutcome: string;
  timeoutMs: number;
}): Promise<LocalTaskOutcome> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    try {
      const outcomes = (await readFile(input.outcomePath, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as LocalTaskOutcome];
          } catch {
            return [];
          }
        });
      const exact = outcomes.find(
        (row) =>
          row.taskId === input.taskId &&
          row.queueId === input.queueId &&
          row.runId === input.taskRunId,
      );
      if (exact) {
        if (exact.outcome !== input.expectedOutcome) {
          throw new Error("m15_worker_outcome_did_not_match_expected_denial");
        }
        return exact;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "m15_worker_outcome_did_not_match_expected_denial"
      ) {
        throw error;
      }
      // The local worker logger creates this file when the task reports its first outcome.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("m15_trigger_worker_denial_outcome_timeout");
}
