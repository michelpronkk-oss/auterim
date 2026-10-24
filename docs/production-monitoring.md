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
