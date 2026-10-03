# Monitoring pipeline

## Deterministic source scan

The daily Trigger.dev dispatcher lists up to 100 due catalog sources and enqueues `scan-source`. The task loads one enabled source using the server-only repository, performs guarded HTTP fetches, normalizes HTML/text, hashes normalized content with SHA-256, and calls a transaction-backed RPC. Baseline runs create one immutable snapshot; unchanged and HTTP 304 runs add only scan history; changed content creates one snapshot and one `source_change` with a bounded deterministic diff. Database locks, unique constraints, run IDs, and content hashes make concurrent scans and retries safe.

The fetcher accepts HTTP(S), rejects private/local addresses, pins checked public DNS answers, rechecks redirects, blocks HTTPS downgrade, bounds redirects, time, and body size, and does not execute JavaScript. Raw response bodies are discarded. Normalized text is retained up to 512 KiB for reproducible diffs.

## Semantic classification

The source-change insert trigger creates a durable queued global classification row in the same database transaction. `scan-source` then attempts to enqueue `classify-source-change`; enqueue failure is caught and logged by category only, leaving the row discoverable. The daily dispatcher rediscovers queued, failed, or stale classification work separately from due source scans.

The classifier loads only global source-change evidence, constructs a bounded packet, calls the configured provider, validates the strict Zod output, applies evidence-side and confidence policies, and persists the result/version/metrics slots. Provider failure cannot roll back or corrupt a completed deterministic scan. Each Trigger task has three attempts and database redispatch is capped at six total claims.

## Data and operational boundaries

Tenant/company tables remain workspace-scoped with membership RLS. Global catalogs, source evidence, and classifications are not client-readable or writable; only server-side service-role repositories and restricted RPCs access them. No classification payload contains tenant/company context. The application currently has no dashboard for classification metrics; rows retain classification rates/status, confidence, provider errors, latency, and optional token counts for later reporting.

## Known limits

The scan task is not a browser crawler and does not execute dynamic pages. Classification is an interpretation of a bounded diff, not a replacement for it. Truncated evidence lowers confidence and forces review. Provider credentials/model configuration are optional, so monitoring can operate while classification records a permanent configuration failure. Large normalized snapshots may later move to private object storage while hashes and references remain in Postgres.
