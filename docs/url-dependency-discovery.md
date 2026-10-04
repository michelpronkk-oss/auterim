# URL dependency discovery

Auterim runs deterministic, public-evidence-only checks against a company's public website. It reads one homepage and records bounded signatures for infrastructure and browser services. Onboarding requests the bounded deep pass; the public stack-scan endpoint remains fast-only. It does not execute scripts, submit forms, use credentials, crawl authenticated areas, or treat a provider name in page copy as evidence.

## Evidence and confidence

`src/lib/discovery/registry.ts` contains explicit, reviewable provider signatures. Evidence is deterministic and discovery does not use an LLM.

The fast pass fetches the normalized public origin. URL credentials, non-HTTP(S) schemes, unusual or scheme-mismatched ports, path, query, and fragment are rejected or removed before persistence. `fetchHttpSource` validates public DNS addresses, bounds DNS waits, pins resolved addresses, validates redirects, blocks HTTPS downgrade, bounds requests and response sizes, and returns only a small allowlist of response headers including bounded CSP policies. Page bodies are processed in memory and not stored. HTML is capped at 2 MiB; the base-tag search and evidence extraction each visit at most 20,000 nodes. parse5 builds a tree only from the byte-capped document.

The optional deep pass reads at most one same-origin web manifest (32 KiB), then at most four same-origin JavaScript resources (96 KiB each), within a 384 KiB aggregate byte budget. Only JavaScript MIME types are accepted. It never runs JavaScript; a small scanner ignores comments and evaluates only registered SDK/config markers and URL literals. Cross-origin script URLs can support fast-pass provider signatures but are not fetched. Onboarding enables this bounded pass; public stack scan remains fast-only to keep its request latency bounded.

The parser inspects selected technical surfaces only: response headers, redirect response headers/final redirect host, script references, selected stylesheet/iframe/form/resource references, CSP host sources, selected endpoint-like JSON keys in inline public configuration, same-origin manifests, and the bounded same-origin JavaScript pass. It does not retain the HTML, CSP text, inline config, manifest, JavaScript, query strings, or full source paths. Evidence stores registered provider/signature IDs, signal type/strength, and origin only. DNS resolution is used for SSRF validation and address pinning; DNS records such as CNAME/TXT/MX are not used as provider evidence.

Provider signatures use exact host boundaries and provider-specific technical markers. Generic image, icon, iframe/demo, arbitrary resource-host, and visible-copy matches do not become suggestions. Weak-only evidence is retained as evidence but does not produce a candidate. Confidence combines the strongest item per independent signal type (strong `0.68`, medium `0.40`, weak `0.18`); correlated headers within one signal type do not inflate the score. High confidence requires a score of at least `0.85` plus two distinct strong signal types. Every candidate remains a suggestion until the user confirms it.

## Candidates and tenant boundary

`discovered_dependencies` represents candidates, separate from `workspace_dependencies` confirmed selections. Discovery can refresh only rows still in `candidate` state. It never confirms, rejects, or overwrites a user's decision. Each run and its signature-only evidence are scoped to a workspace/company, protected by RLS, and writable only by the server service role. No raw HTML, script, cookie, authorization header, query string, or full script path is persisted.

The Trigger task `discover-website-dependencies` accepts a workspace ID, company ID, public website URL, and optional deep-pass flag. Its payload rejects malformed URLs, credentials, and non-standard ports, it limits concurrent work, and it checks that the company belongs to the workspace before fetching. Retryable network and server errors reach Trigger's bounded retry policy. This task is a trusted backend entry point; any future user-facing enqueue path must authorize workspace membership before triggering it.

## Evaluation

`npm run eval:discovery` runs offline fixtures and never makes network requests. `npm run eval:discovery:live` is opt-in and requires `AUTERIM_DISCOVERY_LIVE=1`; it makes bounded requests to named public websites. Set `AUTERIM_DISCOVERY_SITE=trustmrr` to run only the TrustMRR production case. The Stripe brand-page no-match is an observation about that page, not a claim that Stripe is absent from the site. The command reports signatures and candidates without storing fetched content. Run it only when public outbound requests are permitted.

