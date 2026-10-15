# M15.75A protection intelligence reliability

## Boundary

Auterim keeps four kinds of truth separate:

1. **Source truth** is the immutable `source_changes` row and deterministic diff.
2. **Semantic judgment** is the existing `source_change_classifications` result and the independent Jev shadow decision.
3. **Tenant impact** remains in `customer-impact-v1` / `tenant-impact-v4` and runs only after the existing classifier's current materiality gate.
4. **Code and Production truth** remain the repository/Preflight and deployment verification systems.

The M15.75A architecture is:

```text
source scan
  → immutable deterministic source_change
      ├── classify-source-change
      └── evaluate-source-change-intelligence (shadow only)
             → deterministic Auterim policy
             → proposed route/state stored for reliability analysis
```

The two model tasks have separate durable queues and failure handling. A Jev outage does not fail or rewrite a source scan, and a classifier failure does not prevent Jev evaluation. The scheduled source dispatcher rediscovers queued and stale processing rows. No Jev result dispatches customer impact, Preflight, a notification, remediation, or any other action.

## Decision model

The provider-neutral route taxonomy is in `src/lib/intelligence/taxonomy.ts`. It includes documentation noise, deprecation, API breakage, authentication/security, contract/schema, pricing, limits, SDK, webhook/event, feature, runtime/availability, terms/policy, and uncertainty.

Jev is called server-side through OpenRouter's Decisions API at `https://openrouter.ai/api/alpha/decisions`, with the pinned model `typesafe/jev-1.14`. It receives one bounded structured evidence object and six typed questions: route (`choice`) and materiality, criticality, evidence sufficiency, documentation noise, and escalation (`noul`). It does not receive tenant impact, repository state, deployment state, billing, or credentials. OpenRouter's currently published interface documents the Decisions API as a structured probability response rather than generated text. The M15.75A runtime uses no chat-completions endpoint.

The response schema is validated before use. Model probability outputs are stored as bounded numeric fields. The provider response model identifier, token usage, cost, and latency are recorded when available. Provider errors are reduced to safe categories; response bodies, prompts, source snapshots, and reasoning are not persisted.

## Evidence quality and policy

`src/lib/intelligence/evidence.ts` builds a bounded packet from the deterministic diff and records truncation on the complete diff and each side, normalized byte size, line counts, source type/criticality, and semantic coverage. Source-authored text is untrusted evidence. Critical authoritative source types include deprecation, API, and status sources. Incomplete evidence from a critical source can only yield `insufficient_evidence`; it cannot be silently suppressed as non-material.

The policy in `src/lib/intelligence/policy.ts` is pure and versioned. It proposes `suppress_candidate`, `continue_candidate`, `escalate`, or `insufficient_evidence`. These are shadow labels, not commands. The initial shadow configuration keeps thresholds at the conservative uncalibrated boundary, so ambiguous decisions escalate and no model result causes routing. The Reliability Lab reports thresholds calibrated on a labeled subset and evaluates them on a held-out subset; those measurements are not automatically promoted into active production policy.

## Persistence and retry

`change_intelligence_decisions` is provider-neutral. Its unique identity includes source change, engine version, policy version, provider, pinned model, and evidence fingerprint. The migration seeds this queue transactionally when a deterministic source change is inserted, and backfills existing global changes. The Trigger task claims the persisted row, performs bounded inference, and records only structured decision output. Failed rows are eligible for bounded rediscovery. No workspace or customer fields are stored in the global decision table.

RLS is enabled and `anon`/`authenticated` have no table grants. Trusted service operations use narrowly scoped RPCs. The local integration test verifies queue seeding, duplicate handling, provider-failure retry, and browser-role denial against isolated Docker Supabase.

## Reliability Lab and replay

`npm run eval:intelligence` is offline and credential-free. It runs the 64 version-controlled labeled fixtures and tests the explicit split, evidence quality, risk-route policy, disagreement behavior, untrusted prompt text, and Jev/classifier independence. `npm run eval:intelligence:live` is a separately invoked, bounded Jev-only evaluation over the same static corpus plus at most 25 unlabeled local historical rows. Its live call ceiling is 89 decisions. The sanitized JSON report is written to ignored local cache at `node_modules/.cache/auterim/intelligence-live-eval.json` and emitted directly to stdout so Vitest cannot hide a successful-run summary.

The fixture IDs are assigned explicitly in `golden-fixtures.ts`: 32 calibration and 32 holdout cases. The lists are disjoint and cover material critical and noncritical changes, docs noise, each high-risk route family, pricing, incomplete evidence, ambiguity, large/noisy evidence, and adversarial text in both splits. Threshold derivation uses calibration results only. Holdout results are not used to select thresholds.

