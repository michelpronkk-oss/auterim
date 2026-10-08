import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  forwardAcceptedObservation,
  isSuccessfulCompletedRun,
  persistRoundTripObservation,
  runObservedRoundTrip,
  TRIGGER_AUTH_PROBE_BUDGET_MS,
  TRIGGER_DEV_ROUNDTRIP_PROCESS_MARGIN_MS,
  TRIGGER_DEV_ROUNDTRIP_PROCESS_TIMEOUT_MS,
  TRIGGER_DISPATCH_RETRY_BUDGET_MS,
  TRIGGER_MARKER_POLL_BUDGET_MS,
  TRIGGER_WORKER_READINESS_BUDGET_MS,
  TRIGGER_WRAPPER_CLEANUP_MARGIN_MS,
  TRIGGER_WRAPPER_DISPATCH_TIMEOUT_MS,
  forwardRunStatusObservations,
  waitForExactRunMarker,
  type RoundTripObservation,
} from "../scripts/m15-validation/roundtrip-observability.mts";

const reportDirectories: string[] = [];

async function reportPath() {
  const cacheDirectory = path.join(process.cwd(), "node_modules", ".cache");
  await mkdir(cacheDirectory, { recursive: true });
  const directory = await mkdtemp(path.join(cacheDirectory, "m15-roundtrip-test-"));
  reportDirectories.push(directory);
  return path.join(directory, "trigger-roundtrip.jsonl");
}

