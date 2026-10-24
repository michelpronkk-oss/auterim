import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateProductionHealth,
  evaluationWindowMinutes,
  SCHEDULED_TASK_CADENCE_MINUTES,
  type ObservedRun,
} from "@/lib/ops/production-health";

const now = new Date("2026-10-24T04:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

/** A healthy hour: every task has completed runs at its cadence inside its window. */
function healthyRuns(): ObservedRun[] {
  const runs: ObservedRun[] = [];
  for (const [taskIdentifier, cadence] of Object.entries(SCHEDULED_TASK_CADENCE_MINUTES)) {
    const window = evaluationWindowMinutes(cadence);
    for (let age = 1; age < window; age += cadence)
      runs.push({ taskIdentifier, status: "COMPLETED", createdAt: minutesAgo(age) });
  }
  return runs;
}

describe("production health evaluation", () => {
  it("is healthy only with reachable Supabase and recent successful runs for every task", () => {
    const verdict = evaluateProductionHealth({ now, supabaseReachable: true, runs: healthyRuns() });
    expect(verdict.findings).toEqual([]);
    expect(verdict.healthy).toBe(true);
    expect(verdict.tasks).toHaveLength(Object.keys(SCHEDULED_TASK_CADENCE_MINUTES).length);
  });

  it("fails closed when Supabase is unreachable or run evidence is unreadable", () => {
    expect(
      evaluateProductionHealth({
        now,
        supabaseReachable: false,
        supabaseDetail: "client_error",
        runs: healthyRuns(),
      }).findings,
    ).toEqual([{ check: "supabase", category: "supabase_unreachable", detail: "client_error" }]);
    const unreadable = evaluateProductionHealth({ now, supabaseReachable: true, runs: null });
    expect(unreadable.healthy).toBe(false);
    expect(unreadable.findings).toEqual([
      { check: "trigger_runs", category: "run_evidence_unavailable" },
    ]);
  });

  it("treats a dispatcher with no runs in its window as missing evidence, not healthy", () => {
    const runs = healthyRuns().filter((run) => run.taskIdentifier !== "dispatch-preflight-queue");
    const verdict = evaluateProductionHealth({ now, supabaseReachable: true, runs });
    expect(verdict.findings).toEqual([
      { check: "dispatch-preflight-queue", category: "missing_run_evidence" },
    ]);
    const stale = healthyRuns().map((run) =>
      run.taskIdentifier === "dispatch-source-scans"
        ? { ...run, createdAt: minutesAgo(27 * 60) }
        : run,
    );
    expect(
      evaluateProductionHealth({ now, supabaseReachable: true, runs: stale }).findings,
    ).toEqual([{ check: "dispatch-source-scans", category: "missing_run_evidence" }]);
  });

  it("detects the 21 Oct outage pattern: dispatchers failing every run", () => {
    const runs = healthyRuns().map((run) =>
      run.taskIdentifier.startsWith("dispatch-remediation") ? { ...run, status: "FAILED" } : run,
    );
    const verdict = evaluateProductionHealth({ now, supabaseReachable: false, runs });
    expect(verdict.healthy).toBe(false);
    expect(verdict.findings.map((finding) => `${finding.check}:${finding.category}`)).toEqual([
      "supabase:supabase_unreachable",
      "dispatch-remediation-preparation:no_recent_success",
      "dispatch-remediation-validation:no_recent_success",
    ]);
  });

  it("flags a failure rate above half of terminal runs, and tolerates isolated failures", () => {
    const runs = healthyRuns().map((run, index) =>
      run.taskIdentifier === "dispatch-fix-engine-stages" && index % 4 !== 0
        ? { ...run, status: "FAILED" }
        : run,
    );
    const verdict = evaluateProductionHealth({ now, supabaseReachable: true, runs });
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]).toMatchObject({
      check: "dispatch-fix-engine-stages",
      category: "failure_rate_exceeded",
    });

    const oneFailure = healthyRuns();
    const target = oneFailure.findIndex(
      (run) => run.taskIdentifier === "dispatch-business-handoff",
    );
    oneFailure[target] = { ...oneFailure[target]!, status: "CRASHED" };
    expect(
      evaluateProductionHealth({ now, supabaseReachable: true, runs: oneFailure }).healthy,
    ).toBe(true);
  });

  it("does not count in-progress runs as failures", () => {
    const runs = healthyRuns();
    runs.push({ taskIdentifier: "dispatch-preflight-queue", status: "EXECUTING", createdAt: now });
    const verdict = evaluateProductionHealth({ now, supabaseReachable: true, runs });
    expect(verdict.healthy).toBe(true);
    expect(verdict.tasks.find((task) => task.taskId === "dispatch-preflight-queue")).toMatchObject({
      inProgress: 1,
      unsuccessful: 0,
    });
  });

  it("covers exactly the scheduled tasks defined in src/trigger with their cron cadence", () => {
    const directory = fileURLToPath(new URL("../src/trigger/", import.meta.url));
    const scheduled: Record<string, number> = {};
    for (const name of readdirSync(directory).filter((file) => file.endsWith(".ts"))) {
      const source = readFileSync(`${directory}${name}`, "utf8");
      if (!source.includes("schedules.task(")) continue;
      const id = /id:\s*"([^"]+)"/.exec(source)?.[1];
      const pattern = /pattern:\s*"([^"]+)"/.exec(source)?.[1];
      if (!id || !pattern || id === "monitor-production-health") continue;
      const [minute, hour] = pattern.split(" ");
      scheduled[id] = minute!.startsWith("*/")
        ? Number(minute!.slice(2))
        : hour === "*"
          ? 60
          : 24 * 60;
    }
    expect(scheduled).toEqual(SCHEDULED_TASK_CADENCE_MINUTES);
  });
});
