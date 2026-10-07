import { open, mkdir } from "node:fs/promises";
import path from "node:path";

export const TRIGGER_DISPATCH_RETRY_BUDGET_MS = 60_000;
export const TRIGGER_MARKER_POLL_BUDGET_MS = 180_000;
export const TRIGGER_WRAPPER_CLEANUP_MARGIN_MS = 60_000;
export const TRIGGER_WRAPPER_DISPATCH_TIMEOUT_MS =
  TRIGGER_DISPATCH_RETRY_BUDGET_MS +
  TRIGGER_MARKER_POLL_BUDGET_MS +
  TRIGGER_WRAPPER_CLEANUP_MARGIN_MS;
export const TRIGGER_AUTH_PROBE_BUDGET_MS = 90_000;
export const TRIGGER_WORKER_READINESS_BUDGET_MS = 120_000;
export const TRIGGER_DEV_ROUNDTRIP_PROCESS_MARGIN_MS = 30_000;
export const TRIGGER_DEV_ROUNDTRIP_PROCESS_TIMEOUT_MS =
  TRIGGER_AUTH_PROBE_BUDGET_MS +
  TRIGGER_WORKER_READINESS_BUDGET_MS +
  TRIGGER_WRAPPER_DISPATCH_TIMEOUT_MS +
  TRIGGER_DEV_ROUNDTRIP_PROCESS_MARGIN_MS;

export type RoundTripStatus = "accepted" | "complete" | "failed";
export type RunStatusTransition = {
  status: string;
  isCompleted: boolean;
  isFailed: boolean;
  isCancelled: boolean;
  observedAt: string;
};

export function isSuccessfulCompletedRun(run: {
  status: string;
  isCompleted: boolean;
  isFailed: boolean;
  isCancelled: boolean;
}) {
  return run.status === "COMPLETED" && run.isCompleted && !run.isFailed && !run.isCancelled;
}

export type RoundTripObservation = {
  schemaVersion: 1;
  status: RoundTripStatus;
  runId: string;
  dispatchAttemptId: string;
  dispatchInvocation: {
    taskId: string;
    projectRef: string;
    environment: "development";
    supabaseOrigin: string;
    queueConfiguration: "legacy_v1_concurrency_limit_1" | "default";
    declaredTaskConcurrencyLimit?: 1;
  };
  observationPath: string;
  dispatchedAt: string;
  observedAt: string;
  runStatusHistory: RunStatusTransition[];
  failureCategory?: string;
};

export type RoundTripAttempt = {
  schemaVersion: 1;
  status: "prepared";
  taskId: string;
  projectRef: string;
  expectedEnvironment: "development";
  dispatchAttemptId: string;
  localSupabaseOrigin: string;
  queueConfiguration: "legacy_v1_concurrency_limit_1" | "default";
  preparedAt: string;
};

