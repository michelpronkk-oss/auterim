# Auterim architecture

## Milestone 2 deterministic evidence

The deterministic monitoring path ends at historical snapshots and diffs:

`global source → guarded HTTP fetch → normalized text → SHA-256 → immutable snapshot → bounded deterministic diff`

The deterministic evidence remains the source of truth. Later interpretation is linked to that immutable evidence and cannot replace it.

## Milestone 3 semantic classification

The pipeline now continues asynchronously after a new `source_changes` row is committed:

`global source → guarded HTTP fetch → normalized text → SHA-256 → immutable snapshot → bounded deterministic diff → queued semantic classification`

The scan task makes a best-effort enqueue and finishes independently of the model provider. A database trigger creates a durable queued classification row in the same transaction as a source change; the daily dispatcher rediscovers queued, failed, and stale work. The dedicated `classify-source-change` task loads only global source/change evidence through a server-only repository, constructs a bounded packet, validates structured output with Zod, applies a conservative confidence policy, and persists a versioned interpretation. No model call is made during ordinary tests.

`SemanticClassifier` is the provider boundary. The current implementation uses AI Gateway with a model explicitly configured by `AUTERIM_CLASSIFIER_MODEL`; OpenAI or Anthropic can be selected through that boundary later. The provider is called without tools. Missing configuration becomes a recorded permanent failure and does not affect deterministic scanning.

Materiality categories are pricing, API change, deprecation, limits, terms, feature change, availability, documentation, security, and other. Material decisions below 0.82 confidence, with missing/unsupported evidence, generic category, or truncated input are marked `review_required`. Critical severity is retained only with grounded evidence and confidence at least 0.97; non-material decisions are always informational. The rationale is a short evidence-based summary, never hidden chain-of-thought.

## Global and tenant data

Global records describe public software providers and their sources: `dependency_catalog`, `source_catalog`, `scan_runs`, `source_snapshots`, and `source_changes`. A source is fetched once for all customers. Snapshot and change rows contain no tenant context.

Tenant records are `workspaces`, `workspace_members`, `companies`, `company_context`, `workspace_dependencies`, and `dependency_context`. They carry explicit workspace relationships and are protected by RLS policies that check membership in the database. The first owner is the authenticated workspace creator; additional member-management flows are deferred.

## Monitoring behavior

The `scan-source` Trigger.dev task loads one enabled catalog source with a server-only Supabase client, fetches and normalizes it, then submits the result to a database RPC. The RPC locks the source row, checks the latest snapshot inside the same transaction, and writes a baseline, unchanged run, not-modified run, or one changed snapshot and change. Stable Trigger run/attempt identifiers make retries replay-safe. A stale concurrent result is diffed against the locked latest snapshot before it can be saved.

One daily UTC dispatcher checks due sources and enqueues at most 100 in a run. It creates no per-source schedules. Run history remains in Postgres for inspection.

## Fetch and payload limits

The HTTP fetcher accepts HTTP and HTTPS only, rejects credentials and non-public destinations, resolves and pins public DNS addresses per request, repeats those checks after every redirect, disallows HTTPS downgrade, limits redirects to three, times out requests after 10 seconds, accepts HTML/XHTML/plain text, and caps response bodies at 2 MiB. It sends a fixed User-Agent and forwards conditional headers only while requests remain on the original origin.

HTML normalization removes document head, scripts, styles, noscript, templates, and SVG; retains ordered text; collapses layout whitespace; and caps normalized snapshots at 512 KiB. Raw response bodies are not stored. Normalized text is retained in Postgres for reproducible diffs. Move snapshot bodies to private Supabase Storage when normal content begins approaching the 512 KiB cap or database retention cost warrants it, while keeping hashes, byte counts, and object references in Postgres.

The fetcher blocks common private, local, link-local, documentation, multicast, and special-purpose IP ranges. It does not execute JavaScript or follow browser behavior. Publicly routed addresses outside those ranges can still be operationally unusual; sources should be curated, and the source catalog must remain server-managed.

## Privilege boundaries

- Tenant APIs rely on explicit grants and RLS policies; clients cannot read global scan evidence or write catalog/monitoring data.
- `SUPABASE_SECRET_KEY` (or the compatibility service-role variable) is used only by server-only monitoring/classification repositories.
- `AI_GATEWAY_API_KEY` is optional, server-only, and read only by the semantic classifier. `AUTERIM_CLASSIFIER_MODEL` must be set explicitly for live calls. External page content and catalog text are untrusted data, have no tool access, and are never mixed with tenant/company context.
- External source HTML is untrusted data and is parsed as inert text; no page scripts run.
- Git and Supabase identity guards use the repository's own local config. No automatic project discovery or linking occurs.
