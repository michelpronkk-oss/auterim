# URL dependency discovery

Auterim inspects public website technology signals to suggest dependencies for customer review. It does not establish that a provider is used in production, infer business criticality, or confirm a dependency. Every result remains a suggestion until a workspace member confirms it. Discovery is deterministic and uses registered signatures rather than an LLM.

## Static extractor and resource graph

The homepage is fetched through `fetchHttpSource`, which validates public DNS answers, pins the selected address, validates every redirect, rejects non-standard ports and HTTPS downgrades, and enforces encoded and decoded response bounds. Decoded HTML is streamed into `htmlparser2`; the extractor does not build or retain a DOM or a complete response body. Its budgets cap HTML at 4 MiB, traversal at 20,000 nodes, general references at 64, script references at 30, inline configuration at 32 KiB/32 URLs, and inline JSON traversal at 500 keys. Script references have their own budget so unrelated resources cannot crowd them out. Base URL handling, entity decoding, malformed input, and split stream chunks are covered by fixtures.

The bounded static resource graph counts first-party and third-party scripts, stylesheets, preloads, API endpoint hints, frames, manifests, form actions, and other references. Onboarding's deep pass may fetch one same-origin manifest (32 KiB) and up to four same-origin scripts (96 KiB each, 384 KiB total, two concurrent). It accepts only the expected content types and scans code without executing it. Public stack scan remains fast-only. The whole discovery run has a 45-second deadline.

Only selected headers, redirect metadata, script and resource references, CSP host sources, endpoint-like public JSON configuration, and bounded first-party code are inspected. Query strings, fragments, credentials, cookies, source bodies, full script paths, inline config, and arbitrary page text are not persisted. Evidence stores registered signature identifiers, signal type/strength, and normalized origin. DNS records are used only for SSRF protection, never as provider evidence.

## Static coverage policy

Coverage is reported as `strong`, `weak`, or `partial`, alongside duration, signature-family count, resource-graph counts, and explicit incomplete reasons. Truncation, parser/reference limits, missing optional assets, or time limits produce partial coverage. Static coverage is strong only when the scan is complete, a script reference exists, and strong provider-specific direct-use signatures span at least two independent signal families. One provider clue plus a generic script reference cannot suppress runtime enrichment. Hosting headers, redirects, CSP allowlists, and medium script-path hints alone do not make coverage strong. When onboarding asks for a deep scan and static coverage is not strong, the runtime pass may be attempted.

An empty result means no registered candidate was found in the bounded surfaces. It does not mean the company has no such dependency. Sites may hide private, server-only, or dynamically loaded integrations.

## Optional runtime browser pass

The onboarding deep pass can load one HTTPS landing page in a short-lived headless Chromium process. It is not a crawler and does not submit forms, visit arbitrary links, inspect private areas, or preserve a rendered DOM. The runtime budget is eight seconds: navigation is capped at 3.5 seconds, settling at 650 ms, at most 60 requests, 20 hosts, three concurrent fetches, 5 MiB aggregate decoded response bytes, 8 MiB aggregate encoded bytes, 4 MiB for the main document, 128 KiB per script, and 96 KiB per API response. The main document already retrieved by the static pass is reused for browser navigation, avoiding a duplicate fetch; its bounded body remains subject to the runtime decoded-byte budget. The canonical safe fetcher follows and validates each redirect hop, capped at three hops; Chromium only receives the final response.

Only standard-port HTTP(S) GET and HEAD requests for the main document, scripts, fetch, and XHR are eligible. Each eligible network read is performed by Auterim's DNS-validating and IP-pinning fetcher, then the final bounded response is returned to Chromium through the Playwright route handler. The main document is reused only from the current scan's safe-fetch result. Chromium's resolver is configured to fail direct DNS resolution; service workers, downloads, popups, subframes, WebSockets, WebRTC/WebTransport JavaScript APIs, and non-proxied WebRTC UDP are disabled or blocked. Chromium is launched with a deny-only proxy and the OS sandbox enabled on supported Linux production runtimes; the Windows local test host runs without the Chromium OS sandbox because this browser build disconnects before page creation when sandboxing is requested there. Generic styles, images, fonts, and media are blocked. A missing/incompatible browser binary makes runtime coverage unavailable; static evidence is retained and the run is labeled partial.

