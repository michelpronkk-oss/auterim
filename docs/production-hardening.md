# Production hardening notes

## Dependency detail metadata

Authenticated dependency detail reads no longer access `source_snapshots` directly. The member-checked `get_dependency_source_baselines` RPC returns only source IDs and latest baseline timestamps for enabled sources of confirmed dependencies in the requested workspace. Snapshot bodies remain service-only and global.

## Public endpoint admission

Stack scans and conversion events use the atomic service-only `claim_public_rate_limit` RPC. The server derives an HMAC-SHA256 fingerprint using `PUBLIC_RATE_LIMIT_HMAC_SECRET`; raw IP addresses are not sent to or stored in Supabase. Only a validated platform `x-real-ip` is accepted. Limiter configuration, address, or database failures return a bounded 503 rather than falling back to process-local admission. Existing policies remain 4 stack scans per 30 minutes and 30 conversion requests per 15 minutes; the separate global conversion-write cap remains in place.

Stack scans additionally claim one of two global scan slots. A database singleton row serializes slot claims across application instances. Each lease expires after 30 seconds and is released in a `finally` block; expiry recovers capacity if an application process disappears. A small process-local limit remains as defense in depth.

Set `PUBLIC_RATE_LIMIT_HMAC_SECRET` to a dedicated random server-only value with at least 32 characters before deploying the application code and migration together. Do not reuse the Supabase, billing, connector-encryption, or provider credential secrets.

## Launch quotas

Dependency capacities are 20/75/250 for Core/Pro/Business. Protected repositories are 0/5/25. The database repository-limit function and canonical plan catalog use the same values. A normalized service/product entity and its separate 1/3/10 entitlement are not yet represented in the database; see [service-scoped relevance](service-scoped-relevance.md) for the safe foundation and migration sequence.

## Provider error safety

Slack transient and rate-limit failures are not reported as lost permissions. Ambiguous Linear issue-creation responses are recorded as unknown outcomes for reconciliation rather than enabling a blind duplicate. Sentry runtime responses are byte-bounded and reduced to numeric issue IDs and sanitized error-type metadata before leaving the adapter.

## Acceptance boundary

Local unit and PGlite tests do not prove production OAuth or provider behavior. Before deployment, verify the exact Auterim project, apply only the reviewed migration after a successful linked dry run, configure the dedicated public rate-limit secret, and run provider validation only with dedicated internal fixtures. Production credentials are not configured by this document.
