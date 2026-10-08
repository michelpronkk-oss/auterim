# Onboarding backend and activation

## Product onboarding V2

The `/app/onboarding` consumer now presents a Product-centered, resumable flow. It uses the existing workspace as the Company/security/billing boundary and keeps `workspace_onboarding` as the compatibility lifecycle. Product progress is stored independently in `product_onboarding_progress`, keyed by `(workspace_id, product_id)`, with server-owned stage, completed-stage history, bounded milestone timestamps, and update time. Closing a browser or signing out does not lose the stage. Starting the same Product again is idempotent; archived Products cannot be resumed. Active workspace owners/admins can open Product protection from Account to add another Product or inspect Product-scoped protection; active workspaces do not return to the initial onboarding route.

The ordered stages are `scan_import → company → product → discovery → dependency_confirmation → protection_graph → strengthen_protection → activation → complete`. The V2 transition RPC accepts only the same stage, the immediately next stage, or one safe previous stage. It rechecks workspace membership and Product ownership, prevents activation while company discovery is running or candidates remain unresolved, and requires a confirmed dependency for activation. Already-protected Products resume as complete. Existing activated workspaces leave onboarding for `/app` and retain the legacy account/billing screen.

`GET /api/onboarding/v2?workspaceId=…&productId=…` returns a private/no-store Product read model: Company, Product, persisted progress, public discovery candidates, Product dependencies, the actual Product Protection Graph, Product repository state, bounded deterministic recommendations, and the future CLI insertion point. It consumes the existing Product repository and graph contracts; neither API returns code bodies or raw source bodies. The future `npx auterim connect` insertion point is discovery. The CLI is not required and no CLI evidence is fabricated in V2.

`POST /api/onboarding/v2` supports `start`, adjacent `transition`, and `activate`. Candidate decisions and manual dependency additions call the existing Product dependency API, so a discovery candidate remains a public observation until a user confirms it for a specific Product. Unknown providers return the existing unsupported-dependency result; no uncontrolled catalog identity or monitoring source is created. Context and notification preferences reuse the existing workspace dependency-context and workspace notification-preference models.

Recommendations are deterministic and evidence-backed: unresolved discovery candidates, missing confirmed dependencies, entitled GitHub verification without a mapped repository, and actual baseline coverage state. They do not infer capability from a provider logo or claim OAuth itself is protection evidence. The graph reports actual enabled catalog sources, observed shared baselines, current Product repositories, and verification availability. Coverage is never represented as a percentage.

Activation of the default Product continues through `activate_workspace_protection`; it now enables dependencies and computes baseline coverage only for that default Product. This preserves the one-time workspace activation transition and its five-day Pro trial trigger. Additional Product activation requires the workspace already be active, owner/admin permission, the persisted V2 activation stage, at least one Product dependency, settled discovery, and no unresolved company candidates. It updates only that Product's dependency relationships and creates/reuses global `baseline_scan_queue` rows. The existing bounded claim/dispatch path is invoked immediately after activation; transient dispatch failures leave durable queue state for global recovery and never roll back protection. The onboarding claim wrapper introduces queue work only for dependencies on already-protected Products. Global snapshots remain global and are never copied into tenant tables. Activation retries preserve the original Product/workspace timestamps and trial.

Funnel/retention remains grounded in the existing protection value, impact, Preflight, repository, remediation, and resolution history. V2 does not add a parallel analytics store or fabricate first-value metrics. The server persists stage milestone timestamps for later measured QA timing. Current styling is technical acceptance UI; premium visual design remains deferred to the later UX pass.

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

The read model counts confirmed workspace dependencies and distinct enabled rows in the real global `source_catalog`, grouped by source type. Product coverage includes only dependencies whose monitoring is enabled; disabled dependencies remain visible in the graph but do not contribute source coverage. It does not estimate missing coverage or count disabled catalog sources. The display aliases `documentation` and `api` to `api_docs`, and `deprecation` to `deprecations`; other catalog types retain their catalog names. Providers with no curated enabled sources contribute zero. Coverage stays global: each provider source is monitored once for all workspaces.

## Activation and baseline

`POST /api/onboarding/activate` calls the idempotent activation operation. It requires owner/admin membership, completed required steps, and at least one confirmed dependency. The transaction records the activation timestamp, enables monitoring for workspace relationships, and ensures one shared baseline-queue row per enabled global source without copying snapshot bodies into tenant tables. The response includes confirmed dependency count, actual enabled authoritative source count, critical dependency count, and `ready`, `in_progress`, or `partial` baseline status. That baseline status describes whether each covered global source has any recorded snapshot; it has no freshness window and is not a health claim. Later scan outcomes appear separately in the Protection Graph.

Existing snapshots satisfy initial baseline coverage and do not create tenant snapshots or another baseline scan. A source with no snapshot and no recent pending scan becomes eligible in the global queue. The Account initial assessment is an immutable workspace-wide activation-time count of source snapshots created by activation; the Product Graph count is the number of enabled source rows for that Product that currently have a latest recorded global snapshot. The counts may differ because their scope and observation time differ. Neither count implies freshness or successful current health. The activation endpoint claims a bounded batch and dispatches the existing global `scan-source` task using a stable Trigger.dev idempotency key bound to the queue claim and dispatch attempt. A successful claim returns the queue/source IDs, dispatch attempt, and lease-recovery count. An RPC error is logged as `claim_rpc_error`; a successful empty array is separately logged as `empty`. Both remain non-blocking for activation.