The runtime result retains only normalized hostname/resource-type observations and aggregate counts, never full request URLs, query values, response bodies, cookies, arbitrary response headers, or rendered page content. Runtime coverage distinguishes complete, partial, and unavailable. An observed unsafe request makes coverage partial when other evidence was obtained. Runtime failures do not erase valid static evidence.

Runtime request counters describe different stages of the route policy. `requestsObserved` counts requests that passed the URL, method, resource-type, main-frame, redirect, host/request, concurrency, and byte-budget checks and were admitted to the mediated safe-fetch path. `requestsFulfilled` counts admitted requests whose bounded response was successfully returned with `route.fulfill`. `requestsBlocked` counts routed requests aborted by policy or by a bounded fetch failure; this includes filtered resources such as images, fonts, and media, unsafe methods or destinations, and requests rejected by runtime limits. Therefore `requestsBlocked` may exceed `requestsObserved`, and `requestsObserved` is not a count of every request Chromium attempted.

The runtime is a narrow, application-isolated browser pass, not a general-purpose browsing surface. Context routing is installed before the first page exists. Main documents and approved script/XHR/fetch resources are sent through Auterim's canonical DNS-validating, address-pinned safe fetcher and returned to Chromium with `route.fulfill`; arbitrary requests are aborted. Chromium also uses a local deny-only proxy with implicit loopback bypass disabled, so a request missed by routing cannot be forwarded by the browser. Background networking, QUIC, WebRTC UDP, service workers, workers, WebSockets, downloads, non-GET/HEAD methods, and unrelated resource types are disabled or blocked.

`AUTERIM_DISCOVERY_RUNTIME_ENABLED` remains `0` by default. Enablement depends on the application-level direct-egress, private-address, redirect, concurrency, timeout, and cleanup tests passing. Trigger.dev platform egress isolation is not a prerequisite. The deny proxy and interception boundary must be preserved in any runtime refactor. `memoryDeltaBytes` measures the Node worker's RSS delta and does not include Chromium child-process peak memory.

## Provider signatures and confidence

`src/lib/discovery/registry.ts` contains explicit, reviewable signatures with exact host boundaries and provider-specific technical markers. Generic copy, logos, social links, and arbitrary embeds do not qualify. Evidence is grouped by provider and family; repeated observations within one family do not inflate the numeric score. Numeric confidence is a deterministic ranking score, not a calibrated probability.

Confidence labels are conservative. Weak-only evidence does not create a candidate. `high` requires a score of at least 0.85, a direct-use signal, at least two strong signal families, and strong runtime evidence observed across at least two distinct hosts and families. Static website signals alone are capped at `medium`, because scripts/forms can occur on marketing pages and demos. Even a high candidate remains unconfirmed and requires customer review; public website evidence does not establish production use or causality.

## Storage, tenant boundary, and retries

`discovered_dependencies` holds suggestions separately from confirmed `workspace_dependencies`. A later discovery refreshes only candidates still in candidate state; it never resets a user's confirm/reject decision. Discovery runs and signature-only evidence remain scoped to the workspace/company and protected by RLS. Trusted server operations perform writes. No HTML, JavaScript, response body, secrets, cookies, authorization headers, query values, or full source paths are stored.

The `discover-website-dependencies` Trigger task validates the company/workspace relationship before discovery, passes its cancellation signal through fetch phases, and uses bounded retries for transient failures. It logs counts and safe status only. Run completion and candidate persistence preserve existing idempotency and tenant ownership behavior.

## Evaluation and live use

`npm run eval:discovery` runs offline extractor, fetcher, static-signature, browser-adapter, privacy, resource-limit, coverage, and fusion fixtures. It makes no network requests and no paid calls. `npm run eval:discovery:live` is opt-in and requires `AUTERIM_DISCOVERY_LIVE=1`; named production cases are bounded public reads and do not persist fetched content. Live results are observations of those exact pages and scan budgets, not a complete dependency inventory.

Earlier TrustMRR and Cal.com production scans used the pre-runtime extractor. Their recorded coverage and candidates are historical baselines and should not be compared as if the new runtime pass had run. Re-run only through the approved bounded evaluation path after the production worker includes the new implementation.

## Database change

Migration `20261012000000_runtime_dependency_discovery.sql` extends the discovery evidence signal-type constraint for runtime observations. It does not add tenant data tables, alter candidate confirmation semantics, or change existing RLS ownership.
