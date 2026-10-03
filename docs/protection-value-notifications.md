# Protection value and notifications

Milestone 9 adds server read models and a durable notification inbox. These contracts support a future dashboard; they do not implement the dashboard UI, uptime monitoring, or marketing email.

## Read-model API

`GET /api/protection?workspaceId=<uuid>&view=today|dependencies|changes|actions|report` requires an authenticated workspace member. `days` accepts 1–366 and defaults to 7. The server establishes the time window in UTC. Dependency and change pages are capped at 25 and use opaque keyset cursors; notification pages are capped at 50. Changes support `relevant=true`, `verified=true`, and `unresolved=true` filters. Do not pass client timestamps as aggregation boundaries.

`GET /api/notifications?workspaceId=<uuid>&unread=true&limit=20&cursor=...` returns the workspace inbox and unread count. `PATCH /api/notifications` accepts either `{workspaceId, notificationId}` or `{workspaceId, markAllRead:true}`. Related IDs are navigation references, not authorization tokens.

`PUT /api/notifications/preferences` updates `{workspaceId, inAppEnabled, emailEnabled}`. These channel preferences extend the existing M6 notification settings; event priority preferences remain unchanged.

Today returns `all_protected` only when onboarding is active and there are no derived actions or unresolved Preflight risks. `setup_incomplete` and `attention_required` remain explicit states. Coverage counts come from enabled `source_catalog` rows attached to currently monitoring workspace dependencies. A source is not called baselined until a global snapshot exists; the read model does not label an old snapshot fresh.

## Canonical protection funnel

All period metrics are UTC half-open windows `[periodStart, periodEnd)`, capped at 366 days.