/** Persist the one-run intent before dispatch so a crash cannot lose its correlation identity. */
export async function persistRoundTripAttempt(reportPath: string, attempt: RoundTripAttempt) {
  const directory = path.dirname(reportPath);
  await mkdir(directory, { recursive: true });
  const file = await open(`${reportPath}.attempt.jsonl`, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(attempt)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

export function forwardAcceptedObservation(output: string, write: (line: string) => void) {
  const marker = output.match(/M15_TRIGGER_OBSERVATION=\{[^\r\n]+\}/)?.[0];
  if (marker) write(`${marker}\n`);
  return marker;
}

export function forwardRunStatusObservations(output: string, write: (line: string) => void) {
  const markers = output.match(/^M15_TRIGGER_STATUS=\{[^\r\n]+\}$/gm) ?? [];
  for (const marker of markers) write(`${marker}\n`);
  return markers.length;
}

export async function waitForExactRunMarker<TMarker>(options: {
  timeoutMs: number;
  markerPollIntervalMs?: number;
  statusPollIntervalMs?: number;
  readMarker: () => Promise<TMarker | null>;
  retrieveRun: () => Promise<{
    status: string;
    isCompleted: boolean;
    isFailed: boolean;
    isCancelled: boolean;
  }>;
  onStatus: (transition: RunStatusTransition) => Promise<void>;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
  toIso?: (timestamp: number) => string;
}) {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
  const toIso = options.toIso ?? ((timestamp) => new Date(timestamp).toISOString());
  const deadline = now() + options.timeoutMs;
  const markerPollIntervalMs = options.markerPollIntervalMs ?? 200;
  const statusPollIntervalMs = options.statusPollIntervalMs ?? 2_000;
  let nextStatusCheck = 0;
  let marker: TMarker | null = null;
  let lastRun: Awaited<ReturnType<typeof options.retrieveRun>> | null = null;
  let lastObservedState: string | null = null;
  let statusLookupFailed = false;

  while (now() < deadline) {
    if (!marker) marker = await options.readMarker();

    if (now() >= nextStatusCheck) {
      let run: Awaited<ReturnType<typeof options.retrieveRun>> | null = null;
      try {
        run = await options.retrieveRun();
        lastRun = run;
        statusLookupFailed = false;
      } catch {
        statusLookupFailed = true;
      }
      if (run) {
        const observedState = JSON.stringify({
          status: run.status,
          isCompleted: run.isCompleted,
          isFailed: run.isFailed,
          isCancelled: run.isCancelled,
        });
        if (observedState !== lastObservedState) {
          const transition = {
            status: run.status,
            isCompleted: run.isCompleted,
            isFailed: run.isFailed,
            isCancelled: run.isCancelled,
            observedAt: toIso(now()),
          };
          await options.onStatus(transition);
          lastObservedState = observedState;
        }
        if (run.isFailed || run.isCancelled || (marker && isSuccessfulCompletedRun(run))) {
          return { marker, run, statusLookupFailed, timedOut: false };
        }
      }
      nextStatusCheck = now() + statusPollIntervalMs;
    }

    await sleep(Math.min(markerPollIntervalMs, Math.max(0, deadline - now())));
  }

  return { marker, run: lastRun, statusLookupFailed, timedOut: true };
}

export async function persistRoundTripObservation(
  reportPath: string,
  observation: RoundTripObservation,
) {
  const directory = path.dirname(reportPath);
  await mkdir(directory, { recursive: true });
  const file = await open(reportPath, "a", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(observation)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function runObservedRoundTrip<T>(options: {
  reportPath: string;
  taskId: string;
  projectRef: string;
  supabaseOrigin: string;
  dispatchAttemptId: string;
  queueConfiguration?: "legacy_v1_concurrency_limit_1" | "default";
  dispatch: () => Promise<{ id: string }>;
  wait: (
    runId: string,
    observeRunStatus: (transition: RunStatusTransition) => Promise<void>,
  ) => Promise<T>;
  isComplete: (result: T) => boolean;
  failureCategory: (error: unknown) => string;
  onAccepted?: (observation: RoundTripObservation, persisted: boolean) => void;
  onRunStatus?: (transition: RunStatusTransition, observation: RoundTripObservation) => void;
  cancelAcceptedRun?: (runId: string) => Promise<void>;
  persist?: typeof persistRoundTripObservation;
  now?: () => Date;
}) {
  const persist = options.persist ?? persistRoundTripObservation;
  const now = options.now ?? (() => new Date());
  const handle = await options.dispatch();
  const dispatchedAt = now().toISOString();
  const base: RoundTripObservation = {
    schemaVersion: 1,
    status: "accepted",
    runId: handle.id,
    dispatchAttemptId: options.dispatchAttemptId,
    dispatchInvocation: {
      taskId: options.taskId,
      projectRef: options.projectRef,
      environment: "development",
      supabaseOrigin: options.supabaseOrigin,
      queueConfiguration: options.queueConfiguration ?? "legacy_v1_concurrency_limit_1",
      ...(options.queueConfiguration === "default" ? {} : { declaredTaskConcurrencyLimit: 1 }),
    },
    observationPath: options.reportPath,
    dispatchedAt,
    observedAt: dispatchedAt,
    runStatusHistory: [],
  };

  // Persist the API-returned identity before any polling can block or throw.
  try {
    await persist(options.reportPath, base);
  } catch (error) {
    options.onAccepted?.(base, false);
    await options.cancelAcceptedRun?.(handle.id).catch(() => undefined);
    throw error;
  }
  options.onAccepted?.(base, true);
  let observed = base;
  const observeRunStatus = async (transition: RunStatusTransition) => {
    const previous = observed.runStatusHistory.at(-1);
    if (
      previous?.status === transition.status &&
      previous.isCompleted === transition.isCompleted &&
      previous.isFailed === transition.isFailed &&
      previous.isCancelled === transition.isCancelled
    ) {
      return;
    }
    observed = {
      ...observed,
      observedAt: transition.observedAt,
      runStatusHistory: [...observed.runStatusHistory, transition],
    };
    await persist(options.reportPath, observed);
    options.onRunStatus?.(transition, observed);
  };
  try {
    const result = await options.wait(handle.id, observeRunStatus);
    const completedAt = now().toISOString();
    const complete = options.isComplete(result);
    const completedObservation: RoundTripObservation = {
      ...observed,
      status: complete ? "complete" : "failed",
      observedAt: completedAt,
      ...(!complete ? { failureCategory: "worker_result_incomplete" } : {}),
    };
    await persist(options.reportPath, completedObservation);
    if (!complete) throw new Error("trigger_run_not_completed");
    return { result, observation: completedObservation };
  } catch (error) {
    await persist(options.reportPath, {
      ...observed,
      status: "failed",
      observedAt: now().toISOString(),
      failureCategory: options.failureCategory(error),
    }).catch(() => undefined);
    throw error;
  }
}
