# Product protection graph (M15.5 Phase A.2)

`GET /api/products/{productId}/protection-graph?workspaceId=...` provides a bounded, member-authorized read model for a protected product. It is a composition of the existing product, dependency, source, impact, repository, and Preflight records; it does not create a second evidence store.

## Identity and discovery

Only rows in `workspace_dependencies` appear as confirmed dependency nodes. Their `origin` and confirmation timestamp remain visible. Public URL discovery candidates and observations are separate evidence: a candidate is not a dependency and does not become protected until a user confirms or manually adds it through the existing onboarding operation. This graph currently identifies itself as `workspace_confirmed_dependencies_only`; it does not merge candidate summaries into confirmed customer state.

## Monitoring and coverage

Authoritative source counts come from enabled rows in the global `source_catalog`, grouped by the catalog `source_type`. Source snapshots and scan records remain global and are referenced by ID and timestamps; snapshot bodies are never returned or copied into tenant tables. The graph distinguishes configured source coverage, observed snapshots, and latest per-source scan outcomes. An enabled source means a supported monitoring path exists; it does not claim scans are succeeding, the source is fresh, or the provider is healthy. No freshness TTL is implied.

Coverage is bounded to 50 dependency nodes, 500 source rows, 200 repositories (from the existing repository read model), and 500 impact/run/finding evidence rows. Truncation is explicit. Counts come from catalog/database results; no estimated source totals are added.

## Repository verification

Product-to-repository protection mapping is one edge. The separate `workspace_repository_access` dependency-to-repository edge is required to associate a repository with a dependency. Neither edge alone proves exposure. The graph reports mapping provenance, connection health, verification capability entitlement, and Preflight evidence as separate facts.

The graph exposes `latestAttempt` and `lastVerifiedEvidence` separately. A newer queued or running attempt does not erase historical verified findings. Historical evidence includes its commit and observation/completion timestamps and is marked as not revalidated against the live repository head. The latest attempt includes its status and repository-set fingerprint; that fingerprint is not expanded into repository membership.

## Customer impact and future contexts

Impact assessments remain tenant-specific and link to the existing global material classification by ID. The graph returns the latest assessed impact summary fields without source bodies. Runtime/deployment context is not inferred from connector presence or a repository mapping; those capabilities require their own selected-resource evidence before the product can make a claim.

M15.7 adds a separate `deployments` section. A Vercel project is mapped to a Product only through an active protected repository mapping plus matching provider repository identity. The graph returns bounded deployment metadata and Product-specific verification evidence. A deployment is marked current Production verified only when its exact commit matches verified Preflight evidence, it is ready, and its provider deployment ID matches the current verified-domain alias target after a successful latest sync. Preview, failed, ambiguous, mismatched, or historical evidence cannot assert current Production exposure. See [deployment surfaces](deployment-surfaces.md).

## Authorization and non-goals

The route authenticates the caller, verifies membership in the requested workspace, resolves the canonical repository-verification entitlement, and disables shared caching. Reads use workspace-scoped queries and the existing RLS policies. This is a backend read model only: it adds no onboarding or dashboard UI, no provider integration, and no lifecycle mutation.

## Product-scoped worker checks

Worker claim and terminal persistence operations now require the active repository mapping for the exact protected product. The legacy `selected_for_protection` fallback applies only when that workspace repository has no product-mapping history. Dependency-to-repository access and repository/connection availability remain separate required checks.
