/**
 * Deterministic Production health evaluation. Pure functions only; the Trigger task
 * gathers evidence and throws when the verdict is not healthy, so Trigger's run-failure
 * alerts deliver the notification. Missing or unreadable evidence is never healthy.
 */

/** Every scheduled task in src/trigger with its cron cadence in minutes. */
export const SCHEDULED_TASK_CADENCE_MINUTES = {
  "dispatch-fix-engine-stages": 1,
  "dispatch-business-handoff": 2,
  "dispatch-remediation-preparation": 2,
  "dispatch-remediation-validation": 2,
  "dispatch-preflight-queue": 5,
  "dispatch-customer-impact-queue": 15,
  "dispatch-growth-opportunities": 15,
  "dispatch-protection-notifications": 15,
  "dispatch-source-scans": 24 * 60,
  "purge-fix-engine-artifacts": 24 * 60,
} as const satisfies Record<string, number>;

export type ScheduledTaskId = keyof typeof SCHEDULED_TASK_CADENCE_MINUTES;

export type ObservedRun = {
  taskIdentifier: string;
  status: string;
  createdAt: Date;
};

export type HealthFinding = {
  check: "supabase" | "trigger_runs" | ScheduledTaskId;
  category:
    | "supabase_unreachable"
    | "run_evidence_unavailable"
    | "missing_run_evidence"
    | "no_recent_success"
    | "failure_rate_exceeded";
  detail?: string;
};

export type HealthVerdict = {
  healthy: boolean;
  findings: HealthFinding[];
  tasks: Array<{
    taskId: ScheduledTaskId;
    windowMinutes: number;
    completed: number;
    unsuccessful: number;
    inProgress: number;
  }>;
};

const IN_PROGRESS = new Set([
  "PENDING_VERSION",
  "QUEUED",
  "DEQUEUED",
  "EXECUTING",
  "WAITING",
  "DELAYED",
]);

/** Failure-rate threshold over terminal runs, applied only with enough evidence. */
export const FAILURE_RATE_THRESHOLD = 0.5;
export const FAILURE_RATE_MIN_TERMINAL_RUNS = 3;

/** Window long enough to expect several runs, and at least an hour; daily tasks get 26h. */
export function evaluationWindowMinutes(cadenceMinutes: number) {
  if (cadenceMinutes >= 24 * 60) return 26 * 60;
  return Math.max(60, cadenceMinutes * 4);
}

export function evaluateProductionHealth(input: {
  now: Date;
  supabaseReachable: boolean;
  supabaseDetail?: string;
  /** null when the runs API could not be read. */
  runs: ObservedRun[] | null;
}): HealthVerdict {
  const findings: HealthFinding[] = [];
  const tasks: HealthVerdict["tasks"] = [];
  if (!input.supabaseReachable)
    findings.push({
      check: "supabase",
      category: "supabase_unreachable",
      detail: input.supabaseDetail,
    });
  if (input.runs === null) {
    findings.push({ check: "trigger_runs", category: "run_evidence_unavailable" });
    return { healthy: false, findings, tasks };
  }

  for (const [taskId, cadence] of Object.entries(SCHEDULED_TASK_CADENCE_MINUTES) as Array<
    [ScheduledTaskId, number]
  >) {
    const windowMinutes = evaluationWindowMinutes(cadence);
    const since = input.now.getTime() - windowMinutes * 60_000;
    const inWindow = input.runs.filter(
      (run) => run.taskIdentifier === taskId && run.createdAt.getTime() >= since,
    );
    const completed = inWindow.filter((run) => run.status === "COMPLETED").length;
    const inProgress = inWindow.filter((run) => IN_PROGRESS.has(run.status)).length;
    const unsuccessful = inWindow.length - completed - inProgress;
    tasks.push({ taskId, windowMinutes, completed, unsuccessful, inProgress });

    if (inWindow.length === 0) {
      findings.push({ check: taskId, category: "missing_run_evidence" });
      continue;
    }
    if (completed === 0) {
      findings.push({ check: taskId, category: "no_recent_success" });
      continue;
    }
    const terminal = completed + unsuccessful;
    if (
      terminal >= FAILURE_RATE_MIN_TERMINAL_RUNS &&
      unsuccessful / terminal > FAILURE_RATE_THRESHOLD
    )
      findings.push({
        check: taskId,
        category: "failure_rate_exceeded",
        detail: `${unsuccessful}/${terminal}`,
      });
  }
  return { healthy: findings.length === 0, findings, tasks };
}

/** Longest evaluation window, used to bound the runs query. */
export function maxEvaluationWindowMinutes() {
  return Math.max(...Object.values(SCHEDULED_TASK_CADENCE_MINUTES).map(evaluationWindowMinutes));
}
