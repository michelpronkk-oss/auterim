# M15.78R Production acceptance record

**Verdict: PASS (24 Oct 2026).** All seven fresh-acceptance stages and the runner
identity attestation gate passed in Production. Fix Run
`8d38263a-8c0c-41cc-aaf0-e85770c1bfdb` reached `candidate_validated` with risk `LOW`.

This record is append-only evidence. Identifiers are sanitized; no credentials,
signed URLs, source archives, patch bodies or runner signatures are recorded.

## Scope of the PASS

The PASS proves the canonical Fix Engine path end to end **for evidence-only
internal QA**:

- source change (`internal_test` / `evidence_only`) → classification → Jev
  intelligence → route → exact-commit Code Intelligence → Impact Graph →
  Fix Run → diagnosis → immutable plan → patch → exact-base apply → remote AWS
  verification → deterministic risk assessment → `candidate_validated`;
- on one fixed internal QA repository (`michelpronkk-oss/auterim-m15-github-qa`)
  at fixture commit `94135df6f85bfb34ac83c046e5541e1ad8d73a86`, npm profile
  `javascript-typescript-v1`.

It does **not** prove or enable customer-facing automated remediation:
`FIX_GITHUB_DRAFT_PR_WRITES=0` throughout; evidence-only provenance blocked
Preflight, GitHub writes, Draft PRs, customer notifications, remediation,
deployment and billing; `production_exposure_state` remained `unknown`; review
stayed `review_required` (`critical_change`). Customer repositories, other
package managers, multi-repository Products and runtime exposure evidence are
outside this verdict.

## Identity

| Item                            | Value                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repository / approved source    | `michelpronkk-oss/auterim` @ `ffdaf187da8d9eba31484185f5d303c043f2098a`                                                                          |
| Supabase project                | `lnljaacbptrubppoypaz`                                                                                                                           |
| Trigger project                 | `proj_hwqtxtyrvwykjirkrdoh`, Production                                                                                                          |
| Worker for stages 1–6           | `20261019.5` / `20261019.6` (19 Oct)                                                                                                             |
| Worker for recovery and Stage 7 | `20261024.1` (deployment `jxmu22jd`, `deployment_fx939og63j5vnp7vwbvto`, external ID = source SHA, clean tree)                                   |
| Verifier host                   | AWS `737759272471`, `eu-west-1`, `i-0592719b99a518001`                                                                                           |
| Runner image                    | `sha256:6b5bcfbade5f2a8293918884cf6225ce24e705e7328529aee2772f264b4a32c4` (`auterim-verification-runner:m1578r-snapshot-extraction-20261019-04`) |
| Protocol                        | `m1578-verification-runner-v1`                                                                                                                   |

## Gate table

| Gate                                   | Result | Evidence                                                                                                                                                                      |
| -------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner identity attestation            | PASS   | `run_06gmmt15a34ptruvhru1r0a3a2` (24 Oct, worker `20261019.7`)                                                                                                                |
| 1 Status `not_started`                 | PASS   | `run_06gla4qs62dlfenj8gknhagp01`                                                                                                                                              |
| 2 Readiness                            | PASS   | `run_06gla4rdop36onefmfeg561m01`, `run_06gladnku8hs4tggcdpt1p2i01`; re-confirmed on `20261024.1` in `run_06gmnsa0rqelot11e0kda36ta2`                                          |
| 3 Source creation                      | PASS   | `run_06gla4se4e4cv3q93j23t49b01`: source `b607267b…`, change `43ab3e52…`                                                                                                      |
| 4 Classification + intelligence        | PASS   | classifier `run_06gla4tfhj9r73b9n00utvih01` (`c8561508…`, material deprecation, 0.99); dispatch `run_06gladpn8k2q5nqu0915v78o01` (decision `9b58016f…`, `continue_candidate`) |
| 5 Route / analysis / graph             | PASS   | route `63919c7c…`; analysis `6f64060d…` (`code-intelligence-v3`, complete); graph `382d7644…` 29/29 edges, observed + inferred                                                |
| 6 Fix Run start                        | PASS   | `run_06glahpuh0pndk16n750km0d01` → `run_06glahqov60095mif2cigtj501` → Fix Run `8d38263a…`                                                                                     |
| 7 Verification → `candidate_validated` | PASS   | see below                                                                                                                                                                     |

## Stage 7 history (preserved)

**Original failure, 19 Oct 17:49 UTC (append-only, unchanged).** Diagnose
(`a5f3b4b7…`), plan (`c1034b08…`, fingerprint `3e0dd0cf…`), patch
(`6a3980ff…`, fingerprint `c7e9cfc3…`, `src/endpoint.js`, 2 lines) and apply
completed. `verify_patch` stage `731cab44…` attempt 1 failed: runner admission
HTTP 500 in subphase `snapshot_archive_extraction`; event `6986257c…`, job
`5c51d42c…`, request `bd86f37e…`, admission `rejected`; Fix Run
`validation_failed` / `runner_result_invalid`. The runner fix shipped in PR #127.

