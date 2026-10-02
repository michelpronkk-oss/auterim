Database implementation is intentionally blocked until the dedicated Auterim Supabase environment is explicitly configured.

# Database plan (design notes only)

This document describes candidate concepts. It does not define a schema. No SQL or generated database types belong to this milestone.

## Candidate entities

| Entity                     | Scope  | Purpose and expected relationships                                                    |
| -------------------------- | ------ | ------------------------------------------------------------------------------------- |
| `workspaces`               | Tenant | Tenant root; owns workspace members and selected dependencies.                        |
| `workspace_members`        | Tenant | Joins users to workspaces with membership state and future roles.                     |
| `companies`                | Tenant | Company identity associated with a workspace.                                         |
| `company_context`          | Tenant | Company-specific operating context used when assessing impact.                        |
| `dependency_catalog`       | Global | Canonical catalog of external providers such as payment or infrastructure services.   |
| `source_catalog`           | Global | Authoritative sources for one catalog dependency; each has a source category and URL. |
| `workspace_dependencies`   | Tenant | Joins a workspace to selected catalog dependencies.                                   |
| `dependency_context`       | Tenant | Workspace-specific notes and usage context for a selected dependency.                 |
| `scan_runs`                | Global | Tracks a fetch attempt for a source, including outcome and timing.                    |
| `source_snapshots`         | Global | Stores normalized observations and hashes for a source over time.                     |
| `source_changes`           | Global | Records deterministic differences between successive snapshots.                       |
| `impact_assessments`       | Tenant | Relates a global change to a workspace dependency and its context.                    |
| `recommended_actions`      | Tenant | Suggested response associated with a tenant impact assessment.                        |
| `notification_preferences` | Tenant | Workspace or member delivery preferences.                                             |
| `notifications`            | Tenant | Delivery state and references to the tenant impact/action that prompted it.           |
| `feedback_events`          | Tenant | Customer feedback about detected changes, assessments, or recommendations.            |
| `usage_events`             | Tenant | Metering events associated with a workspace.                                          |

## Relationships and invariants to decide

- A source belongs to one global dependency; snapshots and scan runs belong to one source.
- A source change is derived from a pair of snapshots and should be uniquely identified by the source and snapshot pair (or an equivalent stable change key).
- A workspace selects a catalog dependency at most once; dependency context belongs to that selection.
- A tenant impact assessment ties one global change to one workspace dependency. Retries must not create duplicate assessments for the same change and selection.
- A notification should have a stable idempotency key for its assessment, channel, and intended recipient.
- Fetch and job retries should reuse stable run/idempotency identifiers where the provider supports it.
- Global source observations must not contain tenant-specific context. Tenant-owned records must carry an explicit workspace relationship.

Exact keys, deletion behavior, retention, and uniqueness constraints should be settled during schema design against the verified Auterim project.

## Why RLS matters

Tenant records may be reachable through client-facing APIs. RLS should enforce workspace membership and row access in the database in addition to server-side authorization. Policies must be designed per operation and role; an authenticated session or a caller-provided workspace ID alone does not establish access. Any privileged server key bypasses RLS protections and therefore must stay server-only and be used narrowly.
