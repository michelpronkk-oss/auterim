# Auterim CLI Product discovery (M15.6)

The CLI analyzes a project locally without executing project code. Its scanner makes zero network requests. Connected mode submits the strict derived-metadata payload only after browser authorization and explicit interactive terminal consent.

## Commands and platform support

The pre-release package is auterim@0.1.0, with the auterim binary, ESM output, and a Node.js >=22.6.0 runtime requirement. Use:

    npx auterim connect
    auterim connect --dry-run
    auterim --help
    auterim connect --help
    auterim --version

Connected mode defaults to https://auterim.com. --server accepts only that production origin or an explicit HTTP(S) loopback origin for development. Dry-run and --server are mutually exclusive. Browser opening uses the platform URL handler without a shell. If the handler is unavailable, the trusted approval URL is printed for manual copy/paste. CI and non-interactive terminals do not create a session; run connect --dry-run to inspect the local summary instead. No ANSI/color support is required for correctness.

Supported local path behavior covers Windows drive paths and POSIX paths. UNC/network paths are rejected by the scanner. No lower Node version compatibility is claimed without a dedicated runtime test.

## Device authorization

POST /api/cli/v1/connect creates a 15-minute session. It returns a human code, a separate high-entropy poll secret, and a fixed Auterim approval URL. The user code is only a browser lookup hint; it cannot poll or ingest. The browser requires an authenticated Auterim account and owner/admin membership, then binds the session atomically to one existing company and one existing draft or protected Product. Draft Products can use CLI discovery during onboarding without activating the workspace, starting a trial, confirming dependencies, or enabling monitoring. Archived Products are ineligible. CLI-created companies/products are not supported.

Only hashes of the human code, poll secret, and ingestion credential are stored. The ingestion credential is derived with the server-only AUTERIM_CLI_CONNECT_HMAC_SECRET, has one scope (submit_local_discovery), expires within 24 hours, and permits one scan identity. The same scan ID and exact payload can be retried idempotently. A different payload with that ID conflicts. Polling is bounded by a shared distributed IP limiter and a two-second database interval. The credential is returned once; the CLI keeps it in memory and does not persist it.

Approval requires current owner/admin membership. Approval and ingestion accept a Product that is still in draft or already protected, and reject archived Products. Ingestion also rechecks the approving user's current workspace membership. Archiving the Product or removing that membership invalidates the grant. Cancellation revokes the session. Browser approval requires a same-origin authenticated bearer request; it does not use a return URL, cookie credential, or OAuth redirect. The CLI opens only the verified approval URL on its already-trusted server origin and validates its exact path and query before invoking the OS browser handler.

Ctrl+C aborts current polling, scan, review prompt, or upload. If a session has been created, cancellation is attempted with a separate short timeout; server-side expiry is the fallback. A normal interrupt exits 130 without a stack trace.

## Data analyzed and uploaded

The bounded scanner reads selected dependency manifests, configuration identity, import references, environment-variable names only, and sanitized Git metadata. With explicit submission consent, the payload may contain derived provider candidates, evidence family/reason/confidence, safe relative paths and subproject names, the project folder basename, bounded scan statistics, and sanitized Git host/owner/repository/branch/commit metadata. It never includes source file bodies, environment values, credentials, raw lockfiles, or the absolute local path. The consent screen calls out relative paths, the project folder name, and Git identity. Review these fields before submitting.

The CLI package currently has no runtime package dependencies and imports Node built-ins only. It does not execute project code or load project modules. Its packaging allowlist includes compiled CLI output and the package README only.

## Local project identity and reruns

For a repeat invocation on the same local directory, the CLI stores a random opaque localProjectId and lastSuccessfulScanAt in the user's Auterim config directory:

- Windows: %LOCALAPPDATA%\Auterim (fallback: %USERPROFILE%\AppData\Local\Auterim)
- macOS: ~/Library/Application Support/Auterim
- Linux: $XDG_CONFIG_HOME/auterim when the XDG path is absolute, otherwise ~/.config/auterim

The local directory is used only to select the corresponding config file; the absolute path is neither persisted in the file nor sent to Auterim. The config filename is a SHA-256 hash of the resolved local path, kept only on this machine so repeated invocations can find the same state; this local path-derived fingerprint is not uploaded. The config contents are limited to formatVersion, random localProjectId, createdAt, and lastSuccessfulScanAt. It has no Product hint or authorization material. Writes use a private directory/file mode where supported and an atomic replacement. Corrupt/oversized state is ignored and regenerated. Deleting the local state resets recognition. The random ID is a convenience only, is not sent to the server, and is never used for authorization. The payload continues to send projectFingerprint: null; cross-machine correlation is intentionally deferred to avoid widening the payload/schema or creating a server-side path identity.

