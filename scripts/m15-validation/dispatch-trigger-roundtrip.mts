import { randomUUID } from "node:crypto";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { runs, tasks } from "@trigger.dev/sdk";
import {
  runObservedRoundTrip,
  isSuccessfulCompletedRun,
  persistRoundTripAttempt,
  type RoundTripAttempt,
  TRIGGER_DISPATCH_RETRY_BUDGET_MS,
  TRIGGER_MARKER_POLL_BUDGET_MS,
  waitForExactRunMarker,
} from "./roundtrip-observability.mts";

const correlationId = randomUUID();
const originalTaskId = "m15-local-acceptance-round-trip";
const taskId = originalTaskId;
const queueConfiguration = "legacy_v1_concurrency_limit_1";
const projectRef = "proj_hwqtxtyrvwykjirkrdoh";
const reportPath = path.join(
  process.cwd(),
  "node_modules",
  ".cache",
  "m15-local",
  `trigger-roundtrip-${correlationId}.jsonl`,
);
type RoundTripMarker = {
  correlation_id: string;
  task_id: string;
  run_id: string;
  completed_at: string;
};

function safeTriggerErrorCategory(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/unauthori[sz]ed|forbidden|credential|api key|access token/.test(message)) return "auth";
  if (
    /project.{0,40}(not found|invalid|unauthori[sz]ed)|not authorized.{0,40}project/.test(message)
  ) {
    return "project_access";
  }
  if (/task.{0,40}(not found|unknown|not registered)|unknown task/.test(message)) {
    return "task_not_registered";
  }
  if (/rate.?limit|too many requests/.test(message)) return "rate_limited";
  if (/timeout|timed out/.test(message)) return "timeout";
  return "trigger_request_failed";
}

const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY;
if (!apiUrl || !serviceKey || new URL(apiUrl).port !== "65431") {
  throw new Error("isolated_local_supabase_required");
}
if (!process.env.TRIGGER_SECRET_KEY?.startsWith("tr_dev_sk_")) {
  throw new Error("development_credential_unproven");
}
const client = createClient(apiUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

try {
  const attemptRecordPath = `${reportPath}.attempt.jsonl`;
  const attempt: RoundTripAttempt = {
    schemaVersion: 1,
    status: "prepared",
    taskId,
    projectRef,
    expectedEnvironment: "development",
    dispatchAttemptId: correlationId,
    localSupabaseOrigin: new URL(apiUrl).origin,
    queueConfiguration,
    preparedAt: new Date().toISOString(),
  };
  await persistRoundTripAttempt(reportPath, attempt);
  const triggerDeadline = Date.now() + TRIGGER_DISPATCH_RETRY_BUDGET_MS;
  const { observation, result: completion } = await runObservedRoundTrip({
    reportPath,
    taskId,
    projectRef,
    supabaseOrigin: new URL(apiUrl).origin,
    dispatchAttemptId: correlationId,
    queueConfiguration,
    dispatch: async () => {
      let lastErrorCategory = "trigger_request_failed";
      while (Date.now() < triggerDeadline) {
        try {
          return await tasks.trigger(
            taskId,
            { correlationId },
            { idempotencyKey: `m15-local-roundtrip:${correlationId}`, idempotencyKeyTTL: "10m" },
          );
        } catch (error) {
          lastErrorCategory = safeTriggerErrorCategory(error);
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
      throw new Error(`trigger_dispatch_not_accepted:${lastErrorCategory}`);
    },
    wait: async (runId, observeRunStatus) => {
      try {
        const { marker, run } = await waitForExactRunMarker({
          timeoutMs: TRIGGER_MARKER_POLL_BUDGET_MS,
          readMarker: async () => {
            const { data, error } = await client
              .from("m15_local_trigger_roundtrip")
              .select("correlation_id,task_id,run_id,completed_at")
              .eq("correlation_id", correlationId)
              .maybeSingle();
            if (error) throw new Error("local_round_trip_result_unavailable");
            return data as RoundTripMarker | null;
          },
          retrieveRun: () => runs.retrieve(runId),
          onStatus: observeRunStatus,
        });
        if (
          !marker ||
          marker.task_id !== taskId ||
          marker.correlation_id !== correlationId ||
          marker.run_id !== runId ||
          !run ||
          !isSuccessfulCompletedRun(run)
        ) {
          const statusLabel = run?.status
            ? run.status
                .toLowerCase()
                .replace(/[^a-z0-9_]+/g, "_")
                .slice(0, 48)
            : "unobserved";
          throw new Error(`trigger_worker_persistence_timeout:run_status_${statusLabel}`);
        }
        return { marker, successfulCompletionObserved: true };
      } catch (error) {
        await runs.cancel(runId).catch(() => undefined);
        throw error;
      }
    },
    isComplete: (value) => Boolean(value.marker && value.successfulCompletionObserved),
    failureCategory: (error) => {
      const message = error instanceof Error ? error.message : "";
      if (/trigger_worker_persistence_timeout:run_status_[a-z_]+/.test(message)) {
        return "worker_persistence_timeout";
      }
      return safeTriggerErrorCategory(error);
    },
    onAccepted: (observation, persisted) => {
      process.stdout.write(
        `M15_TRIGGER_OBSERVATION=${JSON.stringify({ ...observation, acceptedReportPersisted: persisted })}\n`,
      );
    },
    onRunStatus: (transition, observation) => {
      process.stdout.write(
        `M15_TRIGGER_STATUS=${JSON.stringify({
          runId: observation.runId,
          dispatchAttemptId: observation.dispatchAttemptId,
          status: transition.status,
          isCompleted: transition.isCompleted,
          isFailed: transition.isFailed,
          isCancelled: transition.isCancelled,
          observedAt: transition.observedAt,
        })}\n`,
      );
    },
    cancelAcceptedRun: async (runId) => {
      await runs.cancel(runId);
    },
  });
  process.stdout.write(
    JSON.stringify({
      status: "complete",
      runId: observation.runId,
      dispatchAttemptId: observation.dispatchAttemptId,
      dispatchInvocation: observation.dispatchInvocation,
      runStatusHistory: observation.runStatusHistory,
      dispatchedAt: observation.dispatchedAt,
      observationPath: observation.observationPath,
      attemptRecordPath,
      localCompletionMarker: completion.marker,
      persistence: "isolated-local-supabase",
    }) + "\n",
  );
} catch (error) {
  const code =
    error instanceof Error && /^[a-z0-9_:]+$/.test(error.message)
      ? error.message
      : "local_trigger_round_trip_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
