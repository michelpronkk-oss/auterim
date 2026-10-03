# Database migration and operational notes

## Source of truth

`supabase/migrations/20261002232050_auterim_monitoring_foundation.sql` is the Milestone 2 schema source of truth. It creates the tenant foundation, global dependency/source catalog, immutable monitoring evidence, security helper functions, RPCs, indexes, and the one OpenAI pricing-source seed. The migration is validated in an in-memory PostgreSQL engine; whether it has been applied remotely is reported in the task completion notes.

Before database/deployment work, run `npm run project:check` and `npm run env:check`. Use only the project ref parsed from this repository's `.env.local`; do not use project listing, auto-linking, or credentials discovered elsewhere. Do not use destructive reset commands against a linked/remote project.

## Tables

Tenant scope: `workspaces`, `workspace_members`, `companies`, `company_context`, `workspace_dependencies`, and `dependency_context`. URL dependency discovery adds workspace-scoped `dependency_discovery_runs`, `dependency_discovery_evidence`, and `discovered_dependencies` candidate rows. Candidates remain separate from confirmed `workspace_dependencies`. Onboarding adds `workspace_onboarding`, idempotent `onboarding_requests`, `workspace_notification_preferences`, and `workspace_dependency_discovery_links`; website URL/domain fields are stored on the tenant company.

Global scope: `dependency_catalog`, `source_catalog`, `scan_runs`, `source_snapshots`, `source_changes`, `source_change_classifications`, and the per-source `baseline_scan_queue` with bounded dispatch claims. Activation creates one global queue row per enabled source that needs its first baseline; it does not create tenant copies of snapshots or scan work.

Tenant tables have workspace membership policies. Authenticated users may select enabled catalog rows. Onboarding writes occur through authenticated RPCs with explicit `auth.uid()` membership checks; onboarding tables have no direct authenticated write grants. The baseline queue is not readable or writable by tenant roles. Global monitoring evidence has no authenticated grants; the service role is the only application role allowed to manage it. Snapshots and changes are immutable by trigger as well as privilege boundary.

## Integrity and concurrency

Foreign keys preserve workspace/source relationships; uniqueness constraints prevent duplicate memberships, dependency selections, source runs per Trigger attempt, source versions, and changes for a new snapshot. Check constraints bound text payloads, HTTP values, statuses, and diff sizes.

`record_source_scan_result` takes a row lock on the source, reads its latest snapshot, and commits snapshot, change, scan result, and source validators together. Concurrent identical results therefore serialize: the first records the new version, and the next observes unchanged content. If another distinct version was recorded while a worker was fetching, the stale worker receives the current snapshot and recalculates its diff before retrying the transaction.

`source_change_classifications` is a service-only interpretation table. Its unique key is `(change_id, classifier_version, schema_version, prompt_version, provider, evidence_fingerprint)`, allowing safe retries for the same immutable evidence and preserving later classifier/prompt/schema versions as separate rows. Model changes must also bump the classifier version. The database trigger creates the initial queued `semantic-v1` row with each source change. RPCs lock the row while claiming work and only accept persistence for the current run/attempt. Output fields, confidence, payload sizes, and state are constrained. Six total claims bound automatic dispatch/retry. RLS is enabled, with all client-role access revoked and service-role access granted.

## Payload and retention

Only normalized text is stored in snapshot rows (maximum 512 KiB); raw fetched bytes are discarded after processing. Move snapshot content to private object storage when captures regularly approach the cap or retention cost requires it. Preserve immutable hashes and byte counts in Postgres and store an object reference in place of inline text in that follow-up migration.

## Deferred

Profiles, invite/member-management flows, notification delivery, retention automation, browser rendering, and large-payload object storage remain deferred. Notification preferences are persisted by onboarding, but no delivery occurs. Customer-specific impact is implemented separately in `customer-impact.md`; global classification contains no tenant or company fields.
