# Protected Product ↔ Repository Foundation

## Ownership

- `repositories` is the workspace-scoped catalog of repositories the connected GitHub installation can access.
- `workspace_product_repositories` is the explicit protection-intent relation between a Protected Product and a repository.
- `workspace_repository_access` remains the dependency-to-repository evidence relationship used by Preflight. A product mapping never substitutes for that evidence edge.
- `repositories.selected_for_protection` is a compatibility mirror for existing callers. It is not an independent source of intent after mapping history exists.

An imported or accessible repository is not protected until an owner or admin explicitly maps it to a protected product. One repository may support multiple products, but quota counts distinct repository IDs once.

## Lifecycle and quota

The canonical server-side operations are `map_repository_to_product` and `unmap_repository_from_product`. They check authenticated owner/admin membership, same-workspace product/repository ownership, protected product state, connected/available repository state, current write entitlement, and quota under a workspace lock. Core does not include repository protection; Pro and Business limits come from the existing entitlement functions.

Mapping requires the existing Preflight execution entitlement, so the billing grace period remains read-only for protection changes even while repository-connection metadata remains visible. The read model reports verification availability from the `automaticPreflight` entitlement.

Archiving a product atomically marks its active repository mappings inactive and recalculates the compatibility flag. Mapping rows remain as history. Archived products cannot be remapped. To protect a repository under another product, an owner/admin must explicitly map it to that protected product.

## Legacy transition

During migration, uniquely evidenced selected repositories are backfilled only when their connection and repository are available and their dependency evidence resolves to exactly one product. Protected products receive active mappings; draft or archived products receive inactive history rows. Ambiguous, unlinked, revoked, or disconnected repositories are not guessed into a product mapping.

For repositories without any mapping history, the temporary quota bridge continues to count `selected_for_protection`. Once mapping history exists, only active mappings on a protected product contribute protection usage; the legacy flag is maintained as a compatibility mirror and cannot independently add usage.

For mapped repositories, the compatibility flag represents active protection intent, not provider access health. A GitHub revocation can leave the flag true for an active mapping, but repository availability and connected-installation checks continue to block Preflight and validation until access is restored.

Retire the bridge in a later compatibility phase: migrate or explicitly resolve remaining legacy-only selections, update every old caller to the product mapping operations, verify production usage parity, then remove `set_repository_protection` compatibility behavior and `selected_for_protection` after no deployed readers or writers remain.

## Preflight compatibility

Preflight resolves an active product mapping first and suppresses legacy fallback whenever mapping history exists. It still requires the existing `workspace_repository_access` evidence row for the impacted dependency. Archived product mappings are inactive; no historical Preflight evidence is rewritten.

## Read model

`GET /api/products/{id}/repositories?workspaceId=...` returns bounded mapped and accessible-unmapped repositories, connection/verification availability, evidence presence, and distinct usage versus plan limit. The endpoint returns no credentials. Mutation uses POST to map and DELETE to unmap.
