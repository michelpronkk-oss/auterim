# Auterim CLI Product discovery (M15.6)

The CLI scans a local project without executing project code or making network requests. `connect --dry-run` stays fully offline. Connected mode submits only the Phase 1 derived payload after explicit terminal consent.

## Device authorization

`POST /api/cli/v1/connect` creates a 15-minute session. It returns a human code, a separate high-entropy poll secret, and a fixed Auterim approval URL. The user code is only a browser lookup hint; it cannot poll or ingest. The browser requires an authenticated Auterim account and owner/admin membership, then binds the session atomically to one existing company and one existing draft or protected Product. Draft Products can use CLI discovery during onboarding without activating the workspace, starting a trial, confirming dependencies, or enabling monitoring. Archived Products are ineligible. CLI-created companies/products are not supported.

Only hashes of the human code, poll secret, and ingestion credential are stored. The ingestion credential is derived with the server-only `AUTERIM_CLI_CONNECT_HMAC_SECRET`, has one scope (`submit_local_discovery`), expires within 24 hours, and permits one scan identity. The same scan ID and exact payload can be retried idempotently. A different payload with that ID conflicts. Polling is bounded by a shared distributed IP limiter and a two-second database interval. The credential is returned once; the CLI keeps it in memory and does not persist it.

Approval requires current owner/admin membership. Approval and ingestion accept a Product that is still in `draft` or already `protected`, and reject archived Products. Ingestion also rechecks the approving user's current workspace membership. Archiving the Product or removing that membership invalidates the grant. Cancellation revokes the session. Browser approval requires a same-origin authenticated bearer request; it does not use a return URL, cookie credential, or OAuth redirect.

## Evidence model

Scan history is append-only in `cli_scan_runs`; derived observations are in `cli_observations`. Direct client writes are denied. Authenticated workspace members can read safe evidence under RLS. The server resolves suggested provider slugs against the canonical dependency catalog. Unknown/stale provider names are retained only as local identifiers, never inserted into the global catalog.

Local evidence is not a confirmed dependency, monitoring coverage, repository verification, deployment evidence, or runtime evidence. A matching provider links to an existing Product dependency only when that dependency is already present. New candidates do not change the confirmed dependency count or monitoring eligibility. The Product Protection Graph reports a separate `localDiscovery` section, marks observations as `observed_unconfirmed`, shows catalog source coverage separately, and retains observations missing from the latest scan as historical `not_observed_in_latest` evidence. Partial scan status remains visible.

The server accepts only the strict Phase 1 schema version, at most 512 KiB, and at most 1,500 observations. Payloads with extra fields, unsafe paths, secret-shaped values, unsupported versions, or failed/cancelled scan states are rejected. No file contents, environment values, credentials, or raw lockfiles are accepted. `projectFingerprint` remains null.

## Upload failure and retry (V1)

`UPLOAD_RETRY_V1` is: **restart connection and rescan after a failed submission**. The CLI does not keep a durable local scan cache. If the server is unavailable before upload, the CLI exits unsuccessfully with a safe error and does not print an acceptance message; the user can start a new `auterim connect` flow and rescan. Previously accepted scan history remains intact. The ingestion endpoint commits a scan and its observations in one database transaction.

The CLI does not promise exactly-once delivery when a submission may have committed but its response was lost. A fresh connection creates a new scan identity, so an ambiguous post-submit failure can produce another append-only scan. Exact same-scan retries are idempotent at the endpoint while the original credential remains usable, but durable offline retry is deferred.

## Local configuration

Set `AUTERIM_CLI_CONNECT_HMAC_SECRET` to a server-only random value of at least 32 characters. Connected API routes also require `PUBLIC_RATE_LIMIT_HMAC_SECRET` and server-side Supabase configuration. `npm run env:check` reports presence only. `.env.example` contains placeholders only.

Connected CLI usage:

```sh
auterim connect --server https://auterim.com --root <project-directory>
```

For local QA, the CLI allows only a loopback server such as `http://127.0.0.1:3000`. The CLI shows the Auterim URL and code, waits for approval, prints the derived evidence review, and asks before upload. The live endpoint is restricted to `https://auterim.com`; it does not accept arbitrary upload destinations.

Phase 2 does not run Preflight, create repository connections, enable monitoring, or apply any remote migration.