A rerun identifies the same local directory, shows the last complete local scan time when available, and still requires a new browser authorization binding. No previous Company/Product or ingestion credential is trusted locally.

## Evidence model and Product Graph

Scan history is append-only in cli_scan_runs; derived observations are in cli_observations. Direct client writes are denied. Authenticated workspace members can read safe evidence under RLS. The server resolves known provider slugs against the canonical dependency catalog. Unknown providers remain review-only identifiers and are never inserted into the global catalog.

Local evidence is not itself a confirmed dependency, monitoring coverage, repository verification, deployment evidence, or runtime evidence. The Product Protection Graph reports a separate localDiscovery section and keeps observations observed_unconfirmed. A known observation is associated in the read model with a Product dependency only when a canonical Product dependency for that catalog provider exists. In the Product view, a known candidate can use the existing authenticated manual_add dependency operation; it is Product scoped, tenant checked, and idempotent. The CLI does not confirm automatically. Unknown providers show as review-only and have no arbitrary-provider creation path.

Known candidates distinguish source catalog availability from confirmed dependency monitoring. “Monitoring sources available” reports configured source-catalog coverage only; it does not claim a scan, current baseline, or health. Candidates do not inflate confirmed dependency counts. Graph data remains bounded and includes safe evidence family, latest-observed state, relative provenance, and previous-scan comparison. Historical evidence remains visible when absent from a later scan.

The server accepts only schema 1.0.0, at most 512 KiB, and at most 1,500 observations. An older or newer incompatible schema receives 426 unsupported_cli_version with the supported schema version, and the CLI directs users to npx auterim@latest connect. Other payloads with extra fields, unsafe paths, secret-shaped values, or failed/cancelled scan states are rejected. No source bodies, environment values, credentials, or raw lockfiles are accepted.

## Network, privacy, and consent

The scanner network-request contract is exactly zero. Connected CLI requests go only to Auterim for:

1. creating a connect session;
2. polling for browser authorization;
3. cancelling an incomplete session; and
4. submitting reviewed local discovery metadata.

The OS browser handler may open the fixed Auterim approval URL. It is not scanner discovery and does not permit an arbitrary server-supplied scheme or host. No telemetry event carries file names, candidates, paths, machine identity, or evidence payload.

## Failure, exit codes, and retry

Stable V1 exit codes:

- 0: completed successfully or offline dry-run completed;
- 1: interaction/configuration/internal failure (including non-interactive connected use);
- 2: invalid command or untrusted origin;
- 3: user declined submission;
- 4: authorization failed, expired, or access changed;
- 5: local scan failed;
- 6: remote submission failed or could not be confirmed;
- 130: Ctrl+C interruption during authorization, scan, review, or upload.

HTTP 429 and safe provider error codes receive bounded user-facing next steps; the CLI does not print raw provider response bodies. Poll delay is bounded by the server interval and capped at ten seconds. Connect/poll requests have a ten-second timeout.

UPLOAD_RETRY_V1 is: **start a fresh connection and rescan after a failed or ambiguous submission**. The CLI does not keep a durable local scan cache or automatically retry an ambiguous submission. It reports success only after Auterim confirms acceptance. A fresh connection creates a new scan identity, so an ambiguous post-submit failure can produce another append-only scan. Exact same-scan retries are endpoint-idempotent while the original credential remains usable, but durable offline retry and exactly-once delivery under lost responses are deferred.

## Local packaging and version strategy

packages/cli remains private and is not published in this milestone. The tarball is reviewed with npm pack --dry-run; only package.json, package README.md, and built dist/** files are allowed. There is no package-level LICENSE file; publication waits for the repository's licensing decision. No source maps are emitted. The public registry name/reservation and immutable release workflow are separate release-gate decisions.

The CLI package version (0.1.0), payload schema (1.0.0), scanner version (0.1.0), and provider registry version (m15.6-provider-map-1) have separate responsibilities and are not automatically coupled. A schema change requires explicit server compatibility behavior. The CLI version follows pre-release SemVer discipline; published versions must be immutable, but publication is not authorized here.

Phase 3 does not run Preflight, create repository connections, enable monitoring, apply remote migrations, deploy, or publish.