| Metric                                       | Definition / source                                                                                                                                                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checksCompleted`                            | Distinct `(source_id, trigger_run_id)` successful terminal scan executions (`success`, `unchanged`, `changed`, `not_modified`) for enabled sources of dependencies monitoring now. Attempts are excluded by the stable trigger run ID. |
| `changesDetected`                            | Distinct source changes created in the window on those currently covered sources. This is a conservative current-coverage attribution because historical dependency coverage intervals are not stored.                                 |
| `noiseFiltered`                              | Classified non-material global changes on currently covered sources, plus distinct tenant assessments explicitly marked irrelevant. A global material change alone never creates a tenant notification.                                |
| `materialChanges`                            | Distinct global source changes with a latest eligible semantic classification marked material, on currently covered sources.                                                                                                           |
| `customerRelevantChanges`                    | Distinct classification IDs with an assessed, relevant impact for a currently monitoring workspace dependency, filtered by source-change creation time and latest eligible classification.                                             |
| `automaticPreflights`                        | Deduplicated `automatic_preflight_started` protection-value events.                                                                                                                                                                    |
| `verifiedRisks`                              | Deduplicated `verified_risk_found` protection-value events.                                                                                                                                                                            |
| `likelyRisks`                                | Completed or partial Preflights explicitly reporting `likely`.                                                                                                                                                                         |
| `inconclusivePreflights`                     | Completed or partial Preflights explicitly reporting `inconclusive`; never described as no-risk.                                                                                                                                       |
| `remediationsGenerated` / `draftPrsPrepared` | Existing deduplicated protection-value events, not proposal retries.                                                                                                                                                                   |
| `unresolvedRisks`                            | Completed or partial Preflights whose result is `verified` or `likely`. There is no general risk-resolution model yet, so these remain unresolved.                                                                                     |
| `unresolvedCriticalRisks`                    | Verified Preflight runs for dependencies whose persisted context is both `critical` and `production_critical`. Missing criticality is not inferred.                                                                                    |

Global scan counts do not imply customer impact. Since historical source-coverage periods are unavailable, scan/change counts use current protected coverage and are deliberately documented as conservative attribution. Metrics are evidence counts, not incidents prevented, money saved, or hours saved.

The Milestone 8 initial assessment is returned as an immutable activation-time watermark. Its legacy `current_global_baselines` field is exposed as `snapshotsObservedAtActivation`; it proves a snapshot existed by activation, not that the snapshot was fresh. Later read models do not rewrite this record or treat a pre-activation change assessed afterward as newly detected.

## Surface contracts

- **Today:** lifecycle state, actual protection coverage, bounded attention/actions, upcoming evidence-backed deadlines, relevant impact records, period summary, and immutable initial assessment.
- **Dependencies:** confirmed monitored workspace dependencies, catalog identity, persisted context, enabled global-source coverage, baseline presence, last observed scan, latest impact, and precise states (`protected_and_quiet`, `attention_required`, `incomplete_coverage`, `baseline_pending`, `access_problem`, `unsupported`). Quiet means a successful scan and baseline exist; absence of data is not healthy.
- **Changes:** tenant impact assessments joined to their dependency and semantic classification. Raw global changes are not surfaced without tenant linkage. Verified and unresolved views remain distinct from `likely`, `not_found`, and `inconclusive` Preflight results.
- **Actions:** derived from actionable relevant impacts, verified/likely findings, and revoked repository connections. The list does not invent generic tasks. The API is bounded; callers should use the change/dependency lists for browsing history.
- **Protection report:** the same canonical metrics and UTC period as Today, plus current attention/deadline evidence. No speculative savings claims.

## Notification domain and preferences

Notifications are high-signal and deduplicated by `(workspace_id, dedupe_key)`. The first events are assessed customer-relevant material changes, verified Preflight risks (Pro/Business and active trial only), and 3-day/1-day upcoming deadlines for assessed relevant changes. A global classification by itself is not customer-facing. Priority is `critical`, `high`, or `normal`; `critical` is reserved for verified risk with explicitly critical, production-critical dependency context.

Milestone 6 workspace preferences are extended with `in_app_enabled` (default on) and `email_enabled` (default off); no parallel preference table exists. Existing `critical_changes`, `important_changes`, and informational settings remain authoritative. Email intents are queued only for instant preference modes. Digest/report preferences are persisted, but digest/report delivery is not implemented here.

The in-app inbox is workspace-shared and member-readable. Members can mark a notification read; inserts and content updates are service-managed. Email recipients are current workspace owners/admins with a confirmed Auth email, resolved by the database. Client-supplied addresses are never accepted. Membership, verification, and preferences are rechecked at dispatch.

## Email delivery and deadline policy

The outbox uses unique `(notification_id, recipient_user_id, channel)` rows, bounded batches (50 per claim, at most 100 per task run), 5 attempts, leases, and capped retry delay. Permanent provider failures stop; transient failures retry. Resend receives a stable idempotency key per delivery and stable title/summary payload. Stored/logged errors are fixed categories; recipient addresses, bodies, provider payloads, source text, paths, code, and secrets are not logged. Only curated concise metadata is sent.

Resend requires server-side `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and explicit `AUTERIM_NOTIFICATION_EMAIL_LIVE=1` (default `0`). If any is absent, the Trigger dispatcher creates deadline inbox notifications but leaves email delivery pending; it does not fake delivery. No live email was sent during development. Deadlines currently use persisted Preflight `deadline` dates and 3-day/1-day windows, deduped per Preflight and threshold. The source deadline is evidence-derived and is presented as an upcoming date, not a guaranteed vendor deadline.

## Entitlements

Core supports relevant-change and deadline notifications. Verified Preflight risk notification creation requires an active Pro/Business plan or trial. Existing history remains readable after downgrade, but delivery is not manufactured for a Pro-only event. Automatic remediation is not added.

## Security and scale

Every tenant read model first checks current membership; SQL summary/coverage and mark-read RPCs repeat the membership check. RLS protects inbox rows and notification deliveries are service-role only. Composite workspace foreign keys prevent attaching another tenant's dependency, assessment, Preflight, or value event. Read pages have hard limits and cursor ordering uses `(created_at, id)` or `(assessed_at, id)`. Summary aggregation is bounded to at most one year, uses existing workspace/source indexes, and does not query per dependency in a loop.

The Trigger dispatcher runs every 15 minutes in UTC, creates a bounded due-deadline batch, and claims at most 100 delivery intents. Provider delivery is disabled until a sender and API key are configured. Normal tests use no live provider.
