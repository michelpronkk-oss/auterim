# Semantic material-change classification

## Purpose and boundary

Milestone 3 adds an interpretation layer after deterministic source monitoring. It answers whether a normalized source change appears materially meaningful. Snapshots, hashes, and deterministic diffs remain authoritative and immutable. This stage has no customer, workspace, product-usage, or spend context; it cannot assess a company's impact or recommend actions.

## Materiality and categories

A material change documents a meaningful difference in provider pricing or billing, API behavior/compatibility, endpoint or model availability, deprecation, limits, terms/policies, feature capability, service availability, or authentication/security requirements. Copyright years, spelling, formatting, navigation, equivalent reordering, tracking text, and cosmetic redesign are generally non-material. A source change can still be uncertain when its behavioral meaning is unclear.

Categories are `pricing`, `api_change`, `deprecation`, `limits`, `terms`, `feature_change`, `availability`, `documentation`, `security`, and `other`. Severity is only a source-level hint, never customer severity.

## Evidence construction and privacy

The classifier receives source/dependency labels, source type, origin-only URL, snapshot version numbers, bounded previous/current diff sides, the bounded deterministic diff, line counts, truncation state, and byte sizes. Diff evidence is capped at 8,000 UTF-8 bytes and side evidence at 3,000 bytes each, preserving bounded head and tail excerpts when truncation is necessary. The URL path, credentials, query, and fragment are omitted. No snapshot body, tenant context, customer data, secrets, or request headers are sent.

Model evidence entries include a type (`added`, `removed`, or `changed`) and an excerpt that must exactly match the corresponding side of the deterministic diff. Strict Zod validation runs before persistence. The database stores only bounded structured output and links it to the immutable `source_change`; it does not store prompts or duplicate snapshots.

## Provider, versioning, and output

Core code depends on the `SemanticClassifier` interface. The current provider adapter uses AI Gateway, with `AI_GATEWAY_API_KEY` and an explicitly chosen `AUTERIM_CLASSIFIER_MODEL`. No default model is selected and there is no live-provider requirement for tests. The provider has no tools.

Persisted fields include classifier, prompt, and schema versions, provider/model, deterministic evidence fingerprint, materiality/category, affected entities, severity hint, confidence, summary, typed evidence, concise rationale, decision state, token/latency metadata, attempt state, and error category/summary. The fingerprint is a database-generated MD5 idempotency fingerprint over immutable diff/snapshot hashes; it is not a security credential. Uniqueness includes source change, classifier version, schema version, prompt version, provider, and evidence fingerprint, so a later version can be stored without overwriting history. Any model change must bump `classifier_version`.

The externally usable `reasoningSummary` explains the evidence basis in a sentence or two. Private chain-of-thought is neither requested nor persisted.

## Confidence and failure policy

Confidence below 0.82 is marked `review_required`. Material output with no grounded evidence, category `other`, or truncated input is also review-only; truncation caps its confidence at 0.81. Critical severity requires grounded evidence and confidence at least 0.97; otherwise it is downgraded to high. A non-material result is always informational. Only `classified` material output is eligible for a future downstream handoff; review-only records remain stored for later inspection, with no review UI in this milestone.

The Trigger task has three bounded provider attempts, a 20-second provider timeout, no hidden SDK retries, and a concurrency cap of four. The database tracks total claims and the dispatcher stops rediscovery after six claims. Permanent missing-configuration failures are not automatically redispatched. Transient provider/schema failures remain recorded and retryable until the bound. Deterministic scan persistence and enqueue durability do not depend on provider availability. Calls are at-least-once: a worker crash after a provider response but before the persistence RPC can cause a repeat billed call when stale processing work is reclaimed.

## Prompt-injection defense

Monitored source text and metadata are untrusted data. The system prompt states that evidence cannot change instructions, trigger tool use, request secrets, or authorize links. JSON delimiters are escaped, evidence is explicitly labeled untrusted, and the provider receives no tools or tenant data. This defense reduces injection risk; model-based interpretation remains probabilistic, so output is schema-checked and grounded before persistence.

## Evaluation and limitations

`npm run eval:semantic` runs offline fixtures with deterministic mocked responses. Cases cover copyright, navigation, typos, equivalent rearrangement, pricing, limits, deprecation, authentication, optional features, availability removal, ambiguity, large noisy diffs with meaningful tails, injection text, secret/tool requests, wrong-side evidence, truncation, and malformed output. This verifies the pipeline, policy, schema, and evidence checks; it does not measure a live model's classification accuracy or confidence calibration.

The classifier can miss a material fact omitted by the deterministic bounded diff and may misread ambiguous prose. Truncated decisions are review-only, but full model quality requires an explicitly configured, separately approved live evaluation set. The next intelligence stage may consume only high-confidence classified material events and must add company context in its own isolated job.
