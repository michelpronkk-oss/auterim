# Broad technology observation

Broad technology observations are a separate evidence product from dependency candidates. They describe what deterministic public fingerprints were observed on a scanned company surface. They do not establish production usage, necessity, criticality, or customer confirmation. Existing candidate generation and onboarding confirmation remain unchanged.

## Registry and versions

`src/lib/discovery/technology-registry.ts` contains the versioned fingerprint registry. Each persisted observation records a stable fingerprint ID and the registry version (`2026-10-04.1`). A fingerprint's meaning is immutable after release; a behavior change requires a new fingerprint ID or registry version. Historical observations keep the version that produced them.

The initial taxonomy includes framework, library, build tool, hosting, monitoring, analytics, payments, identity, database, search, messaging, and AI categories. The current precise standalone fingerprints cover Next.js static chunks, explicit React CDN assets, Tailwind's explicit browser CDN, Vite's exact development client path, WordPress generator metadata corroborated by a platform asset, core-js/RxJS script assets, and weak Bootstrap stylesheet filenames. Existing provider signatures supply public observations for hosted infrastructure and supported external service categories, including Sentry, analytics, payments, authentication, database, search, messaging, and AI.

Families include response headers, HTML structure, script/stylesheet asset metadata, bounded JavaScript bundle signatures, runtime network host/resource type, and public-config endpoint references. Raw HTML, JavaScript, CSS, cookie values, config bodies, request paths/queries, and arbitrary response payloads are never persisted. Cookie inspection is not enabled in this version. Public-config keys and values are not stored; existing provider signatures retain only a matched fingerprint and normalized source host.

## Classification and suppression

Every observation carries evidence family, strength, status (`weak`, `supported`, `strong`, `conflicted`, `suppressed`, or `unknown`), relationship, protectability, disposition, surface identity, and safe source host. Protectability is separate from confidence: frameworks, libraries, and build tools are classified as non-protectable even when their technical marker is strong. A provider observation can be protectable while its evidence is suppressed as weak, marketing-only, or an optional integration. Only the existing provider candidate pipeline can make a provider suggestion; technology observations never create candidates or confirmed dependencies. `conflicted` and `unknown` are reserved classifications and are not synthesized from a missing marker.

The registry does not call a marker absent merely because it was not found. Unknown means the bounded public scan did not produce a registered fingerprint. Correlated repeats are deduplicated by surface, technology, fingerprint, and source host. Surface type is preserved, so docs and integration-directory evidence cannot be combined with the root or product surface to make a stronger claim. Suppression reason codes are stable uppercase enums, including `FRAMEWORK`, `LIBRARY`, `BUILD_TOOL`, `MARKETING_ONLY`, `GENERIC_CDN`, `WEAK_EVIDENCE`, `CORRELATED_EVIDENCE`, `OPTIONAL_INTEGRATION`, `INTEGRATION_DIRECTORY`, `UNSUPPORTED_PROVIDER`, `DERIVED_ONLY`, and `CONFLICTED_EVIDENCE`.

## Persistence and access

`technology_observations` stores at most 250 rows per discovery run. The table uses a composite run/workspace foreign key, tight enum and host constraints, and an index by workspace/run/technology. RLS is enabled; `anon` and `authenticated` receive no table privileges or policies. The discovery completion RPC inserts observations atomically with provider evidence and candidates under the trusted service-role path. This keeps fingerprint-level detail out of the customer onboarding read model. The internal production QA script reads only an explicit safe column projection with its server-side admin client.

The existing company-surface scan limits remain the ceiling for scan time, fetch calls, bytes, scripts, and runtime. Technology matching consumes already-extracted bounded data and adds no network requests. Metrics record total observations, unique recognized technologies by strength, external providers recognized, protectable providers and suggestions, and suppression reasons. The stored row limit and RPC byte limit prevent pathological fingerprint fan-out.

## Evaluation

`npm run eval:technology` runs labeled offline positive and negative fixtures and reports a deterministic precision benchmark through assertions. `npm run eval:discovery` continues to run the broader discovery, runtime, safety, and company-surface suite. Live scans are observations of the exact public page and current budgets, not proof of the complete server-side stack. Unknown server-side dependencies remain unknown.

The allowlisted internal production onboarding harness now reads the internal observation table and emits only its safe structured columns. Set `AUTERIM_INTERNAL_QA_SKIP_BROWSER_DASHBOARD=1` only for backend-only scan acceptance; onboarding, activation, account status, and protection read-model checks still run. The harness labels that browser-only check as skipped in its output.

To add a fingerprint, use a specific technical marker, provide both positive and adversarial negative fixtures, record a new stable fingerprint ID, and verify it cannot create a candidate unless the separate provider registry already recognizes evidence under its existing policy. Prefer no observation over a broad text, logo, utility-class, or directory-name match.
