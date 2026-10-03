# URL dependency discovery

Milestone 5 runs deterministic, public-evidence-only checks against a company's public website. It reads one homepage by default and records bounded signatures for infrastructure and browser services. It does not execute scripts, submit forms, use credentials, crawl authenticated areas, or treat a provider name in page copy as evidence.

## Evidence and confidence

`src/lib/discovery/registry.ts` contains explicit, reviewable provider signatures. Evidence is limited to allowlisted response headers and public URLs found in parsed resource attributes. Weak evidence such as a CloudFront reference or a URL embedded in a JavaScript bundle cannot independently produce high confidence. Confidence combines the strongest signal per modality, so two correlated headers from one response do not inflate confidence; high requires distinct corroborating modalities. Discovery does not use an LLM.

The fast pass fetches the normalized public origin. URL credentials, non-HTTP(S) schemes, unusual ports, path, query, and fragment are rejected or removed before persistence. `fetchHttpSource` validates public DNS addresses, pins resolved addresses, validates redirects, blocks HTTPS downgrade, bounds requests and response sizes, and returns only a small allowlist of response headers. Page bodies are processed in memory and not stored.

The optional deep pass reads at most four same-origin script resources, with a 96 KiB per-script limit and a 384 KiB aggregate limit. It never runs JavaScript. URL literals in those bundles are weak embedded-URL evidence, not proof that the browser loaded or used the service. Cross-origin script URLs can support fast-pass provider signatures but are not fetched. The deep pass is off by default.

## Candidates and tenant boundary

`discovered_dependencies` represents candidates, separate from `workspace_dependencies` confirmed selections. Discovery can refresh only rows still in `candidate` state. It never confirms, rejects, or overwrites a user's decision. Each run and its signature-only evidence are scoped to a workspace/company, protected by RLS, and writable only by the server service role. No raw HTML, script, cookie, authorization header, query string, or full script path is persisted.

The Trigger task `discover-website-dependencies` accepts a workspace ID, company ID, public website URL, and optional deep-pass flag. Its payload rejects malformed URLs, credentials, and non-standard ports, it limits concurrent work, and it checks that the company belongs to the workspace before fetching. Retryable network and server errors reach Trigger's bounded retry policy. This task is a trusted backend entry point; any future user-facing enqueue path must authorize workspace membership before triggering it.

## Evaluation

`npm run eval:discovery` runs offline fixtures and never makes network requests. `npm run eval:discovery:live` is opt-in and requires `AUTERIM_DISCOVERY_LIVE=1`; it makes a fast-pass-only request to three named public websites. The bounded set checks known positive public markers on Vercel and Cloudflare, and a no-match expectation on Stripe's brand homepage, where no browser integration signature is registered. The no-match is an observation about that page, not a claim that Stripe is absent from the site. The command reports expected outcomes without storing fetched content. Run it only when public outbound requests are permitted.

Discovery is incomplete for dynamically rendered sites, private integrations, and services without registered public signatures. Absence of a candidate is not proof of absence. Candidates require later customer confirmation.
