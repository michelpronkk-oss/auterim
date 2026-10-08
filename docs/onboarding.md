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

Existing snapshots satisfy baseline coverage and do not create tenant snapshots or another baseline scan. A source with no snapshot and no recent pending scan becomes eligible in the global queue. The activation endpoint claims a bounded batch and dispatches the existing global `scan-source` task using a stable Trigger.dev idempotency key bound to the queue claim and dispatch attempt. A successful claim returns the queue/source IDs, dispatch attempt, and lease-recovery count. An RPC error is logged as `claim_rpc_error`; a successful empty array is separately logged as `empty`. Both remain non-blocking for activation.

The queue state machine is `queued → dispatching → dispatched → complete`, with bounded retry states returning to `queued` or ending in `failed`. If idempotency-key creation fails before any Trigger request, the reservation is released with a five-minute retry delay. If the Trigger request has an ambiguous result or its run ID cannot be marked, the lease is retained; reclaim reuses the same claim ID and attempt idempotency key. Expired dispatch leases are reclaimed up to three times for the same attempt. Dispatched runs with no recent pending scan are also recoverable after a 15-minute grace period. Repeated scan/dispatch failures are bounded to five logical dispatch attempts; exhausted work becomes `failed` and coverage remains `partial` rather than being represented as protected.

The existing daily global `dispatch-source-scans` task calls `claim_due_baseline_sources` independently of activation, creating missing queue rows from active protected dependencies and reconciling queued/failed/expired work. It dispatches the same global `scan-source` task, then handles other due sources and classifications. Recovery therefore does not depend on a customer revisiting onboarding. Scan-run and snapshot database triggers are authoritative for `complete`; no tenant snapshot is created. If a fast scan completes before its dispatch acknowledgement is recorded, the late acknowledgement fills the queue's missing Trigger run ID without reopening completed work; the forward migration also repairs the observed OpenAI pricing row from its successful scan record. `source_snapshots` remains unique by source/version and source/scan run, while the scan result RPC serializes source writes and reuses the current snapshot for unchanged content. Trigger retries and reclaimed accepted dispatches preserve the claim idempotency identity, preventing duplicate logical baseline work.

Structured baseline telemetry contains workspace (when initiated by onboarding), source, queue item, stage, safe error category, attempt count, lease-recovery count/state, and accepted Trigger run ID. It never contains provider content or credentials. Trigger task errors and database claim errors are distinct from a valid empty claim. Existing HTTP fetch SSRF, redirect, content-type, byte, and deadline checks are unchanged.

The OpenAI API pricing source keeps its existing `source_catalog` identity while using `https://developers.openai.com/api/docs/pricing`. Updating the URL clears validators and last-check timestamps so the new official source is fetched afresh; existing scan runs, snapshots, and source changes are preserved. The URL change itself does not write a scan, snapshot, or provider change event.

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