## Product funnel events

The existing first-party Growth event table records deterministic, one-time onboarding milestones: `product_selected`, `dependency_confirmed`, `protection_graph_viewed`, `protection_activation`, and `first_grounded_value`. Event keys are SHA-256 hashes of the event type and stable internal identity; raw workspace/Product identifiers and customer payloads are not stored in the event row. Events are best-effort and never block onboarding. `first_grounded_value` is recorded only when the Product has a confirmed dependency and at least one enabled authoritative source in its Protection Graph; Product creation or a page view alone does not qualify.

The queue state machine is `queued → dispatching → dispatched → complete`, with bounded retry states returning to `queued` or ending in `failed`. If idempotency-key creation fails before any Trigger request, the reservation is released with a five-minute retry delay. If the Trigger request has an ambiguous result or its run ID cannot be marked, the lease is retained; reclaim reuses the same claim ID and attempt idempotency key. Expired dispatch leases are reclaimed up to three times for the same attempt. Dispatched runs with no recent pending scan are also recoverable after a 15-minute grace period. Repeated scan/dispatch failures are bounded to five logical dispatch attempts; exhausted work becomes `failed` and coverage remains `partial` rather than being represented as protected.

The existing daily global `dispatch-source-scans` task calls `claim_due_baseline_sources` independently of activation, creating missing queue rows from active protected dependencies and reconciling queued/failed/expired work. It dispatches the same global `scan-source` task, then handles other due sources and classifications. Recovery therefore does not depend on a customer revisiting onboarding. Scan-run and snapshot database triggers are authoritative for `complete`; no tenant snapshot is created. If a fast scan completes before its dispatch acknowledgement is recorded, the late acknowledgement fills the queue's missing Trigger run ID without reopening completed work; the forward migration also repairs the observed OpenAI pricing row from its successful scan record. `source_snapshots` remains unique by source/version and source/scan run, while the scan result RPC serializes source writes and reuses the current snapshot for unchanged content. Trigger retries and reclaimed accepted dispatches preserve the claim idempotency identity, preventing duplicate logical baseline work.

Structured baseline telemetry contains workspace (when initiated by onboarding), source, queue item, stage, safe error category, attempt count, lease-recovery count/state, and accepted Trigger run ID. It never contains provider content or credentials. Trigger task errors and database claim errors are distinct from a valid empty claim. Existing HTTP fetch SSRF, redirect, content-type, byte, and deadline checks are unchanged.

The OpenAI API pricing source keeps its existing `source_catalog` identity while using `https://developers.openai.com/api/docs/pricing`. Updating the URL clears validators and last-check timestamps so the new official source is fetched afresh; existing scan runs, snapshots, and source changes are preserved. The URL change itself does not write a scan, snapshot, or provider change event.

## Authorization and idempotency

All onboarding APIs require a non-anonymous authenticated Supabase user and use a publishable-key client carrying that user's bearer token for tenant operations. Starting onboarding in an existing workspace and activating protection require owner/admin; other onboarding operations require workspace membership. Tenant read tables have member-scoped RLS. Direct client writes to onboarding, preferences, provenance links, discovery, and global baseline queue are revoked. A narrow service-role client is used only after bearer verification for company create/reuse and Trigger dispatch claim/mark/release RPCs; those RPCs independently check the explicit actor ID against workspace membership/role, and tenant roles cannot call them directly or poison shared queue state.

Idempotency is enforced by database uniqueness, row locks, upserts, stable workspace/dependency identities, one activation row/timestamp, one baseline row per global source, dispatch leases, and Trigger.dev idempotency keys. Candidate evidence remains separate from user decisions and tenant protection state.

The current onboarding APIs are a compatibility bridge to each workspace's existing default Product. Product-aware consumers must use explicit Product IDs and the canonical Product dependency, repository, and Protection Graph contracts. See [Product protection compatibility](product-compatibility.md) for the ownership rules and legacy-to-canonical mapping.

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

## Company membership

`workspace_members` remains the single membership model: one row per workspace/user, with the existing `owner`, `admin`, and `member` roles. The existing account selector reads this table for the signed-in user and validates the saved workspace ID against that current membership list, so a new membership appears through the existing selector without a second company-switching mechanism.

Settings owners and admins can view their company's member email/role roster and submit one exact email through `POST /api/account/members`. The operation only authorizes an existing email-confirmed Auterim account, assigns the fixed `member` role, does not send an email or create an account, and is idempotent. The response intentionally does not reveal whether the address is unknown or already belongs to the company. Authenticated clients cannot write `workspace_members`; a server-only RPC checks the verified actor's current owner/admin role again before changing membership. The roster RPC is also service-role-only and performs the same actor/workspace check.

Non-existing-account email invitations are deferred; the interface explicitly describes this as adding an existing account and never claims an invitation was sent. Membership does not copy product/dependency state or merge billing, trials, usage, or limits. Every read and write remains scoped to the selected company and existing member authorization checks continue to protect cross-company resources.
