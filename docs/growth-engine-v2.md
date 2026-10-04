# Growth Engine V2: Search Feedback

Growth Engine V2 adds a private, first-party feedback loop around the existing public Growth Engine. M10 remains the only publication readiness and public safety authority. M14 creates internal evidence-backed candidates for human review; it does not edit metadata, add links, publish, or distribute content.

## Search Console integration

The internal Google OAuth integration requests only `webmasters.readonly` and is restricted in server configuration to `sc-domain:auterim.com`. OAuth initiation requires a signed-in Auterim staff account present in `AUTERIM_GROWTH_ADMIN_EMAILS`. The future internal admin surface will use the existing authenticated same-origin API; the API returns only the generated authorization URL, while the browser-bound state cookie remains HttpOnly. State is random, hashed at rest, bound to the initiating user and browser cookie, expires after five minutes, and is claimed once. PKCE verifiers and Google tokens are encrypted with the existing versioned connector AES-GCM key ring. Callback exchanges and refreshes happen server-side. The integration never enumerates Search Console properties. There is currently no Search Console connection UI in customer onboarding or the customer dashboard.

### Deferred pre-launch admin acceptance

M14 backend implementation is complete. Real Search Console production acceptance is deferred until the dedicated internal admin surface is built before public launch; it is not an M14 implementation failure. The future handoff contract is:

`admin.auterim.com` → authenticated internal admin → connect Search Console → validate exact property `sc-domain:auterim.com` → Google OAuth with `webmasters.readonly` → encrypted credential persistence → bounded Search Analytics request → run `sync-auterim-search-console` → run `evaluate-growth-feedback` → display safe operational status.

The admin surface must preserve the existing admin allowlist, OAuth state/PKCE and callback validation, encrypted credential storage, bounded Search Analytics behavior, and safe callback trace categories. It must not add customer/tenant visibility, broaden scopes, enumerate properties, or expose credentials. Operational status should contain only safe states and counters, never tokens or raw query text.

Search Analytics sync uses a rolling 60-day date window and excludes the latest three days to account for reporting lag. Requests are grouped by date, query, and page; each request returns at most 1,000 rows and a sync uses at most five pages (5,000 rows). Search Analytics JSON is consumed incrementally with an 8 MiB response cap; oversized or malformed pages fail as typed non-retryable provider responses before that page can be persisted. Search query text is processed transiently and never persisted. The database retains a keyed HMAC fingerprint plus an explicit key version, a coarse query-to-page match boolean, and aggregate metrics; canonical page paths have query parameters removed. Metric upsert identities include the fingerprint version. During key rotation, evaluation selects the highest available fingerprint version for each canonical page/date, preventing overlapping versions from being summed as separate query populations; older date ranges remain interpretable under their stored version. Stable date/query/page hashes upsert late revisions with ingestion version 2. A page cap is reported as partial coverage. Provider errors are reduced to safe categories; retryable outages/rate limits do not mark credentials revoked. Metrics, sync rows, credentials, events, and candidates are service-only.

Canonical page mapping accepts only `https://auterim.com` and maps current public paths to normalized M13 surfaces. Article paths carry the M13 canonical slug as their topic key; provider hubs carry the provider slug. Query text remains transient and candidates contain only aggregate evidence. UTM values and landing paths are bounded; arbitrary query strings, auth values, and customer impact data are not collected.

## Deterministic feedback

`src/lib/growth-v2/contract.ts` owns the versioned rule thresholds and candidate taxonomy. Rules cover high impressions with low CTR, near-page-one visibility, unmapped query gaps, deterministic provider-hub internal-link opportunities, emerging/declining clusters, stale high-value pages, strong clusters, topic whitespace, distribution candidates, and aggregate product-entry comparisons. `weak_conversion` remains reserved; `strong_page_weak_conversion` and `lower_traffic_high_entry_rate` compare Search Console clicks with first-party browser stack-scan-start/continue actions by canonical landing path. This is an action rate, not a conversion rate or causal attribution. Clicks are never treated as conversions. If the bounded event scan reaches its 10,000-row cap, these comparisons are withheld and coverage is reported as partial. Every candidate keeps bounded aggregate metric evidence, the rules version, a normalized page path, and an optional canonical M13 topic. No paid model calls are used.

The feedback model is descriptive, not a claim that a search metric caused a conversion. Search clicks are not conversions. First-party lifecycle events are separately recorded and only server-confirmed signup completion, protection activation, GitHub connection, and an observed Pro trial are marked as server events. Early acquisition events are accepted as browser events and remain lower-trust. No visitor fingerprint or stable browser identifier is collected. Signup confirmation does not promote browser-provided attribution into server-confirmed attribution; attribution stays `unknown` when the source cannot be established confidently.

High-impression/low-CTR candidates include a title/snippet-intent review suggestion. The suggestion is internal and stable-keyed; it never edits metadata automatically. Deterministic provider-hub link candidates likewise contain a suggested target only and do not modify public pages.

## Review and safety gates

Feedback candidates begin in `needs_review`. Internal read and sync/evaluation APIs require an authenticated staff email from the allowlist. Candidate APIs do not offer publication or metadata write operations. Existing M10 publication policy, evidence checks, freshness rules, and human approval remain unchanged. New candidate records are internal suggestions only.

## Jobs and quotas

`sync-auterim-search-console` runs once per day at 03:30 UTC. It skips when the exact internal integration is not configured. `evaluate-growth-feedback` runs at 04:00 UTC after the sync, even when Search Console is disconnected, so stored feedback is reevaluated and retention cleanup continues. Both use bounded queries and persist run status; neither creates tenant-specific work or scans customer data. Search Console provider rate limits and outages are surfaced as bounded safe states and handled through Trigger.dev’s retry policy.

## Data model and authorization

The migration creates private tables for one exact-property connection, short-lived OAuth state, Search Analytics metrics, first-party events, sync runs, and review candidates. RLS is enabled and direct `anon`/`authenticated` grants are revoked. Only trusted server operations using the service client can read or write these records. Tokens are encrypted before persistence; OAuth state and stored credentials are never returned in read models.

The daily sync prunes metrics older than 180 days, first-party events older than 365 days, expired OAuth state older than one day, and completed sync-run records older than 90 days. Candidate review history is retained. Public event ingestion also uses a database-backed global ceiling of 120 writes per minute in addition to the request limiter so concurrent app instances share a durable bound.

## Evaluation and operations

Run `npm run eval:growth-v2` for deterministic rule and database/RLS coverage. `npm run env:check` reports Search Console configuration presence only. Live OAuth and Search Console calls are optional, require the dedicated Auterim property credentials and staff allowlist, and are never needed for normal tests or builds. A partial/no-credential environment reports the integration as not configured.