## M11 baseline inventory and TrustMRR

Before the M11 expansion, the fast pass supported:

| Surface                                           | Baseline status | What the implementation did                                                                                                                                                                                                   |
| ------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP response headers                             | Expanded        | Final and intermediate redirect response allowlist includes CSP and report-only CSP (each capped at 4 KiB).                                                                                                                   |
| Redirects / final URL                             | Expanded        | At most three safe redirects; intermediate provider headers and the final redirect host are evidence inputs. Paths are not retained.                                                                                          |
| HTML                                              | Expanded        | Each parse5 traversal is capped at 20,000 nodes; page response capped at 2 MiB. No visible text matching.                                                                                                                     |
| `script[src]`                                     | Expanded        | Up to 30 script URLs within the bounded resource inventory; provider-specific CDN/path signatures.                                                                                                                            |
| `link[href]`                                      | Expanded        | Selected relation types; only stylesheet host evidence is considered and only with provider-specific signatures. One same-origin manifest may be fetched in deep mode.                                                        |
| `iframe`, `img`, `source`, `video[poster]`, forms | Bounded         | Resource URLs are collected for narrow technical signatures; generic assets/demo frames do not produce candidates. Form destinations are checked for known payment endpoints.                                                 |
| CSP                                               | Implemented     | Parses a selected allowlist of directives and retains only normalized hostnames in memory; CSP-only evidence is low confidence.                                                                                               |
| Inline public config                              | Implemented     | Inspects JSON script blocks and selected endpoint-like meta keys. Key/depth/byte limits apply; only recognized provider endpoints become evidence.                                                                            |
| JavaScript bundles                                | Expanded        | Onboarding deep pass fetches up to four same-origin scripts, 96 KiB each, 384 KiB aggregate with manifest bytes included. Comments are ignored, code is not executed, and only registered technical markers/URLs are matched. |
| Manifest                                          | Bounded         | Deep pass may fetch one same-origin JSON/manifest response up to 32 KiB; selected endpoint keys only.                                                                                                                         |
| DNS / CNAME / TXT / MX                            | Not implemented | No DNS-based provider evidence was collected.                                                                                                                                                                                 |
| Arbitrary API requests                            | Not implemented | URLs found in content were not fetched as API endpoints.                                                                                                                                                                      |
| Browser execution / runtime network               | Not implemented | No JavaScript execution, browser rendering, or runtime request capture occurred.                                                                                                                                              |

The bounded before-change live scan of `https://trustmrr.com/` made one HTTP request. It found two strong Vercel response-header signatures (`server-vercel`, `x-vercel-id`), both in the same signal family, and emitted one Vercel candidate at `0.72` / medium confidence. The deep pass was not requested, so no referenced script was fetched. This result proves only that those headers were observable in this response; it does not establish that Vercel is TrustMRR's only dependency.

Discovery is incomplete for dynamically rendered sites, private integrations, and services without registered public signatures. Absence of a candidate is not proof of absence. Candidates require later customer confirmation.

## M11 bounded expansion

The implementation adds endpoint/config signatures for registered providers, selected CSP/manifest inputs, active SDK markers from bounded first-party scripts, and safe redirect evidence. It removes generic media/demo-host suggestions and suppresses weak-only candidates. The database migration `20261011000000_expanded_public_discovery_signals.sql` extends the evidence type constraint without changing tenant ownership, candidate decisions, or confirmed dependencies.

This still does not perform DNS provider discovery, runtime browser execution, arbitrary API calls, general crawling, or third-party bundle downloads. Dynamic pages and private/server-only integrations may not be visible. A provider suggestion is not a claim of use or impact; it is public evidence for the customer to review.

The bounded after-change TrustMRR run completed with five safe-fetch attempts (one homepage plus up to four same-origin scripts). Two JavaScript assets were accepted and inspected, totaling 9,140 bytes. The homepage exposed 4,714 inspected nodes, 30 script references, and the 64-resource cap. It again produced only the two strong Vercel response headers and one Vercel suggestion; confidence is `0.68` / medium because both headers share one signal type. No further provider was evidenced by the bounded surfaces inspected. This is not a complete TrustMRR dependency inventory.