**Intervening outage.** From 21 Oct ~03:02 UTC the Supabase project was paused
(hostname stopped resolving); all Supabase-dependent tasks failed until it was
restored on 24 Oct. No acceptance state changed during the outage (readback
`run_06gmn5vol35vn4sru9noaopfa2` was identical to the 19 Oct baseline).

**Bounded recovery (PR #128, migration `20261226000000`).**

- Migration applied by the approval-gated workflow (PRs #129, #130): GitHub
  Actions run `40057233501` on `ffdaf187`; plan showed 84 applied / latest
  `20261225000000` / pending only `20261226000000`; dry run listed exactly
  `20261226000000_m1578r_fresh_v4_verification_recovery.sql`
  (sha256 `35063580e77796e5fb1b6c85c2bbc0a08941f5799a85135f8a05e776d38bb6eb`);
  apply approved in the protected `supabase-production` environment; post-apply
  history showed nothing pending.
- Pre-recovery readback on `20261024.1` (`run_06gmns9b8a947co3gl79sniia2`) was
  identical in every section to the verified baseline; the authorization ledger
  was empty.
- Single authorized invocation `run_06gmnshpuik86rm9hc7i26cja2` of
  `recover-fresh-v4-verification` re-proved Draft PR writes disabled, the
  runner endpoint and protocol, a fresh signed attestation of image
  `6b5bcfba…`, and the byte-verified signed dependency cache (identity
  `86ab5d3a…`, manifest `4acbdb1f…`). It appended immutable authorization
  `cf7563b3-2245-4e8a-a38e-43480395cccc` and dispatched the verify stage once
  (`run_06gmnsiaua5209ui13ppklgua2`).
- The `process-fix-engine-stage` queue was paused. With operator approval it was
  resumed only for this Fix Run and re-paused at 03:35:12 UTC with nothing
  queued or running.

**Recovered verification, 24 Oct 03:33–03:34 UTC.**

| Evidence                      | Value                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Verify stage                  | `731cab44…` completed on attempt 2                                                                                            |
| Verification run              | `767d1359…`, profile `javascript-typescript-v1`, `passed`, 4140 ms                                                            |
| Commands                      | `targeted_test` passed (1779 ms); `typecheck` passed (2361 ms)                                                                |
| Patch                         | fingerprint `c7e9cfc3…` (unchanged, attempt 1 patch)                                                                          |
| Runner job                    | `5c51d42c…` (content-addressed; the 19 Oct admission was rejected and never stored, so this was the first admitted execution) |
| Request / result fingerprints | `bd86f37e…` / `f8ca2b09421a571075bae8ebdf2b26849f2cadb25049b4b2a6f41e4cef732c9f`                                              |
| Signed result                 | `runnerResultSignatureValidated: true`                                                                                        |
| Verifier container            | `node:24.8.0-alpine3.22@sha256:3e843c60…` (pinned verification image)                                                         |
| Risk assessment               | `67c538d2…`, `fix-risk-v1`, risk `LOW`, review required (`critical_change`)                                                   |
| Fix Run                       | `candidate_validated`, failure category `null`                                                                                |

Final readback: `run_06gmnuialqcriiuifj4d1hmaa2` (worker `20261024.1`). Artifact
counts unchanged (1 diagnosis, 1 plan, 1 patch, 4 model attempts); the 19 Oct
failure event is still present.

## Production operating state after acceptance

Read-only audit, 24 Oct 2026, worker `20261024.1`:

| Queue                                                  | State                | Backlog             | Notes                                                                                                                                                  |
| ------------------------------------------------------ | -------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `process-fix-engine-stage`                             | **paused** (limit 2) | 0 queued, 0 running | Paused before this acceptance; resumed only for the recovered stages and re-paused. Fix Engine stages are frozen until a separate decision resumes it. |
| `recover-internal-fix-verification-after-cache-repair` | **paused** (limit 1) | 0 / 0               | Historical generation 1–3 recovery for Fix Run `7de04a75`; should stay paused.                                                                         |
| 48 other queues                                        | active               | none                | Scheduled dispatchers completing normally.                                                                                                             |

One run stays `PENDING_VERSION`: `run_06glcb88fo2melb0m37u0ghn01`
(`attest-verification-runner-identity`, payload `{}`). It was deliberately left
untouched and did not start on `20261024.1`.

## Notes for auditors

- The success path persists the signed verification result rather than a
  separate admission event; acceptance of the job is evidenced by the
  validated signed terminal result above.
- Runner identity was attested at authorization time (03:26 UTC), seven
  minutes before execution, not per job.
- Historical Fix Run `7de04a75…` and its generation 1–3 authorizations were not
  touched.
