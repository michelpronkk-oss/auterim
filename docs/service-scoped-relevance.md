# Service-scoped relevance foundation

## Current behavior

Auterim protects workspace dependencies. A workspace dependency is the tenant relationship to one provider in `dependency_catalog`; `dependency_context` and impact assessments are scoped to that relationship. `workspace_products` is the separately enforced protected-product portfolio and entitlement unit. Each product may have many `workspace_product_surfaces` (website, app, docs, API, status, or other); surfaces do not consume additional product slots. Existing workspace dependencies retain their IDs and are backfilled to the workspace's default product. New dependencies created through the legacy onboarding operations also attach to that default product unless a future product-aware operation supplies a different product explicitly.

Provider monitoring remains global. `source_catalog`, source scans, snapshots, changes, and classifications are shared across workspaces. Customer impact work is scoped to confirmed workspace dependencies and does not create customer-specific scans or duplicate snapshot bodies.

## Future data model

Keep `workspace_products` as the billable portfolio boundary: Core 1, Pro 3, Business 10. Draft and protected products reserve one slot; archived products preserve history and release their slot. Archive is a soft lifecycle transition: it disables that product's dependency monitoring, keeps impact/Preflight/remediation history, and never moves history to a replacement product. Product replacement is an explicit transaction that archives the old product and creates a new product; it does not silently transfer dependencies, repositories, or context. A workspace always retains a default product for existing onboarding calls, and archiving the only/default product requires a replacement so those compatibility APIs cannot become detached.

For finer runtime/service context, introduce a tenant-private `workspace_services` table scoped by workspace and (where applicable) product, with a bounded name and slug, status, and optional customer-provided criticality. Add `workspace_service_dependencies` as an explicit join from a service to a confirmed `workspace_dependencies` row. Carry `workspace_id` and `protected_product_id` on the join and enforce composite foreign keys so a service cannot reference a dependency from another workspace or product. Keep the join unique by service and workspace dependency. Any role or usage context on the join must be explicitly supplied by an authorized member; public discovery must never create service mappings automatically. Services are a finer-grained mapping and do not consume protected-product slots.

Keep `workspace_dependencies` as the provider-protection, context, and dependency-quota unit. Dependencies now belong to one product, and provider uniqueness is product-scoped so the same provider can have separate context and history under separate products. The dependency quota remains separate from the product count (Core/Pro/Business dependency capacities 20/75/250). Repository capacity remains separate (Core/Pro/Business 0/5/25); GitHub installation and repository inventory stay workspace-level, and the existing repository-to-dependency mapping derives product scope through the dependency.

## Relevance and evidence

Derive product/service coverage through product → confirmed workspace dependency → global `dependency_id` → enabled global source catalog, then service → explicit dependency mapping within that product. Do not copy snapshots, source bodies, or global change records into tenant product/service tables. Unmapped services should report an honest unknown/unmapped state. Preserve the existing one-assessment-per-workspace-dependency identity; product-specific dependency rows already separate contexts, while generating one model call per mapped service could multiply cost and alter assessment idempotency.

Future impact read models may aggregate explicitly mapped service context with fixed bounds and report the service mapping provenance. They must not imply causality from temporal proximity alone or use public website discovery as customer truth.

## Migration sequence

1. Add tenant-scoped service and service-dependency tables with RLS and composite workspace/product constraints.
2. Add owner/admin-only service and mapping operations; members may read only workspace-authorized records.
3. Keep product entitlements central, and preserve the independent dependency and repository limits; service count is not an additional plan quota.
4. Add service-aware read models and bounded relevance evaluation only after tests demonstrate useful precision without duplicating global monitoring or unbounded model fan-out.
