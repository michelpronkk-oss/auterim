import path from "node:path";
import { access, mkdir, writeFile } from "node:fs/promises";

const localSupabaseOrigins = new Set([
  "http://127.0.0.1:65431",
  "http://localhost:65431",
  "http://[::1]:65431",
]);

export function isM15LocalAcceptanceRuntime() {
  if (process.env.AUTERIM_M15_LOCAL_INTEGRATION !== "1") return false;

  const localUrl = process.env.AUTERIM_M15_LOCAL_SUPABASE_URL;
  const configuredRoot = process.env.AUTERIM_M15_LOCAL_REPO_ROOT;
  try {
    return Boolean(
      localUrl &&
      localSupabaseOrigins.has(new URL(localUrl).origin) &&
      configuredRoot &&
      path.win32.resolve(configuredRoot).toLowerCase() === "c:\\users\\miche\\desktop\\auterim",
    );
  } catch {
    return false;
  }
}

export function isM15LocalAcceptanceEnabled() {
  return (
    process.env.AUTERIM_M15_LOCAL_ACCEPTANCE_DUPLICATE_DELIVERIES === "1" &&
    isM15LocalAcceptanceRuntime()
  );
}

/** Duplicate only the explicitly marked primary money-path queue in the local QA run. */
export async function isM15LocalAcceptanceDuplicateTarget(queueId: string) {
  if (
    !isM15LocalAcceptanceEnabled() ||
    process.env.NODE_ENV === "production" ||
    !/^[0-9a-f-]{36}$/i.test(queueId) ||
    path.win32.resolve(process.cwd()).toLowerCase() !== "c:\\users\\miche\\desktop\\auterim"
  ) {
    return false;
  }
  try {
    await access(
      path.resolve(
        process.cwd(),
        "node_modules/.cache/m15-local/duplicate-delivery-targets",
        queueId,
      ),
    );
    return true;
  } catch {
    return false;
  }
}

type GatedTask =
  "run-preflight" | "prepare-remediation" | "validate-remediation" | "prepare-business-handoff";
type CompletionGatedTask = "prepare-remediation" | "validate-remediation";

/**
 * Deterministic queue→mutate→execute coordination for local M15 acceptance only.
 * Trigger workers pause before their canonical claim RPC when the exact task/queue
 * hold file exists. This path is disabled in production and requires the existing
 * Auterim + loopback Supabase integration guard as well as an explicit launcher flag.
 */
