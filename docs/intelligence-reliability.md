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

`npm run eval:intelligence` is offline and credential-free. It runs 24 version-controlled golden fixtures and tests evidence quality, routing policy, disagreement behavior, untrusted prompt text, and Jev/classifier independence. `npm run eval:intelligence:live` is a separate, explicitly invoked evaluation over only those static fixtures. It divides the results into calibration and holdout subsets, reports false negatives/positives, critical false negatives, documentation-noise false positives, route accuracy, evidence-insufficiency detection, escalation recall, latency, and cost per 1,000 decisions.

The pure replay/metrics API in `src/lib/intelligence/replay.ts` accepts stored classifier judgments, Jev judgments, and optional independent gold labels. It is read-only and does not mutate `source_changes`, tenant impact, or historical classifications. Unlabeled historical records report model agreement only; agreement is not reported as accuracy. A current deployment with no representative labeled historical set cannot establish comparative model quality.

### Initial live shadow evaluation (2026-10-15)

The pinned `typesafe/jev-1.14-20261014` model evaluated the 24 static fixtures and replayed 11 local historical rows. The historical replay had 11 current classifier results, 9 materiality agreements and 2 disagreements at the 0.5 Jev midpoint. It had no independent gold labels, so those counts are agreement only.

The 16-fixture calibration slice and 8-fixture held-out slice reported these held-out results: 3 material false negatives, 3 critical false negatives, 0 material false positives, 0 documentation-noise false positives, route accuracy 1.0, evidence-insufficiency detection 0.0, and escalation recall 1.0. Evidence insufficiency could not be calibrated because the calibration slice had no incomplete-evidence examples. Across all 24 calls, mean latency was about 293 ms, reported usage was 30,992 input and 5,548 output tokens, and reported cost was about $0.00130 ($0.0542 per 1,000 decisions at this sample's reported rate).

These results are a small synthetic shadow run, not production accuracy or a representative reliability baseline. The critical false negatives and missing incomplete-evidence calibration mean the thresholds remain uncalibrated and must not be promoted to active routing. M15.75B remains not ready pending a reviewed labeled corpus and improved held-out safety results.

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