async function readReport(location: string) {
  const snapshots = (await readFile(location, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as RoundTripObservation);
  return snapshots.at(-1)!;
}

afterEach(async () => {
  await Promise.all(
    reportDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("M15 Trigger round-trip observability", () => {
  it("keeps the wrapper timeout above dispatch, polling, and cleanup budgets", () => {
    expect(TRIGGER_WRAPPER_DISPATCH_TIMEOUT_MS).toBeGreaterThanOrEqual(
      TRIGGER_DISPATCH_RETRY_BUDGET_MS +
        TRIGGER_MARKER_POLL_BUDGET_MS +
        TRIGGER_WRAPPER_CLEANUP_MARGIN_MS,
    );
    expect(TRIGGER_WRAPPER_DISPATCH_TIMEOUT_MS).toBe(300_000);
    expect(TRIGGER_DEV_ROUNDTRIP_PROCESS_TIMEOUT_MS).toBeGreaterThanOrEqual(
      TRIGGER_AUTH_PROBE_BUDGET_MS +
        TRIGGER_WORKER_READINESS_BUDGET_MS +
        TRIGGER_WRAPPER_DISPATCH_TIMEOUT_MS +
        TRIGGER_DEV_ROUNDTRIP_PROCESS_MARGIN_MS,
    );
    expect(TRIGGER_DEV_ROUNDTRIP_PROCESS_TIMEOUT_MS).toBe(540_000);
  });

  it("forwards the accepted observation and report path after outer timeout termination", () => {
    const observation = {
      taskId: "m15-local-acceptance-round-trip",
      runId: "run-timeout-proof",
      projectRef: "proj_hwqtxtyrvwykjirkrdoh",
      environment: "development",
      observationPath:
        "C:/Users/miche/Desktop/Auterim/node_modules/.cache/m15-local/trigger-roundtrip-test.json",
    };
    const marker = `M15_TRIGGER_OBSERVATION=${JSON.stringify(observation)}`;
    const forwarded: string[] = [];

    expect(
      forwardAcceptedObservation(`${marker}\ntrigger timeout`, (line) => forwarded.push(line)),
    ).toBe(marker);
    expect(forwarded).toEqual([`${marker}\n`]);
    expect(JSON.parse(forwarded[0]!.slice("M15_TRIGGER_OBSERVATION=".length))).toMatchObject({
      runId: "run-timeout-proof",
      observationPath: observation.observationPath,
    });
    const statusLine = `M15_TRIGGER_STATUS=${JSON.stringify({
      runId: "run-timeout-proof",
      dispatchAttemptId: "a4d2b668-5a17-4f03-a7e4-37d145438a08",
      status: "EXECUTING",
      isCompleted: false,
      isFailed: false,
      isCancelled: false,
      observedAt: "2026-10-06T12:00:01.000Z",
    })}`;
    const forwardedStatuses: string[] = [];
    expect(
      forwardRunStatusObservations(`${statusLine}\nother output`, (line) =>
        forwardedStatuses.push(line),
      ),
    ).toBe(1);
    expect(forwardedStatuses).toEqual([`${statusLine}\n`]);
  });

  it("waits for exact-run COMPLETED even when the database marker is already present", async () => {
    let clock = 0;
    let retrieveCount = 0;
    const transitions: string[] = [];
    const snapshots = [
      { status: "EXECUTING", isCompleted: false, isFailed: false, isCancelled: false },
      { status: "COMPLETED", isCompleted: true, isFailed: false, isCancelled: false },
    ];
    const result = await waitForExactRunMarker({
      timeoutMs: 30,
      markerPollIntervalMs: 1,
      statusPollIntervalMs: 2,
      readMarker: async () => ({ runId: "exact-run-1" }),
      retrieveRun: async () => snapshots[Math.min(retrieveCount++, snapshots.length - 1)]!,
      onStatus: async ({ status }) => {
        transitions.push(status);
      },
      now: () => clock,
      sleep: async (durationMs) => {
        clock += durationMs;
      },
      toIso: (timestamp) => new Date(timestamp).toISOString(),
    });

    expect(result.timedOut).toBe(false);
    expect(result.marker).toEqual({ runId: "exact-run-1" });
    expect(result.run?.isCompleted).toBe(true);
    expect(isSuccessfulCompletedRun(snapshots[1]!)).toBe(true);
    expect(transitions).toEqual(["EXECUTING", "COMPLETED"]);
    expect(retrieveCount).toBe(2);
  });

  it.each([
    { status: "CANCELED", isCompleted: true, isFailed: true, isCancelled: true },
    { status: "FAILED", isCompleted: true, isFailed: true, isCancelled: false },
  ])("rejects terminal $status as successful completion", async (runState) => {
    const result = await waitForExactRunMarker({
      timeoutMs: 10,
      readMarker: async () => ({ runId: "exact-terminal-run" }),
      retrieveRun: async () => runState,
      onStatus: async () => {},
      now: () => 0,
      toIso: () => "2026-10-06T12:00:00.000Z",
      sleep: async () => {},
    });

    expect(result.timedOut).toBe(false);
    expect(result.run).toEqual(runState);
    expect(isSuccessfulCompletedRun(runState)).toBe(false);
  });

  it("durably records the accepted run before polling begins", async () => {
    const location = await reportPath();
    const order: string[] = [];
    const result = await runObservedRoundTrip({
      reportPath: location,
      taskId: "m15-local-acceptance-round-trip",
      projectRef: "proj_hwqtxtyrvwykjirkrdoh",
      supabaseOrigin: "http://127.0.0.1:65431",
      dispatchAttemptId: "11111111-1111-4111-8111-111111111111",
      dispatch: async () => ({ id: "run-observability-test" }),
      wait: async (runId, observeRunStatus) => {
        order.push("wait");
        const persisted = await readReport(location);
        expect(persisted).toMatchObject({
          status: "accepted",
          runId,
          dispatchAttemptId: "11111111-1111-4111-8111-111111111111",
          dispatchInvocation: {
            taskId: "m15-local-acceptance-round-trip",
            projectRef: "proj_hwqtxtyrvwykjirkrdoh",
            environment: "development",
            supabaseOrigin: "http://127.0.0.1:65431",
            declaredTaskConcurrencyLimit: 1,
          },
        });
        await observeRunStatus({
          status: "COMPLETED",
          isCompleted: true,
          isFailed: false,
          isCancelled: false,
          observedAt: "2026-10-06T12:00:01.000Z",
        });
        order.push("accepted-record-readable");
        return { runCompleted: true };
      },
      isComplete: (value) => value.runCompleted,
      failureCategory: () => "unexpected_failure",
      onAccepted: (observation, persisted) => {
        expect(observation.runId).toBe("run-observability-test");
        expect(observation.observationPath).toBe(location);
        expect(persisted).toBe(true);
        order.push("accepted-identity-emitted");
      },
      onRunStatus: (transition) => order.push(`status:${transition.status}`),
      persist: async (path, observation) => {
        order.push(`persist:${observation.status}`);
        await persistRoundTripObservation(path, observation);
      },
      now: () => new Date("2026-10-06T12:00:00.000Z"),
    });

    expect(result.observation.runId).toBe("run-observability-test");
    expect(order).toEqual([
      "persist:accepted",
      "accepted-identity-emitted",
      "wait",
      "persist:accepted",
      "status:COMPLETED",
      "accepted-record-readable",
      "persist:complete",
    ]);
    await expect(readReport(location)).resolves.toMatchObject({
      status: "complete",
      runStatusHistory: [
        {
          status: "COMPLETED",
          isCompleted: true,
          isFailed: false,
          isCancelled: false,
          observedAt: "2026-10-06T12:00:01.000Z",
        },
      ],
    });
  });

  it("retains the accepted identity when polling throws and the process reports failure", async () => {
    const location = await reportPath();
    await expect(
      runObservedRoundTrip({
        reportPath: location,
        taskId: "m15-local-acceptance-round-trip",
        projectRef: "proj_hwqtxtyrvwykjirkrdoh",
        supabaseOrigin: "http://127.0.0.1:65431",
        dispatchAttemptId: "22222222-2222-4222-8222-222222222222",
        dispatch: async () => ({ id: "run-that-times-out" }),
        wait: async (runId, observeRunStatus) => {
          expect(await readReport(location)).toMatchObject({ status: "accepted", runId });
          let clock = Date.parse("2026-10-06T12:01:00.000Z");
          let statusIndex = 0;
          const statuses = ["QUEUED", "EXECUTING"];
          const waitResult = await waitForExactRunMarker({
            timeoutMs: 5,
            markerPollIntervalMs: 1,
            statusPollIntervalMs: 2,
            readMarker: async () => ({ correlation_id: "22222222-2222-4222-8222-222222222222" }),
            retrieveRun: async () => {
              const status = statuses[Math.min(statusIndex++, statuses.length - 1)]!;
              return {
                status,
                isCompleted: false,
                isFailed: false,
                isCancelled: false,
              };
            },
            onStatus: observeRunStatus,
            now: () => clock,
            sleep: async (durationMs) => {
              clock += durationMs;
            },
            toIso: (timestamp) => new Date(timestamp).toISOString(),
          });
          expect(waitResult.timedOut).toBe(true);
          throw new Error("trigger_worker_persistence_timeout:run_status_executing");
        },
        isComplete: () => false,
        failureCategory: () => "worker_persistence_timeout",
      }),
    ).rejects.toThrow("trigger_worker_persistence_timeout:run_status_executing");

    await expect(readReport(location)).resolves.toMatchObject({
      status: "failed",
      runId: "run-that-times-out",
      dispatchInvocation: {
        taskId: "m15-local-acceptance-round-trip",
        projectRef: "proj_hwqtxtyrvwykjirkrdoh",
      },
      dispatchAttemptId: "22222222-2222-4222-8222-222222222222",
      runStatusHistory: [
        {
          status: "QUEUED",
          isCompleted: false,
          isFailed: false,
          isCancelled: false,
          observedAt: "2026-10-06T12:01:00.000Z",
        },
        {
          status: "EXECUTING",
          isCompleted: false,
          isFailed: false,
          isCancelled: false,
          observedAt: "2026-10-06T12:01:00.002Z",
        },
      ],
      failureCategory: "worker_persistence_timeout",
    });
  });

  it("does not begin polling when accepted-run persistence fails", async () => {
    let waited = false;
    let emittedIdentity: RoundTripObservation | undefined;
    let emittedPersistedFlag: boolean | undefined;
    const cancelledRunIds: string[] = [];
    await expect(
      runObservedRoundTrip({
        reportPath: "unused",
        taskId: "m15-local-acceptance-round-trip",
        projectRef: "proj_hwqtxtyrvwykjirkrdoh",
        supabaseOrigin: "http://127.0.0.1:65431",
        dispatchAttemptId: "33333333-3333-4333-8333-333333333333",
        dispatch: async () => ({ id: "run-persist-fails" }),
        wait: async () => {
          waited = true;
          return {};
        },
        isComplete: () => false,
        failureCategory: () => "unexpected_failure",
        onAccepted: (observation, persisted) => {
          emittedIdentity = observation;
          emittedPersistedFlag = persisted;
        },
        cancelAcceptedRun: async (runId) => {
          cancelledRunIds.push(runId);
        },
        persist: async () => {
          throw new Error("disk_unavailable");
        },
      }),
    ).rejects.toThrow("disk_unavailable");
    expect(waited).toBe(false);
    expect(emittedIdentity).toMatchObject({
      runId: "run-persist-fails",
      dispatchAttemptId: "33333333-3333-4333-8333-333333333333",
      dispatchInvocation: {
        taskId: "m15-local-acceptance-round-trip",
        projectRef: "proj_hwqtxtyrvwykjirkrdoh",
        environment: "development",
      },
    });
    expect(emittedPersistedFlag).toBe(false);
    expect(cancelledRunIds).toEqual(["run-persist-fails"]);
  });
});
