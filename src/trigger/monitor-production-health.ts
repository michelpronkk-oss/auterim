import { runs, schedules } from "@trigger.dev/sdk";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  evaluateProductionHealth,
  evaluationWindowMinutes,
  SCHEDULED_TASK_CADENCE_MINUTES,
  type ObservedRun,
} from "@/lib/ops/production-health";

const MAX_RUNS_PER_TASK = 200;

async function probeSupabase() {
  try {
    const { error } = await createSupabaseServerClient()
      .from("workspaces")
      .select("id", { head: true })
      .limit(1);
    return error
      ? { reachable: false, detail: error.code || "request_failed" }
      : { reachable: true };
  } catch {
    return { reachable: false, detail: "client_error" };
  }
}

async function collectRuns(now: Date): Promise<ObservedRun[] | null> {
  try {
    const observed: ObservedRun[] = [];
    for (const [taskId, cadence] of Object.entries(SCHEDULED_TASK_CADENCE_MINUTES)) {
      const from = new Date(now.getTime() - evaluationWindowMinutes(cadence) * 60_000);
      let count = 0;
      for await (const run of runs.list({ taskIdentifier: [taskId], from, limit: 100 })) {
        observed.push({
          taskIdentifier: run.taskIdentifier,
          status: run.status,
          createdAt: run.createdAt,
        });
        if (++count >= MAX_RUNS_PER_TASK) break;
      }
    }
    return observed;
  } catch {
    return null;
  }
}

/**
 * Production health check. Throws when Supabase is unreachable, run evidence is missing or
 * unreadable, or a scheduled dispatcher has no recent success or a high failure rate, so the
 * failed run triggers the environment's run-failure alert. Reads only; changes nothing.
 */
export const monitorProductionHealthTask = schedules.task({
  id: "monitor-production-health",
  cron: { pattern: "*/15 * * * *", timezone: "UTC" },
  maxDuration: 120,
  retry: { maxAttempts: 1 },
  queue: { concurrencyLimit: 1 },
  run: async () => {
    const now = new Date();
    const [supabase, observedRuns] = await Promise.all([probeSupabase(), collectRuns(now)]);
    const verdict = evaluateProductionHealth({
      now,
      supabaseReachable: supabase.reachable,
      supabaseDetail: supabase.detail,
      runs: observedRuns,
    });
    console.log("production_health", JSON.stringify(verdict));
    if (!verdict.healthy)
      throw new Error(
        `production_health_unhealthy:${verdict.findings
          .map((finding) => `${finding.check}:${finding.category}`)
          .join(",")}`,
      );
    return verdict;
  },
});
