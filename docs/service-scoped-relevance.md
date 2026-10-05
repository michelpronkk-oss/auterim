# Service-scoped relevance foundation

## Current behavior

Auterim protects workspace dependencies. A workspace dependency is the tenant relationship to one provider in `dependency_catalog`; `dependency_context` and impact assessments are scoped to that relationship. A workspace does not yet have a normalized customer service or product model, nor a mapping from a service to the dependencies it uses. The launch-plan phrase “protected products” therefore describes package positioning and is not currently a separately enforced service count.

Provider monitoring remains global. `source_catalog`, source scans, snapshots, changes, and classifications are shared across workspaces. Customer impact work is scoped to confirmed workspace dependencies and does not create customer-specific scans or duplicate snapshot bodies.

## Future data model

Introduce a tenant-private `workspace_services` table with a workspace foreign key, bounded name and slug, status, and optional customer-provided criticality. Add `workspace_service_dependencies` as an explicit join from a service to a confirmed `workspace_dependencies` row. Carry `workspace_id` on the join and enforce composite foreign keys so a service cannot reference a dependency from another workspace. Keep the join unique by service and workspace dependency. Any role or usage context on the join must be explicitly supplied by an authorized member; public discovery must never create service mappings automatically.

Keep `workspace_dependencies` as the provider-protection and dependency-quota unit. A future service count is a separate entitlement and must be represented and enforced separately from dependency quotas (Core/Pro/Business dependency capacities remain 20/75/250). Repository capacities are separate again (Core/Pro/Business 0/5/25).

## Relevance and evidence

Derive service coverage through service → explicit dependency mapping → confirmed workspace dependency → global `dependency_id` → enabled global source catalog. Do not copy snapshots, source bodies, or global change records into tenant service tables. Unmapped services should report an honest unknown/unmapped state. Preserve the existing one-assessment-per-workspace-dependency identity until measured evidence justifies service-specific fan-out; generating one model call per mapped service could multiply cost and alter assessment idempotency.

Future impact read models may aggregate explicitly mapped service context with fixed bounds and report the service mapping provenance. They must not imply causality from temporal proximity alone or use public website discovery as customer truth.

## Migration sequence

1. Add tenant-scoped service and service-dependency tables with RLS and composite workspace constraints.
2. Add owner/admin-only service and mapping operations; members may read only workspace-authorized records.
3. Add service-count entitlements centrally, preserving the independent dependency and repository limits.
4. Add service-aware read models and bounded relevance evaluation only after tests demonstrate useful precision without duplicating global monitoring or unbounded model fan-out.
