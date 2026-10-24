# M15.78R fresh Production acceptance runbook

This runbook is for a separately authorized, single Production acceptance after
the fresh-acceptance PR has been merged and deployed. It does not authorize a
Production source change, Fix Run, or verification by itself.

> **Current generation is V4.** The sequence below was written for V2 and is
> kept unchanged as the historical contract. V2 and V3 attempts are
> append-only history. Production acceptance now uses the V4 actions
> (`read_fresh_v4_status`, `verify_fresh_v4`, `create_fresh_v4_source`,
> `dispatch_fresh_v4_intelligence`, `start_fresh_v4_fix_run`) with acceptance
> key `m1578r-internal-qa-fix-engine-v4` and the same fixture commit. The V4
> evidence record, the Stage 7 failure and its bounded recovery are in
> [V4 status](#v4-status-and-evidence) below. Stage 7 has **not** passed.

## Immutable scope

- Workspace: `e140d48e-9dc0-4552-a9a4-a81fe3872422`
- Product: `de1f2a12-de3c-4644-8892-b6c2d458a300`
- QA repository: `michelpronkk-oss/auterim-m15-github-qa`
- Repository ID: `b2abf377-2dbc-4b9c-b546-b0604f3ee4fe`
- Fixture commit: `94135df6f85bfb34ac83c046e5541e1ad8d73a86`
- Acceptance key: `m1578r-internal-qa-fix-engine-v2`
- Historical Fix Run `7de04a75-aefa-43a6-ba64-9fa4a70e0ec1` and
  Generation 3 authorization `5d70b833-44a1-49c8-ac2a-2cf7c8263e8c` are
  read-only and out of scope.

The Trigger task accepts action names only; it accepts no caller-selected
workspace, Product, repository, source, graph, commit, or Fix Run ID. The v2
actions query only the fixed acceptance key and the exact fixture SHA.

## Release prerequisites

1. Merge the reviewed fresh-acceptance PR. Record the resulting immutable merge
   SHA; deploy only that exact SHA to Trigger project
   `proj_hwqtxtyrvwykjirkrdoh`, Production. Do not deploy a moving branch name.
2. Apply migration `20261224000000_m1578r_fresh_acceptance_runner_evidence.sql`
   through the canonical Auterim Supabase migration process before the worker
   that uses its new RPCs is activated. Verify the migration version and RPC
   grants. The existing diagnostic RPC signature remains available to older
   workers; the new v2 RPC and successful runner-result RPC are service-role
   only.
3. Verify the active worker commit, task registration
   `m1578r-internal-test-acceptance`, and that the worker's runner protocol and
   pinned runtime image agree with the Production runner. Confirm
   `FIX_GITHUB_DRAFT_PR_WRITES=0` without reading or printing credential values.
4. Do not proceed unless the exact QA repository remains mapped to the existing
   Test Product, the GitHub App installation scope and permissions are approved,
   the signed dependency cache is bound to the exact fixture SHA, and Production
   Storage can read that cache. The existing `auterim` repository mapping must
   remain unchanged.

## Single execution sequence

Use the Trigger task `m1578r-internal-test-acceptance` in Production. Invoke
each action only as stated below; preserve each run ID and its returned status.

1. `{"action":"read_fresh_status"}` — require `not_started`. If any fresh
   source/change/decision/route/analysis/graph/Fix Run already exists, stop and
   reconcile that same acceptance identity; do not create another key.
2. `{"action":"verify_fresh"}` — require every readiness check to pass,
   including fixed workspace/Product/repository, exact default-branch fixture
   SHA, supported lockfile/profile, storage/cache access, configured model and
   runner, and disabled Draft PR writes. Any failure is a stop condition.
3. `{"action":"create_fresh_source"}` exactly once. This invokes the existing
   canonical `persistInternalTestSourceChange` flow with the fixed acceptance
   key and `internal_test` / `evidence_only` provenance, then dispatches the
   canonical classifier. It does not insert a classification, decision, route,
   code fact, graph edge, or Fix Run directly.
4. Wait for the classifier Trigger run to finish and verify the persisted
   classification is successful. Then call
   `{"action":"dispatch_fresh_intelligence"}` once. It requires a persisted
   classification and dispatches the canonical Jev/policy task; it does not
   force a route. A `waiting` result means wait for classification; an existing
   decision means do not dispatch another intelligence run.
5. Allow the canonical router, Product expansion, exact-commit Code
   Intelligence handoff, and Impact Graph path to complete. Use
   `{"action":"read_fresh_status"}` for fixed-scope persisted readback. Require
   matching source/change, completed classification and decision, correctly
   scoped route/handoff, completed analysis and graph at the fixture SHA, and
   positive observed and inferred graph evidence. Do not call the Fix Run
   starter while the graph is absent, ambiguous, incomplete, or out of scope.
6. Call `{"action":"start_fresh_fix_run"}` once. It verifies one completed
   graph, route eligibility, and positive edge counts, then triggers the
   canonical `start-fix-engine-from-graph` using a source-change-derived
   idempotency key. The existing stage processor and dispatcher run the
   persisted diagnosis, plan, patch, exact-base application, and remote
   verification stages.
7. Poll `read_fresh_status` for persisted results. Full acceptance requires a
   new Fix Run linked to this source, graph, analysis, repository and commit;
   persisted diagnosis, immutable plan, patch and apply result; a newly unique
   AWS runner job correlated to the request; durable AWS admission and terminal
   job evidence; expected account `737759272471`, region `eu-west-1`, instance
   `i-0592719b99a518001`, the pinned runner image (originally written as
   `sha256:408117eeeee5477f56eae8d8bb16cda12cf01ad0596b7ce3269bf2e2beaa56ee`,
   the retired `ac73ed8` image; the current pin is
   `sha256:6b5bcfbade5f2a8293918884cf6225ce24e705e7328529aee2772f264b4a32c4`,
   see [V4 status](#v4-status-and-evidence)),
   and protocol `m1578-verification-runner-v1`; a valid signed result; and at
   least one real supported command result persisted as passed. Require
   deterministic risk assessment after verification and `candidate_validated`
   for a full PASS. A policy-driven `risk_blocked` outcome is reportable but is
   not a full Fix Engine acceptance PASS.

## Side-effect and stop gates

- Keep `FIX_GITHUB_DRAFT_PR_WRITES=0`. Evidence-only provenance hard-blocks
  Preflight, real GitHub writes, customer actions, notifications, remediation,
  deployment, and billing.
- Do not create a generated-fix Draft PR, merge, or deploy a generated patch.
- Stop on identity/scope mismatch, commit drift, missing or duplicate graph or
  Fix Run, signature/cache failure, missing durable runner job record, result
  mismatch, unknown runner identity, unsupported verification, failed checks,
  risk block, or any side effect outside the stated evidence-only contract.
- Never reuse, reset, or recover the historical run or its Generation 3
  authorization. No Generation 4 or generic retry is authorized by this
  runbook. A failed fresh attempt remains append-only and requires a separately
  reviewed, narrowly scoped recovery decision before any additional execution.
- Do not use an identity attestation as a substitute for an actual verifier job.
  A healthy runner or successful Trigger dispatch alone is not acceptance.

## Final evidence record

Retain the sanitized Trigger run IDs and fixed-scope readback for source/change,
classification, Jev decision, route, repository handoff, analysis, graph,
Fix Run, diagnosis, plan, patch, verification, risk, and runner diagnostic
events. Include the immutable commit, analyzer/profile, positive evidence IDs,
request/job/result fingerprints, admission state, signed-result validation,
actual command outcomes, replay identity, and zero-side-effect counts. Do not
retain or print credentials, signed URLs, source archives, patch bodies, or
runner signatures in ordinary logs or the acceptance summary.

## V4 status and evidence

Recorded from persisted Trigger run outputs; IDs are sanitized identifiers only.

### Runner image identity

| Image                                                                                         | Status                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sha256:408117ee…56ee` (`ac73ed8`)                                                            | Retired. Historical Generation 3 pin for Fix Run `7de04a75`; rejected by current code.                                                                                                                                        |
| `sha256:86ba0b06…`, `sha256:0d439b25…`                                                        | Retired pre-attestation and self-ID images.                                                                                                                                                                                   |
| `sha256:6b5bcfba…32c4` (`auterim-verification-runner:m1578r-snapshot-extraction-20261019-04`) | **Current.** Built from the reviewed snapshot-extraction repair (PR #127). Attested in `run_06gmmt15a34ptruvhru1r0a3a2`: account `737759272471`, `eu-west-1`, `i-0592719b99a518001`, protocol `m1578-verification-runner-v1`. |

The attestation proves runner identity only. It is not verifier evidence.

### Stages 1–6 (passed 19 Oct 2026, worker `20261019.5`/`.6`)

| Stage                     | Trigger run                                                                            | Result                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1 status                  | `run_06gla4qs62dlfenj8gknhagp01`                                                       | `not_started`                                                            |
| 2 verify                  | `run_06gla4rdop36onefmfeg561m01`, `run_06gladnku8hs4tggcdpt1p2i01`                     | `ready`, all checks true                                                 |
| 3 create source           | `run_06gla4se4e4cv3q93j23t49b01`                                                       | source `b607267b…`, change `43ab3e52…`                                   |
| 4 classify + intelligence | classifier `run_06gla4tfhj9r73b9n00utvih01`; dispatch `run_06gladpn8k2q5nqu0915v78o01` | classification `c8561508…`; decision `9b58016f…` `continue_candidate`    |
| 5 route/analysis/graph    | readback `run_06glai39n5f4qculn26qs6v701`                                              | analysis `6f64060d…`; graph `382d7644…` 29/29 edges, observed + inferred |
| 6 start Fix Run           | `run_06glahpuh0pndk16n750km0d01` → `run_06glahqov60095mif2cigtj501`                    | Fix Run `8d38263a-8c0c-41cc-aaf0-e85770c1bfdb`                           |

### Stage 7 (FAILED, append-only)

Fix Run `8d38263a…` completed diagnose (`a5f3b4b7…`), plan (`c1034b08…`,
fingerprint `3e0dd0cf…`), patch (`6a3980ff…`, fingerprint `c7e9cfc3…`,
`src/endpoint.js`, 2 lines) and exact-base apply. `verify_patch` stage
`731cab44…` failed on attempt 1: runner admission returned HTTP 500 in
subphase `snapshot_archive_extraction` (event `6986257c…`, job `5c51d42c…`,
request `bd86f37e…`, admission `rejected`). Fix Run status
`validation_failed` / `runner_result_invalid`. No verification run or risk
assessment exists. This record is preserved; the recovery below appends to it.

### Bounded V4 Stage 7 recovery

Migration `20261226000000_m1578r_fresh_v4_verification_recovery.sql` and task
`recover-fresh-v4-verification` allow exactly one requeue of stage `731cab44…`
of Fix Run `8d38263a…`. Applying the migration authorizes nothing. The task
accepts only the fixed Fix Run ID and the authorization reference
`M15.78R user-authorized fresh V4 verification recovery after snapshot extraction repair`.

Before requeueing, the task requires `FIX_GITHUB_DRAFT_PR_WRITES=0`, the
expected cache public key, the `verify.auterim.com` runner speaking
`m1578-verification-runner-v1`, a fresh signed identity attestation naming
image `sha256:6b5bcfba…32c4`, and a byte-verified signed dependency cache for
the fixture commit. The service-role RPC then verifies, in one transaction:

- the run is still exactly `validation_failed` / `runner_result_invalid` at
  `verify_patch`, the stage is `failed` with attempt 1 and no operator retry,
  and the four earlier stages are the only other stages, all completed;
- scope is live: V4 source/change, protected Product, available repository,
  active mapping, monitored dependency, evidence-only provenance;
- exactly one diagnosis, plan and applied patch exist, matching the pinned
  IDs, fingerprints, plan link and base commit;
- the only runner evidence is the pinned rejected snapshot-extraction admission;
- no verification, Preflight, risk, external-operation or PR record exists.

It appends one immutable authorization row (unique per run and stage) and
moves only the verify stage to `queued` (operator retry 1) and the run to
`queued`. Diagnosis, plan, patch and failure evidence are not modified. The
cron dispatcher excludes the stage; the task dispatches it once with key
`fix-engine:fresh-v4-verification-recovery:<authorization id>`, because the
original delivery key is still inside its 30-day idempotency window. Replays
return `already_authorized` or `already_consumed` and never requeue again.

Within that single delivery the canonical stage runtime still applies: a
retryable runner failure (unavailable, queue full, transient state, transport
ambiguity, poll timeout) returns the stage to `queued` and the same
`process-fix-engine-stage` run retries it, so the recovery can use attempts 2
and 3 under the existing three-attempt stage cap. A non-retryable failure, or
a retryable one on attempt 3, is terminal.

Runner job identity is content-addressed, so the recovered job may carry the
same ID `5c51d42c…`. That is not a replay: rejected admissions are never
persisted by the runner, so that ID has no stored record, and the runner
removes stale admission spools at startup. The acceptance evidence is a new
accepted admission and terminal job record for the request.

### V4 Stage 7 PASS contract after recovery

`read_fresh_v4_status` must show, for Fix Run `8d38263a…`: verify stage
completed on attempt 2 or 3; a new runner diagnostic or result record with admission
`accepted` and a terminal job; runner account/region/instance as above, image
`sha256:6b5bcfba…32c4`, protocol `m1578-verification-runner-v1`; a valid signed
result; at least one supported command persisted as passed; a deterministic
risk assessment; and Fix Run status `candidate_validated`. `risk_blocked` is
reportable but not a full PASS. Any other outcome is a stop condition; no
further retry is authorized.
