# Broad technology observation

Broad technology observations are separate from dependency candidates. They describe deterministic public fingerprints observed on a scanned company surface. They do not prove production use, necessity, criticality, or customer confirmation. Existing candidate generation and onboarding confirmation remain unchanged.

## Registry and versions

`src/lib/discovery/technology-registry.ts` owns the versioned technology registry. The current version is `2026-10-04.2`. Each fingerprint has a stable ID, evidence family, strength, rationale, and positive/negative fixture labels. A behavior change requires a new fingerprint ID or registry version; historical rows retain their original version.

The taxonomy covers framework, UI framework, library, build tool, CSS framework, hosting infrastructure, CDN, database, authentication, payments, observability, analytics, customer messaging, search, AI API, messaging, email, storage, queue, developer platform, advertising, CAPTCHA, CMS, other external service, and unknown.

The initial signatures include exact Next.js and Vite asset paths, explicit React/Tailwind CDN assets, corroborated WordPress markers, core-js/RxJS package assets, weak Bootstrap stylesheet names, paired JavaScript bundle tokens for selected SDKs/build tooling, Tailwind/Bootstrap CSS structures, and allowlisted runtime global/DOM probes. Existing provider signatures continue to contribute headers, CSP, public-config references, scripts, and runtime network hosts. Server-only services without a public marker remain unknown/not observed; no absence claim is made.

## Bounded collection and privacy

Deep discovery inspects at most two same-origin CSS files per surface, 48 KiB per stylesheet, and 96 KiB aggregate CSS. CSS inspection shares the existing 384 KiB deep-asset budget with manifests and JavaScript, and uses the canonical safe fetcher, same-origin restriction, response-type checks, byte bounds, a 1.25-second per-request timeout, and a 2.5-second aggregate CSS window. Optional CSS work cannot consume the remaining scan deadline before JavaScript is considered. JavaScript remains limited to four same-origin scripts at up to 96 KiB each within that same aggregate asset budget. Matching uses bounded memory only.

The runtime registry samples only predefined primitive global checks and fixed, exact-host DOM selectors. A non-configurable page-world closure captures native property-descriptor and DOM query operations before any site script runs. The closure never invokes getters, serializes page objects, or reads into Proxy values; it returns matching fingerprint IDs only. Runtime evaluation is deadline-bounded and each probe failure is isolated from already-collected runtime request evidence.

Raw HTML, JavaScript, CSS, cookie values, config bodies, request paths/queries, and arbitrary response payloads are never persisted. Cookie names are not inspected: safe-fetch deliberately does not expose `Set-Cookie` to this layer, and no high-specificity V1 cookie-name signature justified widening that privacy boundary. Public config keys and values are not stored; observations retain only a fingerprint and normalized source host.

## Evidence and classification

Every observation carries its family, strength, relationship, protectability, disposition, surface, registry version, and safe source host. Frameworks, libraries, and build tools remain non-protectable even when confidently observed. A provider bundle signature means code support is present, not that the provider is active; it stays suppressed as an optional integration unless the existing provider candidate pipeline independently suggests that provider.

Confidence is family-based within the same surface type and hostname. Evidence from the root marketing site, product app, and integration directory cannot upgrade or conflict with one another. Repeated matches from the same family within a surface count once. One strong, specific fingerprint can support a strong observation; otherwise strong status requires at least two independent non-derived families on that surface. Derived relationships such as React inferred from Next.js are marked `derived_tech_relationship`, use `DERIVED_ONLY`, and do not count as independent evidence. Explicit contradictory CMS markers produce a `conflicted` observation instead of a confident detection.

The observation layer never creates candidates or confirmed dependencies. Only the existing provider candidate pipeline can suggest a provider. Suppression codes include framework/library/build-tool, weak evidence, optional integration, correlated evidence, derived-only, and conflicted evidence. The full code vocabulary is constrained by the forward migration.

Technical observation and workspace disposition are separate facts. An observation's `status` and linked discovery evidence preserve what the public surface showed; a workspace member confirming or rejecting a dependency candidate changes only that candidate's status. In particular, `Not used` is not detector ground truth and never relabels, deletes, or downgrades the observation or its provenance. A rejection may mean the signal is technically correct but irrelevant to that workspace, stale for its current usage, or incorrect; it must not train or downgrade a fingerprint by itself. Cookie-name fingerprints are **deferred by design**: the safe-fetch boundary does not expose `Set-Cookie`, and expanding that boundary is not justified for Discovery V1.

## Persistence and access

`technology_observations` stores at most 250 rows per discovery run. The table uses a composite run/workspace foreign key, bounded enum/host constraints, and an index by workspace/run/technology. RLS is enabled; `anon` and `authenticated` have no table privileges or policies. The completion RPC inserts observations atomically with existing provider evidence and candidates. Fingerprint-level detail remains out of the customer onboarding read model. The internal production QA script reads only an explicit safe column projection.

Company scan limits remain in force. CSS and JS reads use safe-fetch and share the deep-asset budget. Runtime probes use the existing bounded isolated browser. Metrics report CSS/JS bytes and asset counts, runtime fingerprint evaluations, registry matching duration/failure, and technology totals. If registry matching throws, deterministic provider discovery still completes and the safe aggregate failure flag is set.

## Evaluation

`npm run eval:technology` checks every registry entry for rationale and positive/negative fixtures, exercises the evidence families and taxonomy, covers bundle/CSS/runtime matching, adversarial prose and optional-integration cases, correlation, conflict, derived evidence, byte bounds, and secret/body non-persistence. It is a deterministic fixture benchmark, not a universal accuracy claim. `npm run eval:discovery` continues to run the broader discovery, runtime, safety, and company-surface suite.

Live scans show only publicly observable evidence at the time of the bounded scan. They are not a complete inventory of the server-side stack. To add a fingerprint, use a specific technical marker, include positive and adversarial negative fixtures, document the rationale and false-positive risks, and prove the observation cannot create a candidate without separate provider evidence.
