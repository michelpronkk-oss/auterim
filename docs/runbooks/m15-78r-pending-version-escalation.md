# M15.78R attestation run parked in PENDING_VERSION

Read-only investigation record for `run_06glcb88fo2melb0m37u0ghn01`
(task `attest-verification-runner-identity`, deployment `3me5292r`, worker
`20261019.7`, SDK `4.7.2`, source `5c7d30be6017700c118141f3c62db8ad9376c0fd`).
The run has not been modified, replayed, or cancelled.

## Producer

- No Auterim-owned code triggers `attest-verification-runner-identity`; the
  task is defined only in `src/trigger/attest-verification-runner-identity.ts`
  and declares no `queue`. Git history contains no producer for it either.
- No Auterim producer passes a string `queue` override or `lockToVersion`.
  `TRIGGER_EXTERNAL_DEPLOYMENT_ID` appears only in the dev-only guard in
  `scripts/m15-validation/probe-trigger-sdk-auth.mts`.
- The run was therefore created by an external pathway (Trigger MCP
  `trigger_task`, dashboard, or direct API). Its original request options are
  not available in this repository.
- The Trigger CLI 4.7.2 MCP `trigger_task` tool exposes
  `options.queue.name` ("the name of the queue to trigger the task in") and
  forwards `input.options` unchanged to `POST /api/v1/tasks/{id}/trigger`
  (`trigger.dev/dist/esm/mcp/tools/tasks.js`, `mcp/schemas.js`). Passing the
  task ID there yields exactly the stored bare queue value. This is the
  strongest hypothesis, not a confirmed fact.

## Trigger v4.7.2 behavior (public source, tag `v4.7.2`)

- `apps/webapp/app/runEngine/concerns/queues.server.ts`
  (`getTaskQueueInfo`): for an unlocked trigger, an explicit
  `options.queue.name` is used verbatim (only sanitized); it is not validated
  against the worker and not prefixed with `task/`. Without an override the
  default is the registered queue, `task/<taskId>`.
- `internal-packages/run-engine/src/engine/systems/dequeueSystem.ts`: dequeue
  looks up `queue.name === run.queue` in the resolved worker; a miss returns
  `QUEUE_NOT_FOUND`, which parks the run as `PENDING_VERSION` with that
  `statusReason`. `NO_WORKER`, `TASK_NOT_IN_LATEST` and
  `TASK_NEVER_REGISTERED` park the same way.
- `pendingVersionSystem.ts` + `apps/webapp/app/v3/services/clickhousePendingVersionLookup.server.ts`:
  parked runs are re-enqueued only when a new background worker is created or
  a deployment is finalized, and only for runs whose `task_identifier` and
  `queue` are both in that worker's registered sets, and whose
  `external_deployment_id` is empty or equals the deployment's.

## Recovery assessment

- In-place reconciliation through supported mechanisms is not expected: no
  Auterim worker registers a queue named `attest-verification-runner-identity`,
  so future deploys will not match the run. The only supported path that
  would match is deploying a worker that defines a queue with that exact name,
  which changes Production workers and is not authorized or recommended.
- Repeated deploys cannot help if the run also carries an
  `external_deployment_id` for another deployment.
- The run's `statusReason` and `external_deployment_id` are not in Auterim's
  possession; Trigger support can confirm them.

## Trigger support request

For project `proj_hwqtxtyrvwykjirkrdoh`, Production, run
`run_06glcb88fo2melb0m37u0ghn01`, please confirm read-only:

1. `TaskRun.statusReason` (expected `QUEUE_NOT_FOUND`).
2. `TaskRun.queue`, `lockedQueueId`, `lockedToVersionId`, and the ClickHouse
   `external_deployment_id` for the run.
3. The original trigger request options (`queue`, `lockToVersion`) and the
   client that sent them (MCP, dashboard, or API).
4. Whether any supported mechanism re-enqueues a `PENDING_VERSION` run whose
   queue is not registered on any worker, short of cancellation.

## Acceptance implication

The parked run is not attestation evidence. The attestation remains BLOCKED
until a separately authorized trigger runs on the default queue (no
`queue`, no `lockToVersion`) and completes on worker `20261019.7`.
