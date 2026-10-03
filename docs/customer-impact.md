# Customer-specific impact intelligence

## Boundary

Impact assessments are tenant-specific interpretations of an already classified global source change. The global `source_change_classifications` row remains separate and protected from tenant reads. An impact packet contains only the selected workspace dependency's context and the eligible global classification for that same dependency. It contains no unrelated workspace or tenant data.

The classifier uses the configured OpenAI Responses API with strict structured output, no tools, `store: false`, and a bounded request. Provider evidence and all customer context are untrusted data. A recommendation is text only; this milestone does not execute actions.

## Dependency context

`dependency_context` holds criticality (`critical`, `important`, `normal`), production criticality, up to twelve controlled `used_for` labels, a 2,000-byte context note, and bounded structured usage metadata. Server-only functions in `src/lib/impact/dependency-context.ts` validate and read/write that context. Values must come from the workspace dependency's owner/admin workflow in a future authenticated API; these service-role functions must not be exposed directly to clients.

The impact packet is capped at 12,000 UTF-8 bytes. Common secret-shaped strings, including Google API keys, are redacted before model transport. Context notes should contain operational details only; never enter credentials or other secrets. The model must treat both provider text and customer context as data, use only explicit facts, leave unknown usage or spend unknown, and ground evidence references in the packet. It must not invent model names, endpoints, workflows, usage volumes, spend, or cost calculations.

## Assessments and re-evaluation

`impact_assessments` belongs to one workspace dependency and one global classification. Its idempotency identity includes the impact-engine, schema, prompt, and deterministic context/evidence fingerprint versions. Identical work replays the prior assessment; changed context or engine versions create a new historical row. Assessments store relevance, tenant severity, affected areas, explanations, optional recommended text, confidence, missing context, grounded evidence references, status, bounded attempt counts, and provider usage/latency metadata.

Only the latest classified material global change is eligible. Fan-out loads dependency IDs in pages and starts one Trigger.dev task per workspace dependency; batches are capped at 500 and enqueue a continuation when more work remains. Up to four tenant assessments run concurrently, and a 15-minute scheduled drain recovers missed dispatches. Each tenant task loads only its own context and isolates provider failures from other tenants and from the global classification. Retries are bounded and persisted. Context changes automatically enqueue a fresh assessment revision, and the changed packet fingerprint creates a distinct row.

Fan-out eventually covers every eligible workspace dependency, so total model usage scales with the number of tenants using that dependency. Concurrency and per-run batch limits control throughput; this milestone does not add a global dollar budget.

## Security and read model

RLS permits members to read assessments in their own workspace. Anonymous users receive no table access, authenticated clients have no assessment write grant, and service-role RPCs validate that the workspace dependency and global classification reference the same dependency. The attention index supports a later query for each workspace's latest unresolved relevant assessments. No dashboard is included.

## Evaluation

`npm run eval:impact` runs provider-free fixtures plus deterministic evidence grounding, policy, context fingerprint, schema, secret-redaction, queue continuation, migration, and Responses API adapter checks. The fixtures inject known classifier outputs, so they validate policy and integration behavior rather than model accuracy. `npm run eval:impact:live` is an opt-in diagnostic; it checks the repository-local OpenAI provider/model/key configuration and makes at most three paid calls against fixed fixtures. It reports relevance accuracy, false positives/negatives, severity disagreements, unsupported financial/usage claims, grounded evidence, token usage, and estimated cost. It does not read or write the database.
