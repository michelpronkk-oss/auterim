# Product protection compatibility (M15.5)

This compatibility layer keeps existing workspaces and onboarding behavior intact while making Product identity explicit for future consumers. It does not migrate user intent, create extra Products, or make discovery observations into confirmed dependencies.

## Canonical ownership

- `workspace_products` is the Product catalog for a workspace. The existing default Product is retained.
- `workspace_dependencies.protected_product_id` identifies exactly one owning Product for each confirmed dependency. Product dependency APIs require the Product ID and return only dependencies owned by that Product.
- `workspace_product_repositories` is the explicit Product-to-Repository protection edge.
- `workspace_repository_access` remains the separate Dependency-to-Repository evidence edge.
- `repositories` is the accessible repository catalog. Importing a repository does not protect it.
- `repositories.selected_for_protection` is a compatibility mirror, not Product intent. Once any Product mapping history exists for that repository, only an active mapping for the requested Product authorizes it. With no mapping history, the legacy fallback is accepted only when workspace-scoped dependency-access edges resolve to exactly one distinct owning Product, and it matches the requested Product. Zero or multiple Products means `repository_mapping_required`; no default Product is guessed.
- Discovery candidates and observations remain separate from `workspace_dependencies`; they are not customer-confirmed Product dependencies.

## Existing onboarding bridge

The current workspace onboarding flow remains the compatibility path for existing customers:

1. `POST /api/onboarding` normalizes the company URL/domain and calls the idempotent workspace onboarding operation. It creates or reuses the Company within the workspace and reuses the same workspace/company on a valid retry.
2. Creating a workspace initializes exactly one `is_default` Product. The onboarding-to-Product database bridge synchronizes that default Product's name and website surface from the Company. It does not create a second Product on resume.
3. `POST /api/onboarding/dependencies` confirms a discovered candidate or manually adds a catalog dependency. Both operations attach the dependency to the workspace's non-archived default Product. Confirmation retains candidate provenance; rejection does not create a dependency. Discovery candidates remain historical evidence.
4. Context and notification preferences continue using their existing workspace-scoped APIs and tables. Product-aware APIs must use explicit Product IDs instead of the workspace default bridge.
5. `POST /api/onboarding/activate` calls `activate_workspace_protection`. The transaction protects the default Product and confirmed dependencies, records one activation timestamp, and queues shared global source baselines idempotently.
6. The activation transition starts the existing five-day Pro trial once, anchored to `activated_at`. Signup, resume, Product creation, and compatibility reads do not start or reset a trial.

This bridge is intentionally limited to the current one-default-Product onboarding flow. When a caller needs to address one of multiple Products, it must use Product-scoped APIs rather than silently resolving the default.

## Stable Product read contracts

Authenticated consumers can use the existing contracts without knowing storage details:

| Contract                                                                                | Source                                                                                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| List/create Products                                                                    | `GET/POST /api/products`                                                                    |
| Product dependencies                                                                    | `GET/POST /api/products/{productId}/dependencies?workspaceId=...`                           |
| Product repository resources and mapping                                                | `GET/POST/DELETE /api/products/{productId}/repositories`                                    |
| Product, dependencies, repository relationships, source coverage, and grounded evidence | `GET /api/products/{productId}/protection-graph?workspaceId=...`                            |
| Server-side graph composition                                                           | `getProductProtectionGraph` in `src/lib/protection/product-graph.ts`                        |
| Server-side Product repository read model                                               | `getProductRepositoryProtection` in `src/lib/repositories/product-protection-read-model.ts` |

These responses are workspace-authorized, Product-scoped, bounded, and do not include source bodies or repository code. Product and dependency routes return explicit Product context; tenant read responses are private and non-cacheable. Coverage is derived from enabled global `source_catalog` rows and global baseline observations, not estimates.

## Repository and billing compatibility

The workspace repository endpoint remains an accessible-catalog/legacy view. It reports `legacyAttribution` as `unique_product`, `mapping_required`, `unattributed`, `not_selected`, or `explicit_mapping_history`; this is explanatory metadata, while Product protection decisions use the Product repository API and graph. Preflight, remediation preparation, and validation additionally require the dependency-to-repository access edge, repository availability, and a connected repository connection. Their Product check uses explicit mapping history first and the legacy selected flag only for repositories with no mapping history and a unique dependency-edge Product context.

Billing keeps the canonical Core/Pro/Business limits and activation-based trial semantics. Product slots count non-archived Product records; confirmed dependency records retain their quota identity when monitoring is disabled; protected repository usage counts distinct active Product mappings and history-free legacy selections only when their dependency evidence resolves to one protected Product. Ambiguous and unlinked selected legacy repositories do not count as protected usage, and a repository is counted at most once at workspace level. The legacy repository-selection RPC uses the same canonical usage count when enforcing its quota, so ambiguous history is neither double-counted nor allowed to block a valid selection. Accessible-but-unmapped imported repositories do not consume protected-repository quota. No Product or dependency is created by a usage read.

The legacy workspace repository-selection adapter accepts dependency IDs only when they resolve to one Product. Multi-Product selections require explicit Product-scoped repository mapping operations. Business handoff request, claim, and completion also recheck the deterministic Product repository predicate. Validation workers apply the same predicate before delegating to older validation checks; if an exact active Product mapping is current and the repository is available through a connected installation, they repair the legacy selection mirror before the delegated check so that the mirror cannot override canonical Product intent.

## Intentionally deferred

Onboarding V2 screens, CLI connection flows, automatic Product assignment, multi-Product onboarding context/preferences, connector-backed protected surfaces, and removal of legacy APIs are not part of this compatibility phase. Existing workspaces remain on the default Product bridge until they explicitly adopt Product-oriented flows.