export async function waitForM15LocalAcceptancePreClaimGate(input: {
  taskId: GatedTask;
  queueId: string;
  timeoutMs?: number;
}) {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.AUTERIM_M15_LOCAL_ACCEPTANCE_PRECLAIM_GATE !== "1" ||
    !isM15LocalAcceptanceRuntime() ||
    !/^[0-9a-f-]{36}$/i.test(input.queueId)
  ) {
    return;
  }

  const gateDirectory = path.resolve(process.cwd(), "node_modules/.cache/m15-local/preclaim-gates");
  const exactRoot = path.win32.resolve(process.cwd()).toLowerCase();
  if (exactRoot !== "c:\\users\\miche\\desktop\\auterim") return;
  const holdPaths = [
    path.join(gateDirectory, `${input.taskId}-${input.queueId}.hold`),
    path.join(gateDirectory, `${input.taskId}-hold-all`),
  ];
  let isHeld = false;
  for (const holdPath of holdPaths) {
    try {
      await access(holdPath);
      isHeld = true;
      break;
    } catch {
      // Try the next fixed, local-only gate filename.
    }
  }
  if (!isHeld) return;

  await mkdir(gateDirectory, { recursive: true });
  await writeFile(path.join(gateDirectory, `${input.taskId}-${input.queueId}.started`), "ready", {
    mode: 0o600,
  });
  const releasePath = path.join(gateDirectory, `${input.taskId}-${input.queueId}.release`);
  const deadline = Date.now() + Math.min(Math.max(input.timeoutMs ?? 90_000, 1_000), 120_000);
  while (Date.now() < deadline) {
    try {
      await access(releasePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("m15_local_acceptance_preclaim_gate_timeout");
}

/** Hold a real worker after provider/Docker work and immediately before completion persistence. */
export async function waitForM15LocalAcceptancePostWorkGate(input: {
  taskId: CompletionGatedTask;
  queueId: string;
  timeoutMs?: number;
}) {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.AUTERIM_M15_LOCAL_ACCEPTANCE_POSTWORK_GATE !== "1" ||
    !isM15LocalAcceptanceRuntime() ||
    !/^[0-9a-f-]{36}$/i.test(input.queueId)
  ) {
    return;
  }

  if (path.win32.resolve(process.cwd()).toLowerCase() !== "c:\\users\\miche\\desktop\\auterim")
    return;
  const gateDirectory = path.resolve(process.cwd(), "node_modules/.cache/m15-local/postwork-gates");
  const stem = `${input.taskId}-${input.queueId}`;
  try {
    await access(path.join(gateDirectory, `${stem}.hold`));
  } catch {
    return;
  }

  await mkdir(gateDirectory, { recursive: true });
  await writeFile(path.join(gateDirectory, `${stem}.started`), "ready", { mode: 0o600 });
  const releasePath = path.join(gateDirectory, `${stem}.release`);
  const deadline = Date.now() + Math.min(Math.max(input.timeoutMs ?? 90_000, 1_000), 120_000);
  while (Date.now() < deadline) {
    try {
      await access(releasePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("m15_local_acceptance_postwork_gate_timeout");
}

type PostCommitRetryTask = "prepare-remediation" | "validate-remediation";

export function shouldInjectM15PostCommitRetry(input: {
  taskId: PostCommitRetryTask;
  queueId: string;
  triggerAttempt: number | undefined;
}) {
  return Boolean(
    process.env.NODE_ENV !== "production" &&
    process.env.AUTERIM_M15_LOCAL_ACCEPTANCE_POST_COMMIT_RETRY === "1" &&
    isM15LocalAcceptanceEnabled() &&
    input.triggerAttempt === 1 &&
    /^[0-9a-f-]{36}$/i.test(input.queueId),
  );
}

export function isM15PostCommitRetryFault(error: unknown, taskId: PostCommitRetryTask) {
  return Boolean(
    error instanceof Error &&
    error.message === `m15_local_acceptance_post_commit_retry:${taskId}` &&
    process.env.NODE_ENV !== "production" &&
    process.env.AUTERIM_M15_LOCAL_ACCEPTANCE_POST_COMMIT_RETRY === "1" &&
    isM15LocalAcceptanceEnabled(),
  );
}

export async function logM15LocalTaskOutcome(input: {
  taskId:
    "run-preflight" | "prepare-remediation" | "validate-remediation" | "prepare-business-handoff";
  runId: string;
  queueId: string;
  queueAttempt: number;
  triggerAttempt: number;
  outcome: string;
}) {
  if (!isM15LocalAcceptanceEnabled()) return;
  try {
    const localUrl = process.env.AUTERIM_M15_LOCAL_SUPABASE_URL;
    const configuredRoot = process.env.AUTERIM_M15_LOCAL_REPO_ROOT;
    if (
      !localUrl ||
      !localSupabaseOrigins.has(new URL(localUrl).origin) ||
      !configuredRoot ||
      path.win32.resolve(configuredRoot).toLowerCase() !== "c:\\users\\miche\\desktop\\auterim" ||
      !/^run_[A-Za-z0-9_-]+$/.test(input.runId) ||
      !/^[0-9a-f-]{36}$/i.test(input.queueId) ||
      !Number.isInteger(input.queueAttempt) ||
      !Number.isInteger(input.triggerAttempt) ||
      !/^[a-z0-9_]{1,40}$/.test(input.outcome)
    ) {
      return;
    }

    console.info(
      `AUTERIM_M15_TASK_OUTCOME task=${input.taskId} runId=${input.runId} queueId=${input.queueId} queueAttempt=${input.queueAttempt} triggerAttempt=${input.triggerAttempt} outcome=${input.outcome}`,
    );
  } catch {
    // Local acceptance instrumentation must never change a product task's outcome.
  }
}
