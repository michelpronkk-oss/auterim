# Preflight and prevent breakage

Milestone 7 adds a backend read model for repository-specific impact and a safe remediation proposal flow. It does not add a visual screen, customer-code execution, or automatic writes.

## Repository authorization and connection

The only live repository provider is GitHub through a GitHub App. A workspace member starts `POST /api/repositories/install` with a workspace ID. The server checks membership, creates a cryptographically random one-time state with a ten-minute expiry, and stores only its SHA-256 hash. The browser is sent through the GitHub App OAuth identity callback and then the App installation flow. The OAuth callback records the verified GitHub login; the installation callback requires the installation account to match that login and consumes the state once. This prevents a member from attaching another GitHub account's installation by substituting an installation ID.

The callback imports repository metadata only, with bounded pagination up to 500 repositories per installation. Larger installations receive an explicit unsupported-size response. New repositories begin unselected. `GET /api/repositories?workspaceId=...` returns tenant-visible connection/repository metadata. `PATCH /api/repositories/{id}` selects a repository for protection and associates it with confirmed workspace dependencies through one membership-checking database function. Discovery candidates cannot be linked directly.

`POST /api/github/webhook` verifies the GitHub HMAC signature before parsing the payload, limits the body to 1 MB, and deduplicates delivery IDs. Installation suspension/deletion revokes access, deselects repositories, and removes dependency links. Repository removal webhooks do the same for the removed repositories. Reconnecting does not silently reselect repositories or restore dependency links.

Required server-only GitHub App settings are `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_WEBHOOK_SECRET`. Configure the GitHub App callback URL as `${NEXT_PUBLIC_APP_URL}/api/repositories/install/oauth-callback`, the setup URL as `${NEXT_PUBLIC_APP_URL}/api/repositories/install/callback`, and the webhook URL as `${NEXT_PUBLIC_APP_URL}/api/github/webhook`. Grant read-only Contents permission and subscribe to `installation`, `installation_repositories`. No personal access token is used. `npm run env:check` reports presence without printing values.

The provider interface is narrow (`RepositoryProvider`) and GitHub's implementation generates a short-lived installation token scoped to one repository with Contents read permission. Tokens exist only in process memory until expiry and are never stored in Supabase. The App installation metadata/repository list operation uses a short-lived read-only installation token that is discarded after the callback.

## Eligibility and deterministic inspection

An assessment is eligible only when the latest semantic classification is material, the customer impact assessment is assessed and relevant, and that dependency is explicitly associated with at least one selected, connected repository. A database trigger writes to a durable dispatch queue; the separate five-minute Trigger dispatcher enqueues work so repository inspection cannot delay source monitoring or customer-impact assessment.

The current engine (`preflight-v1`) derives at most five bounded search terms from the affected entities and public provider evidence, searches at most five selected repositories and eight candidate files per repository, and fetches candidate contents pinned to the exact default-branch commit SHA. A file is capped at 256 KB. A GitHub search result is only a candidate: exact entity evidence must be rechecked in the content at the pinned SHA. Incomplete provider responses, revoked access, missing repositories, repository-limit truncation, or unavailable evidence degrade the run to `partial`/`inconclusive`; they never become a verified no-impact result.

Generated, vendor, build, minified, binary, secret/config credential files such as `.env*`, and key/certificate files are excluded. Source bodies are not persisted. Only repository identity, SHA, redacted path, line, a bounded explanation, and a SHA-256 evidence fingerprint are stored. Secret-shaped values are redacted before fingerprints are derived. Transient network failures, timeouts, HTTP 429/5xx responses, and incomplete GitHub search responses fail the task for bounded Trigger.dev retries; revoked access and known bounded-result truncation persist as partial/inconclusive. M7 does not send repository content to OpenAI; AI interpretation can be added later behind a separate strict schema and redaction boundary. Repository text, comments, and provider evidence are treated only as data.

Comments and documentation references are `likely`, never production-verified. `verified` requires an exact affected entity in active repository/configuration evidence at the recorded commit. Package version evidence is verified only when `package.json` contains the affected package below an explicit minimum version from the provider evidence or matches an explicitly affected version. Dates are extracted only from explicitly labeled ISO dates in provider evidence; otherwise they remain null. No unlabeled date or date inferred from general prose is accepted.

## Read model

`GET /api/preflight/impact/{impactAssessmentId}` returns the customer impact alongside the latest Preflight run, dependency, change evidence, dates, repositories scanned, findings, complexity, and whether grounded remediation is available. `GET /api/preflight/{preflightRunId}` reads one run. Both require a signed-in workspace member; RLS keeps rows private. A queued/running/partial/inconclusive state is not described as verified.

The result schema is strict Zod. A finding binds workspace, repository, exact commit SHA, path, line range, affected entity, verification level, and evidence fingerprint. The unique run identity includes the impact assessment, selected repository commit set, change/context fingerprint, and engine version. Repeated inputs reuse the same run; new commits or engine versions create a new historical run.

## Generate Fix and draft pull requests

`POST /api/preflight/{preflightRunId}/remediation` is member-authorized and idempotent. It requires a completed `verified` result and at least one verified finding. It returns grounded migration guidance and the exact repository/path/commit evidence set. It does not invent a replacement model or parameter when the authoritative change evidence does not name one, and therefore does not claim that a code patch was prepared. In that case `patchPrepared` and `draftPullRequestAvailable` are false.

The remediation boundary validates unified diff paths against verified files and rejects stale commits, ungrounded paths, test/CI/policy files, secret-shaped values, test removal, security-control weakening, and unrelated changes. A grounded guidance proposal is persisted without copying source files; a bounded patch artifact may be stored only when a future safe deterministic codemod produces it. Proposals are tied to the exact base commit.

`prepareDraftPullRequest` defines and tests the future sequence: create `auterim/fix/<fingerprint>` from a pinned base SHA, apply only the validated patch, commit, and open a draft PR against the repository's normal default branch. It has no merge or deploy operation. M7 includes only a mock provider for this workflow. No live repository write credentials or write adapter are configured, so no real branch, commit, or PR is created. A stale/revoked repository must be reauthorized and re-preflighted before any future patch or PR.

## Value events

The database records deduplicated `automatic_preflight_started` when a worker claims a run and `preflight_completed` when results commit. A complete run may also emit `verified_risk_found` or `verified_risk_not_found`; partial/inconclusive runs never emit a not-found event. `remediation_generated` is recorded when grounded guidance is prepared. `draft_pr_prepared` is reserved for the live workflow and is not emitted by the mock. No saved money, hours, or incidents prevented are estimated.

## Evaluation and live settings

`npm run eval:preflight` runs deterministic fixtures and local PostgreSQL migration/RLS tests. `npm run eval:preflight:live` is opt-in with `AUTERIM_PREFLIGHT_LIVE=1` and requires the GitHub App plus a specifically named fixture repository owned by `michelpronkk-oss` whose name begins `auterim-preflight-fixture`, with repository/installation IDs, branch, and one known marker configured locally. It performs at most one repository search on that one fixture; it makes no OpenAI call and writes no database data. If no such dedicated fixture is configured, the live test is skipped. Never point it at customer repositories.

## Plan boundary

Milestone 8 gates repository connection, repository protection, automatic Preflight, and safe Generate Fix proposal creation through the centralized workspace entitlement service. Database enqueue, dispatch, claim, and result persistence checks prevent stale queued work from bypassing expired or downgraded access. Business can request automated remediation and Draft PR preparation, but this milestone does not implement those execution paths. No autonomous patching, CI execution, auto-merge, or production deployment is enabled.
