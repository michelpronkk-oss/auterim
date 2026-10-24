# M15.79 Step 4b: current Production analysis (development only)

## Status and boundary

Step 4a is applied in Production: run `40133256390`, main
`9b020b20d50c5671c25e71f2e0f764086a3097dc`, 88 migrations, latest
`20261228000000`. Step 4b adds no migration and does not change the approved
Step 4a SQL (SHA-256
`e761b0d8e22acffd92bb1a5dcb44cb050679791a4cd392e7381b1d2799d55cef`).

This implementation is dormant. There is no schedule, API route, post-sync hook,
queue consumer or other caller. The task rejects every environment except
`DEVELOPMENT` **before creating a privileged client**, and additionally requires
`AUTERIM_M15_LOCAL_INTEGRATION=1`. The existing server-client factory then enforces
the loopback Supabase binding and dedicated local credentials; development cannot
silently fall back to the remote Production database. Nothing was deployed or
triggered as part of this work. Any provider-backed acceptance execution needs
separate approval.

**Issuance is disabled in code**, without a payload or environment switch. The
coordinator returns an internal preview and the arguments for the existing
`issue_impact_exposure_assessment` RPC. It makes no issuance call and has no direct
assessment-table write path. A preview is not a persisted assessment or a
customer-facing protection claim. Certificates and Fix Runs are untouched.

## Exact identity and execution

The strict request contains only workspace, Product, repository, surface and seed
graph-build UUIDs. A caller cannot supply a commit, deployment ID, classification
or issuance flag. The seed graph authorizes the existing source-change route in
that same workspace, Product and repository; historical seed rows are context,
never evidence that their commit is deployed.

1. Exact scoped database reads require a protected Product, active repository
   mapping, Product/repository/surface link, available unarchived repository,
   connected GitHub installation and selected available Vercel project. Each new
   database query has a 15-second abort signal. Read errors fail closed.
2. Require the latest attempt to have succeeded, no running sync, and the latest
   finished sync to be successful and less than 24 hours old (not future-dated).
3. Use the existing Vercel credentials/configuration and bounded deployment adapter.
   Step 4b requires a complete alias read: no missing alias result, contradictory
   target, malformed verified domain, more than ten verified domains or truncated
   100-domain page. Unreadable or unlisted current targets are not proof.
4. Require exactly one live observation of the current alias target, ready and
   Production, with exact GitHub owner/repository and SHA. Require stored surface,
   observation and `production_verified` evidence to match that same deployment,
   tenant, Product, repository and commit. Missing baseline/preflight verification
   remains unknown; analysis never promotes a deployment evidence row itself.
5. Reuse `analyze-protected-repository-code` at that deployed SHA. Existing GitHub
   App authorization, exact archive materialization, file/byte/fact limits,
   symlink exclusion, analyzer watchdog, leases and durable idempotent claims apply.
6. Await the existing graph builder and read back only the graph matching the exact
   analysis run, route, workspace, Product, repository and commit. Its source-change
   contract is preserved. Existing graph/handoff rows are not rewritten.
7. Repeat authorization and the live Production read. Any deployment ID change
   (even at the same SHA), commit, observation, evidence, route or sync change
   invalidates the attempt. Return unknown on revoked authorization or deployment
   drift. Provider/read errors produce a bounded failed attempt, never a definite
   exposure result.
8. Apply the existing `exposureForSurface` classifier. A completed positive graph
   can prove exposure; disproven requires a complete negative graph under
   `javascript-typescript-v2.3`. Incomplete/failed graphs remain unknown.

Live binding reads must be no more than two minutes old. Results older than the
ten-minute orchestration wall-time budget are discarded. No claim means that
Production cannot change after the final observation: the preview is an as-observed
result, not a continuously valid statement.

## Idempotency, concurrency and retries

The orchestration key hashes workspace, Product, repository, surface, route,
provider deployment ID and deployed commit. Exact-commit analysis is reused by its
existing database key; graph uniqueness includes the exact analysis and route.
Durable child keys use global scope with a one-hour TTL, so restarting the parent
does not fan out duplicate child runs. There is one analysis and one explicit graph
wait per attempt, no tenant/source/surface enumeration. The analyzer's existing
graph handoff may race the explicit graph wait: database claims serialize these,
and a busy graph causes a bounded retry, never a second definite assertion.

The task permits two concurrent parent executions and at most three attempts,
with 5–30 second backoff and a 600-second execution cap. Child task retries and
database attempt ceilings remain in force. No internal retry loop or production
queue change is introduced. Each attempt re-resolves current Production before
reusing child evidence. Failed/ambiguous outcomes cannot issue anything.

## Regression and acceptance coverage

- Coordinator: deployed-SHA selection; stable and scope-sensitive keys; complete
  positive/negative and incomplete classifications; cross-tenant identity errors;
  stale/future/malformed evidence; deployment/same-SHA-redeploy/sync/evidence races;
  revocation; failures, retries, wall budget and rejected issuance switches.
- Repository: tenant/Product/repository/surface/analysis/route query scoping;
  current ready Production only; selected resource revocation; no running sync;
  failed/stale/future sync; preview/historical/orphaned/duplicate targets;
  mismatched commits; sanitized database errors; Postgres offset timestamps.
- Provider: complete, missing, conflicting, malformed and truncated alias sets.
- Task: Production/staging/unknown environments fail before any client or child;
  exact child payloads, global idempotency and Result failure handling.
- Existing database suites retain Step 4a SQL/TypeScript classification equivalence,
  direct-insert NULL regressions, service-role RPC permissions, tenant RLS,
  cross-workspace FK rejection and append-only/idempotent assessment tests.

## Separate approval gates and remaining limits

This draft needs review and four green required CI checks before merge approval.
Merging does not authorize worker deployment, task execution, issuance or claims.
Before any future activation, review concurrency/cost limits and authorize a
specific isolated acceptance target and credential environment.

Persistence needs a separate reviewed change and explicit authorization. It must
call only the Step 4a service-role issuer, re-resolve the live binding at issuance,
and address the final read-to-issuance race (including concurrent surface/sync
updates and an external deployment changing after the live read). Do not simply
send a previously prepared preview's arguments later. The current RPC recomputes
the outcome and verifies cited evidence/sync IDs, but this does not make an
external-provider read atomic with a database transaction.

Live authenticated tenant-isolation acceptance, deletion/retention, stale
publishable keys, npm audit vulnerabilities, hosting readiness, branch protection
and billing acceptance remain launch blockers. None is resolved by this PR.
