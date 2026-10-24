# Production monitoring

Two independent, low-cost checks. Both fail closed: missing or unreadable evidence is
reported as unhealthy, never as healthy.

## 1. `monitor-production-health` (Trigger.dev, every 15 minutes)

`src/trigger/monitor-production-health.ts` with the pure evaluator in
`src/lib/ops/production-health.ts`. Read-only. Each run:

- reads one row header from `public.workspaces` with the server client
  (Supabase reachability, including credentials and database);
- lists recent runs of every scheduled task (`SCHEDULED_TASK_CADENCE_MINUTES`; a test
  keeps it in sync with `src/trigger`) over a window of at least four cadences or one
  hour, 26 hours for daily tasks;
- **throws** when Supabase is unreachable, run evidence cannot be read, a task has no
  runs in its window, a task has no successful run in its window, or more than half of
  at least three terminal runs failed.

The failed run is the alert. **Operator setup (once):** Trigger.dev dashboard →
project `proj_hwqtxtyrvwykjirkrdoh` → Alerts → add an email (or Slack/webhook) alert for
**task run failures** in the **Production** environment. Without that alert channel the
check still runs, but nobody is notified.

This check cannot report an outage of Trigger.dev itself.

## 2. `Production health probe` (GitHub Actions, every 15 minutes)

`.github/workflows/production-health-probe.yml` runs
`scripts/supabase-health-probe.mjs`, independent of Trigger.dev and of any secret. It
requires DNS resolution of the project host and HTTP 200 from `/auth/v1/health` with the
public publishable key. A paused project (no DNS), gateway errors, timeouts, a rejected
publishable key (`401 invalid_api_key`, which also breaks browser clients) and missing
configuration all fail the run; GitHub then emails the workflow's owner.

**Operator setup (once):** repository Settings → Secrets and variables → Actions →
Variables → add a **repository** variable `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (a public
value; environment-scoped variables are not visible to this job). Scheduled workflows in
public repositories are disabled after 60 days without repository activity.

## Acceptance record (24 Oct 2026)

Status: **accepted**. Both checks are live in Production and reported healthy.

| Check                  | Evidence                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source                 | `main` at `85042558223340c6f0f070b5fc824df2dd3a4b57` (merge of #134)                                                                                                                                                      |
| GitHub probe           | Run `40068621123` (manual, `main`): HTTP 200 from `/auth/v1/health`, workflow succeeded. The earlier run `40068047478` failed with `401 invalid_api_key` on the previous key, before the repository variable was replaced |
| Trigger.dev deployment | `pq3gaz2z`, worker `20261024.2` (`worker_cmvm0aq3d0h8u0vmzd9bzvg0y`), replacing `20261024.1`; the only task change was adding `monitor-production-health`                                                                 |
| Schedule               | `sched_oiyqum1hvn1n1r3a1ttnc`, declarative, `*/15 * * * *` UTC, Production only                                                                                                                                           |
| First scheduled run    | `run_06gmp7c787sjsqjak5oie0i3a2`: scheduled 06:30:00, finished 06:34:18 UTC; `healthy: true`, no findings; all ten dispatchers had successful runs and no failures in their windows                                       |
| Queues                 | Unchanged by the deployment: `process-fix-engine-stage` and `recover-internal-fix-verification-after-cache-repair` stayed paused; the only new queue is `monitor-production-health` (concurrency 1)                       |
| Historical run         | `run_06glcb88fo2melb0m37u0ghn01` (`attest-verification-runner-identity`) stayed `PENDING_VERSION`                                                                                                                         |
| Alerting               | Trigger.dev email alert for task run failure, deployment failure and deployment success in Production (configured by the operator)                                                                                        |

Known and accepted:

- The deployment applied Trigger.dev's default 60-minute cron window to the schedule, so each run starts
  at a stable offset after its quarter-hour (about 4 minutes for the first run). This timing is
  accepted; the schedule is unchanged.
- GitHub prints Actions variables unmasked, so the (public) publishable key appears in the probe's
  job log. Moving it to a repository secret would mask it.