Reports separate **raw Jev** metrics from **Auterim policy** states and safety metrics. Raw Jev material/critical/evidence/escalation thresholds are calibrated only on the calibration fixtures; route metrics include a per-route confusion table. Policy metrics apply the deterministic policy to holdout Jev judgments with no classifier summary, which isolates the Jev-plus-policy safety boundary. Critical-source incomplete evidence is evaluated using the actual deterministic evidence-quality guard. These shadow results do not modify runtime thresholds.

The current semantic classifier is not called for the synthetic corpus during the Jev live run: doing so would add a separate set of provider requests outside the explicitly authorized Jev call budget. Its synthetic-corpus FN/FP metrics are therefore unavailable. Historical classifier/Jev comparisons remain agreement and disagreement counts only; historical rows have no independent gold labels. No classifier accuracy is inferred from them.

The final accepted run of the revised 64-fixture harness used the pinned Jev 1.14 line and made 75 decisions (64 labeled fixtures plus 11 local historical rows). The sanitized report is persisted in the ignored local cache at `node_modules/.cache/auterim/intelligence-live-eval.json`. The explicit stratified split passed. On the 32 held-out fixtures, raw Jev recorded 3 material false negatives, 1 material false positive, 3 critical false negatives, 0 docs-noise false positives, route accuracy 0.90625, evidence-insufficiency detection 0.80, and escalation recall 0.84. The three raw critical false negatives (`breaking-api-tail`, `schema-contract-tail`, and `limits-reduction-tail`) all ended in `insufficient_evidence`; a raw model false negative did not become an Auterim policy safety failure.

The held-out deterministic Auterim policy recorded 0 dangerous suppression false negatives, 1.0 critical protection coverage, 1.0 critical incomplete-evidence coverage, 1.0 docs-noise suppression precision, 0 docs-noise material false suppressions, and 0 unnecessary escalation rate. No high-risk route had zero accuracy. The active-routing reliability gate passes. The run used 103,094 input tokens and 17,340 output tokens, reported total cost $0.004329948, cost per 1,000 decisions $0.05773264, and mean latency 274.83 ms. Historical replay had 10 midpoint material agreements and 1 disagreement; those unlabeled rows are agreement statistics, not accuracy.

The semantic classifier was not called on the synthetic corpus to avoid extra live provider requests. Its synthetic-corpus accuracy remains unavailable, and no classifier accuracy is inferred from unlabeled historical rows. This Jev-only held-out policy evaluation is the reliability gate for the shadow engine; it does not promote thresholds into runtime or enable customer routing.

The pure replay/metrics API in `src/lib/intelligence/replay.ts` accepts stored classifier judgments, Jev judgments, and optional independent gold labels. It is read-only and does not mutate `source_changes`, tenant impact, or historical classifications.

### Previous positional run (superseded)

The first 24-fixture live run used a positional 16/8 split. Since fixtures were semantically ordered, that split overrepresented noisy and incomplete cases in holdout and included no incomplete examples in calibration. Its raw results (3 material FNs, 3 critical FNs, 0 material FPs, 0 docs-noise FPs, route accuracy 1.0, evidence-insufficiency detection 0, escalation recall 1.0) are retained only as historical context. They are superseded by the explicit stratified 64-fixture evaluation and are not a safety verdict.

### Readiness gates

Infrastructure completion, raw Jev quality, combined deterministic-policy safety, and active-routing readiness are separate statuses. Infrastructure can be complete while raw model errors remain. Raw critical false negatives do not by themselves imply a policy safety failure; the decisive measure is a material/critical gold case ending in `suppress_candidate`. Conversely, zero dangerous suppressions does not establish active readiness unless critical protection coverage is 100%, critical incomplete-evidence protection is 100%, docs-noise cases have no material false suppressions, and no high-risk route has an unexplained zero-accuracy collapse.

M15.75A reliability gate: **PASS**. The held-out policy safety metrics meet the required gates, and the local security review found no blocker. M15.75B is **ready for its separately authorized next phase after Production shadow rollout verification**. Active routing and customer actions remain disabled until then and stay disabled throughout this lab.

## Future router boundary

M15.75B may consider validated proposed routes only after reliability results and security review. Any later active flow remains:

```text
proposed route
  → autonomous router
  → tenant Product impact
  → verified repository exposure
  → Preflight
  → Production verification
  → explicitly authorized action
```

M15.75A does not enable this path. It does not change the existing classifier's materiality gate or tenant impact rules.
