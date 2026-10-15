# M15.75B Intelligence Router

The Intelligence Router converts a completed, provider-neutral intelligence decision and its final Auterim policy state into one durable internal route intent. Jev supplies probabilities and a proposed route; it cannot invoke customer-facing actions or override Auterim policy.

## Versions and canonical routes

- Router version: `intelligence-router-v1`
- Existing route taxonomy remains canonical: `docs_noise`, `deprecation`, `breaking_api_change`, `auth_or_security_change`, `schema_or_contract_change`, `pricing_change`, `limits_or_quota_change`, `sdk_change`, `webhook_or_event_change`, `feature_change`, `availability_or_runtime_change`, `terms_or_policy_change`, and `uncertain`.
- The product brief's descriptive aliases map to existing values: SDK/dependency change → `sdk_change`; runtime/availability change → `availability_or_runtime_change`; feature/capability change → `feature_change`.

## Policy and route states

The router uses the persisted `proposed_policy_state` and `policy_reason`:

- `suppress_candidate` creates a terminal `suppressed` intent only for complete, non-critical `docs_noise`. Database checks reject uncertain or non-documentation suppression.
- `continue_candidate` creates a typed `pending` intent. A target is recorded from the route taxonomy, but no analysis is claimed to have run when that subsystem does not yet exist.
- `escalate` and `insufficient_evidence` create a queued `evidence_escalation` target regardless of the proposed category. This is the only downstream task implemented in this milestone.

Route targets are deterministic: deprecation → dependency/product impact; breaking API → dependency impact/repository exposure candidate; auth/security → integration/auth risk; schema → contract exposure; pricing → commercial impact; limits → capacity risk; SDK → repository dependency exposure; webhook/event → contract/repository exposure; runtime → runtime-risk candidate; feature → product relevance; terms/policy → provider policy review. These targets are typed intents, not promises that an unimplemented subsystem has executed.

## Durable records and idempotency

`change_intelligence_decisions.response_model` records the provider's actual response model when available and remains nullable. `policy_reason` stores the bounded, canonical Auterim reason. `intelligence_route_intents` references the immutable decision and source change, and stores policy/engine/router versions, provider and requested/response models, canonical route, typed target, state, reason, evidence fingerprint, attempt/run metadata, and timestamps.

The route identity is `(source_change_id, intelligence_decision_id, policy_version, router_version)`. The downstream idempotency key is `intelligence-router-v1:` plus the MD5 of those canonical identity components. A durable claim lease prevents concurrent dispatch. Trigger idempotency covers recovery after child enqueue succeeds but before the route record is acknowledged. Replaying a completed intelligence decision re-enqueues the router task, closing the crash gap between decision persistence and router enqueue.

## Bounded evidence escalation

`intelligence_evidence_escalations` permits at most three attempts. A lease allows recovery after a worker crash. The worker reads only bounded head/tail excerpts from immutable source snapshots and a capped deterministic diff, recomputes line/evidence coverage, and stores a small summary, marker list, and fingerprint. It does not call Jev again, mutate source truth, or retain excerpts in the route record. Incomplete bounded evidence terminates as `insufficient_evidence`; complete evidence terminates as `completed`. Exhausted retries are terminal.

## Trigger boundary and activation

`evaluate-source-change-intelligence` persists the decision, then triggers `route-source-change-intelligence`. That task persists/reconciles the route and dispatches `escalate-source-change-evidence` only for the escalation target. Both tasks use bounded retries and concurrency. The activation flag `AUTERIM_INTELLIGENCE_ROUTER_ENABLED` defaults to `0`; `1` enables only this internal route pipeline. Customer impact, Preflight, notifications, remediation, auto-PR, and billing are not connected to these tasks.

## Data access

The route and escalation tables use RLS and have no client grants; only `service_role` has table/function privileges. Functions are `SECURITY INVOKER`, use an empty search path, validate bounded inputs, and do not grant execution to public, anonymous, or authenticated roles. No workspace fan-out is involved because source-change intelligence is global; `workspace_id` is nullable for future scoped provenance.

## Adding a future route worker

Add a typed target to the canonical mapping and schema constraint, implement a separate bounded Trigger task, and make dispatch conditional on the final persisted Auterim policy state. Use the route identity and idempotency key above, persist a claim/lease and terminal result, and prove replay and crash recovery before enabling that target. Never let provider output select an executable task ID or perform customer actions.
