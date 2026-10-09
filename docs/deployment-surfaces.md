# Deployment surfaces (M15.7)

Auterim keeps repository exposure, provider deployment observations, and current Production evidence as separate facts. A Vercel project becomes a Product deployment surface only when its verified Git repository identity matches a repository already mapped to a protected Product. Merely seeing a project or deployment never creates Product intent.

## Model

- `deployment_surfaces` records a workspace-scoped Vercel project installation and its latest successfully confirmed Production alias target.
- `workspace_product_deployment_surfaces` links a project to a Product only through an existing active Product/repository mapping and matching normalized repository identity. Its provenance records that relationship.
- `deployment_observations` keeps bounded provider deployment metadata, stable provider deployment IDs, commit SHA, target, state, safe URL, provider timestamps, observation time, and provenance.
- `product_deployment_evidence` stores Product-specific verification state and references the exact verified Preflight finding used for commit correlation.
- `deployment_sync_attempts` records bounded outcomes and safe error categories. Tokens, environment values, raw provider payloads, build logs, and source bodies are not stored.

Composite workspace foreign keys and RLS protect each tenant relation. Authenticated workspace members can read safe deployment state. Only the server service role writes provider observations and evidence. The API authenticates workspace membership, requires owner/admin for sync, checks the canonical connector capability entitlement, requires a selected Vercel project resource, and scopes every read/write by workspace and installation.

## Vercel authorization and selection

The server starts the Vercel external integration flow with short-lived state bound to the existing connector authorization state. The callback exchanges the code server-side, reads the returned installation configuration, verifies configuration/team identity and the actual required read scopes (`integration-configuration`, `project`, `deployment`, and `domain`; plus `team` or `user` identity read), then encrypts the token using the shared versioned connector credential store. The project catalog is bounded to 100 resources and filtered to the IDs in a selected-project installation. A resource must also be explicitly selected in Auterim before sync. Project metadata is fetched only through the authorized installation; there is no environment-variable API access.

Vercel API permissions must be configured as read-only for the required scopes. Vercel tokens remain server-side and never appear in API responses or logs. Access revocation degrades connector health and future sync stops; historical observations remain available.

## Evidence rules

The generic decision helper is deliberately conservative:

1. A provider-visible project is `observed`.
2. A grounded protected Product/repository relationship is `mapped`.
3. An exact commit matching verified Preflight evidence is `commit_verified`.
4. Only a ready Production deployment whose ID is the deployment currently returned by the project's verified domain alias, with that exact commit match, is `production_verified`.
5. Preview, failed/canceled, missing/mismatched commit, or ambiguous mappings never establish current Production exposure. Superseded deployment evidence is historical.

The alias check uses verified project domains and requires their resolved aliases to agree on one deployment ID. If no unambiguous current alias is found, Auterim reports no current Production deployment. A failed provider read preserves the prior pointer and observation history but the read model reports the latest sync failure and does not claim that the retained evidence is freshly confirmed.

Repeating sync upserts by provider installation/project and provider deployment ID. Historical rows are retained. A newer alias target makes the previous Product-specific current claim historical before the new observation is evaluated. A rollback is represented by a newly observed deployment and can become current when provider alias and exact commit evidence establish it.

## Entitlements and quota

`CAN_READ_DEPLOYMENT_CONTEXT` is registered in the shared capability catalog and reuses the existing repository-protection entitlement. Sync does not create or count protected repositories, Products, or quota units. No plan, price, or deployment quota is introduced.

## Operations

After connecting Vercel, an owner/admin refreshes the project catalog, selects an accessible project in Auterim, and calls the Product deployment sync endpoint:

`POST /api/products/{productId}/deployments/sync`

The request requires `workspaceId`, `installationId`, and the selected connector `resourceId`. The Product must be protected. Sync reads only that selected project. The Product protection graph exposes mapped deployment surfaces, bounded recent observations, last sync status, and Product-specific verification/currentness without credentials.

## Adding a provider

Another hosting provider should implement the server-side provider adapter that returns normalized project identities, deployment observations, and authoritative current-production targets. It must reuse `deployment_surfaces`, `deployment_observations`, and Product-specific evidence semantics; it must not infer Product intent from project names or treat a latest/preview/failed deployment as current Production.
