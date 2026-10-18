# M15.78R fresh Production acceptance runbook

This runbook is for a separately authorized, single Production acceptance after
the fresh-acceptance PR has been merged and deployed. It does not authorize a
Production source change, Fix Run, or verification by itself.

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
   `i-0592719b99a518001`, pinned image
   `sha256:408117eeeee5477f56eae8d8bb16cda12cf01ad0596b7ce3269bf2e2beaa56ee`,
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
