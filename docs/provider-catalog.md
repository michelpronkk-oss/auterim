# Dependency provider catalog

The dependency catalog represents services a workspace relies on. It is separate from both the global source-monitoring records and authenticated connector installations. Adding a provider to the catalog never creates a connector, grants a capability, or implies that Auterim protects it.

## Canonical records and aliases

`dependency_catalog.slug` is the stable provider identity used by discovery, onboarding, workspace dependencies, and source records. Search reads enabled canonical records and their `metadata.aliases`. Product names that belong to a parent provider resolve through an alias where that avoids duplicate identities; for example, Supabase Auth resolves to Supabase, Firebase Authentication to Firebase, and GitHub Actions to GitHub. Separately modeled cloud products retain their own identity where customers can reasonably track them independently.

Aliases are search labels only. They do not create extra dependency rows or alter frozen Discovery V1 signatures. Manual add accepts a canonical slug returned by search. Unknown names are rejected as unsupported; they do not create tenant-defined global providers or arbitrary monitored URLs.

## Coverage semantics

Coverage is derived from enabled `source_catalog` rows for the canonical provider:

- **Strong source coverage**: at least three distinct enabled source types have been curated.
- **Partial source coverage**: one or two enabled source types have been curated, or the bounded public-source query is incomplete.
- **Coverage pending**: the exact enabled source count is zero.
- **Coverage unknown**: the bounded public directory has not read all source rows and no row for the provider appeared in the returned page.

These labels describe the number of configured source-type buckets, not independent corroboration, completeness, freshness, successful scans, baseline completion, service availability, or incident detection. Source rows are added only for provider-owned URLs with a useful, explicit scope. Some sources cover a provider broadly; the catalog names them at that scope. For example, the Firebase source is specifically for its JavaScript SDK release notes; it does not represent every Firebase product. GitHub breaking-change pages cover the documented REST/GraphQL surfaces, not every GitHub feature. A catalog-only provider is valid and remains coverage-pending until source curation exists.

Existing sources are global and shared across workspaces. A source is not copied or fetched separately for each customer. No source body is placed in tenant tables.

The launch source expansion adds provider-owned release/changelog pages for Vercel, Cloudflare, DigitalOcean, MongoDB Atlas, GitLab, Slack, Linear, Twilio, PostHog, Intercom, Clerk, Auth0, Okta, Adyen, PlanetScale, Neon, New Relic, and Algolia. These additions each contribute one configured source type and therefore remain **partial source coverage**. Several pages cover a broad provider product stream rather than a specific API surface; a catalog row is source eligibility, not proof that every product is covered or that a scan has succeeded. Twilio's source is not duplicated under SendGrid or Segment.

The final pre-M15 coverage wave adds provider-owned update sources for Cohere, Mistral AI, Groq, Replicate, Hugging Face, Render, Railway, CockroachDB Cloud API, Cloudinary Image and Video API, Snyk API, Docker Hub API, WorkOS, Stytch, Microsoft Entra ID, HCP Terraform API, LaunchDarkly, Statsig, Honeycomb, PagerDuty API, Databricks, Snowflake, Redis Cloud, Upstash Redis, Paddle, Mollie, CircleCI, and Ably. Groq and Docker Hub have separate changelog and deprecation sources; each other addition contributes a changelog source. All 27 newly covered providers remain **partial** under the current three-source-type-bucket rule. With the wave applied, the catalog has configured source coverage for 56 of 115 providers: 1 strong, 55 partial, and 59 pending. Configured rows do not certify that source scans have succeeded. Product update streams may still contain changes that do not apply to every customer using the provider.

AWS, Google Cloud, and Azure remain coverage-pending at the broad-provider level. Existing separate identities such as Amazon SES, Google Cloud Storage, Azure Blob Storage, and Microsoft Entra ID do not imply coverage of sibling services. `source_catalog` has no typed product/service scope, and the classifier/impact pipeline does not carry a validated service identity from a source into tenant dependency matching. Therefore Auterim must not attach a broad hyperscaler feed and present its changes as relevant to every customer using that cloud. This capability gap is **M15 / POST-LAUNCH SERVICE-SCOPED RELEVANCE**: model curated service identities, source scopes, and customer-selected service usage together, then preserve those identifiers through classification and impact evaluation. Until that exists, leave the broad AWS, Google Cloud, and Azure catalog entries pending.

## Search and onboarding

`search_onboarding_dependency_catalog(workspace_id, query)` requires an authenticated workspace member. It searches enabled canonical names, slugs, aliases, and categories case-insensitively; literal `%` and `_` characters do not become SQL wildcards. Exact canonical-name/slug matches rank first, followed by exact aliases, partial provider matches, aliases, and category matches. Results include the real enabled-source count and a coverage label. The result cap is 200, above the current catalog size, while the empty initial query remains bounded.

Discovered candidates remain separate and are presented before manual catalog search results. Discovery is evidence and a suggestion; only an explicit confirmation or manual-add operation creates a workspace dependency. Catalog-only entries can be recorded as customer dependencies, but the UI calls coverage pending instead of implying monitoring exists.

The public dependency coverage directory reads the same enabled canonical catalog. Its source totals come from enabled `source_catalog` rows and are bounded; when that query is partial, source totals and coverage labels are marked partial/unknown. Services with no source rows can be searched by name, slug, alias, or category and are explicitly labeled coverage pending.

## Categories and scale

The catalog uses categories for AI, payments, infrastructure, developer tools, communications, databases, identity, email, observability, analytics, search, storage, CRM, support, commerce, workflow, feature flags, and security. Categories classify software dependency records; they do not imply product entitlements or connector support.

Current workspace dependency quotas remain independent of catalog size: Core 20, Pro 75, Business 250. Protected-product counts and repository limits remain separate billing concepts. The catalog currently contains 115 enabled canonical providers; tests exercise search and persistence/activation with 20 Core, 50 Pro, and 100 Business dependencies.

## Connectors and Discovery V1

Connectors remain a small authenticated integration set with separate credential/resource/health lifecycle. Catalog breadth does not add Slack, Linear, Sentry, or GitHub connector credentials, nor does it authorize connector operations.

Discovery V1 is frozen for launch. Catalog expansion does not add website fingerprints, runtime detectors, crawlers, confidence tuning, or new discovery signatures. Candidate identities still resolve only through the existing canonical catalog model.
