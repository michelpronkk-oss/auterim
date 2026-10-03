# Onboarding backend and activation

Milestone 6 exposes a tenant-scoped backend for the future onboarding UI. It does not implement a visual flow or notification delivery.

## State machine and resume

`workspace_onboarding` stores one resumable lifecycle row per workspace:

```text
company_created → discovery_running → dependencies_review → context_setup
                 ↘                                      → notifications_setup → active
```

Discovery is a prefill step and may be skipped if a customer adds a catalog dependency manually. Dependency review still requires at least one confirmed or manually added dependency. Context and notification details are optional; the customer can explicitly complete each step without filling optional context fields. `activating` is reserved for the activation transaction. The server validates step order and required invariants. An active workspace cannot be reset through onboarding.

`GET /api/onboarding?workspaceId=…` returns a single read model containing the current step, company, discovery run and candidates, confirmed dependencies with context, completion markers, preferences, catalog-derived coverage, and activation/baseline status. `POST /api/onboarding` starts or resumes onboarding. Its caller supplies an idempotency key. The key is bound to a normalized-input fingerprint; replay returns the same workspace/company, while key reuse with different input is rejected. Existing companies are reused by workspace and normalized domain.

## Discovery handoff and decisions

Public discovery evidence and candidate history remain historical records. Discovery never creates a protected dependency. Candidates include the catalog provider/category, confidence and label, evidence summary, and suggested status. Discovery refreshes update only candidates; a confirmed or rejected decision is preserved.

`POST /api/onboarding/dependencies` accepts either a `decision` action (`confirmed` or `rejected`) or a `manual_add` action. Confirmation atomically creates or reuses the unique workspace dependency, records a provenance link to the candidate, and marks the candidate confirmed. Rejection changes only the candidate decision and never creates a workspace dependency. Repeating either operation is safe. If manual add selects a provider already suggested by discovery, the same unique workspace dependency is reused and the decision is linked; manual origin is recorded.

`GET /api/onboarding/dependencies?workspaceId=…&q=…` searches the enabled dependency catalog. `POST` with an unknown slug returns `unsupported_dependency`; it never creates an uncontrolled global provider or arbitrary monitoring configuration.

## Criticality and usage context

Confirmed dependencies default to `criticality=normal` and `production_critical=false`; these are defaults, not claims about customer certainty. `PUT /api/onboarding/dependencies/{id}/context` updates the existing Milestone 4 `dependency_context` row: `criticality`, `productionCritical`, `usedFor`, `contextNote`, and explicitly supplied `usageMetadata`. Omitting context is valid. Values remain workspace-scoped and context revision triggers continue to govern impact reassessment.

## Notification preferences

`PUT /api/onboarding/preferences` persists choices. `criticalChanges` is fixed to `instant`; `importantChanges` supports `daily_digest`, `instant`, or `off`; `informational` supports `off` or `digest`; and `monthlyProtectionReport` is a boolean. Defaults are instant for critical, daily digest for important, off for informational, and no monthly report. Milestone 6 itself did not deliver notifications; Milestone 9 extends this same preference row with `inAppEnabled` and `emailEnabled` and implements only high-signal in-app/instant email events. See [protection value and notifications](protection-value-notifications.md) for delivery semantics.

## Coverage preview

The read model counts confirmed workspace dependencies and distinct enabled rows in the real global `source_catalog`, grouped by source type. It does not estimate missing coverage or count disabled sources. The display aliases `documentation` and `api` to `api_docs`, and `deprecation` to `deprecations`; other catalog types retain their catalog names. Providers with no curated enabled sources contribute zero. Coverage stays global: each provider source is monitored once for all workspaces.

## Activation and baseline

`POST /api/onboarding/activate` calls the idempotent activation operation. It requires owner/admin membership, completed required steps, and at least one confirmed dependency. The transaction records the activation timestamp, enables monitoring for workspace relationships, and ensures one shared baseline-queue row per enabled global source without copying snapshot bodies into tenant tables. The response includes confirmed dependency count, actual enabled authoritative source count, critical dependency count, and `ready`, `in_progress`, or `partial` baseline status. `ready` requires a current global snapshot for every covered source; failures or no available source coverage produce `partial`.

Existing snapshots satisfy baseline coverage and do not create tenant snapshots or another scan. A source with no snapshot and no recent pending scan becomes eligible in the global queue. The activation endpoint claims a bounded batch and dispatches the existing global `scan-source` task using stable Trigger.dev idempotency keys. Queue rows and dispatch claims are global and unique by source; repeat activation does not create duplicate queue rows. Remaining due sources are also eligible for the existing bounded global daily source dispatcher, which processes sources across tenants rather than doing tenant-specific scans. Scan/snapshot triggers update the shared queue ledger. A current snapshot or in-flight scan satisfies baseline work without creating another scan.

## Authorization and idempotency

All onboarding APIs require a non-anonymous authenticated Supabase user and use a publishable-key client carrying that user's bearer token for tenant operations. Starting onboarding in an existing workspace and activating protection require owner/admin; other onboarding operations require workspace membership. Tenant read tables have member-scoped RLS. Direct client writes to onboarding, preferences, provenance links, discovery, and global baseline queue are revoked. A narrow service-role client is used only after bearer verification for company create/reuse and Trigger dispatch claim/mark/release RPCs; those RPCs independently check the explicit actor ID against workspace membership/role, and tenant roles cannot call them directly or poison shared queue state.

Idempotency is enforced by database uniqueness, row locks, upserts, stable workspace/dependency identities, one activation row/timestamp, one baseline row per global source, dispatch leases, and Trigger.dev idempotency keys. Candidate evidence remains separate from user decisions and tenant protection state.

## Endpoints

| Method  | Path                                             | Purpose                                                       |
| ------- | ------------------------------------------------ | ------------------------------------------------------------- |
| `GET`   | `/api/onboarding?workspaceId=…`                  | Read/resume the complete onboarding model                     |
| `POST`  | `/api/onboarding`                                | Create or resume a company and queue fast discovery           |
| `GET`   | `/api/onboarding/dependencies?workspaceId=…&q=…` | Search catalog providers                                      |
| `POST`  | `/api/onboarding/dependencies`                   | Confirm/reject a candidate or manually add a catalog provider |
| `PATCH` | `/api/onboarding/dependencies/{id}/context`      | Save criticality and optional usage context                   |
| `POST`  | `/api/onboarding/steps`                          | Complete the current required step                            |
| `PUT`   | `/api/onboarding/preferences`                    | Persist notification choices                                  |
| `POST`  | `/api/onboarding/activate`                       | Activate protection and dispatch baseline work                |
