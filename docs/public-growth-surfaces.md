# Public acquisition surfaces

Milestone 13 adds public product pages around Auterim’s existing dependency discovery and Growth Engine. It does not add a separate monitoring system, tenant data export, or an external analytics vendor.

## Routes and conversion

- `/` explains the product from external change through materiality, customer context, repository verification, deadlines, and grounded action.
- `/tools/stack-scanner` submits a company homepage to `POST /api/public/stack-scan`. It uses the existing safe URL discovery implementation in fast-pass mode. It never writes anonymous data to a company, workspace, or discovery-history table.
- A scan result links to signup while carrying the normalized-to-origin website input and allowlisted UTM fields. After signup or email verification, the existing workspace setup screen pre-fills the website. Authenticated onboarding remains responsible for creating the workspace and running its normal discovery lifecycle; public candidates never become confirmed dependencies.
- `/changes` and `/changes/{provider}` show only global provider data meeting the public approval policy. `/changes/{provider}/{slug}` serves only a current, approved, indexable `PUBLIC_PAGE` whose canonical Growth Engine slug and provider both match.
- `/tools/dependency-exposure` reports enabled source-catalog coverage; `/tools/deprecation-checker` filters only currently approved public evidence. Both state when no evidence is available rather than generating a summary.
- `/pricing` uses `PLAN_CATALOG`; its copy states that the five-day Pro trial starts only after protection activation.

## Public/private boundary

The public intelligence projection is server-only. It selects only fields required to render public provider updates, approved change pages, source coverage, and the tools directory. Growth evaluation histories, safety blockers, distribution candidates, database identifiers, customer selections, impact assessments, repository scans, connector data, billing, and notifications are not returned. Provider and change text is checked again by `validatePublishableFields` before projection. Public source URLs are linked to their original global catalog source.

Provider hubs include only enabled providers with `PUBLIC_PAGE` or `HUB_UPDATE` decisions, `approved_by_engine`, `publication_ready`, current/upcoming/recent freshness, and source verification no older than 45 days. Hubs require at least two approved updates. Indexable change routes require an enabled provider, `PUBLIC_PAGE`, `indexable`, and the same freshness window. Stale, superseded, unknown, unsafe, or thin routes return not found and are not added to the sitemap. No route claims that global evidence proves a customer's use or impact.

The stack scanner returns provider name, confidence, signal count, and signal types. It does not return scanned customer origins, raw evidence, or HTML. It uses the existing SSRF-protected DNS pinning, redirect checks, standard-port policy, response bounds, and deterministic signatures. The endpoint is fast-pass only and the result is not persisted.

## SEO and caching

Public pages have canonical URLs, server-rendered metadata, internal links, and responsive semantic layouts. The sitemap contains stable public pages plus provider hubs and current approved indexable changes only. Robots disallows dashboard, API, auth, and account routes; signup/login/reset and the interactive scanner have noindex metadata. Public Growth Engine reads use a five-minute Next.js cache; no live provider or model calls are made while rendering. If the global intelligence read is unavailable, public lists and tools use honest empty states rather than failing the marketing site. Scan responses are `no-store`.

## Attribution and events

`src/lib/public/conversion.ts` defines the first-party event names `homepage_view`, `stack_scan_started`, `stack_scan_completed`, `scan_result_continue`, `signup_started`, `signup_completed`, `protection_activation`, `github_connect_started`, `github_connected`, and `trial_started`. The browser dispatches `auterim:public-conversion` with bounded `utm_source`, `utm_medium`, `utm_campaign`, and landing-path fields. No third-party analytics script is loaded and no raw query strings are captured. The browser event contract is a local integration seam; durable funnel reporting is not part of this milestone.

## Abuse controls and storage

Public scans are capped at four per IP key per 30-minute process-local window, with a 10,000-entry bound and generic failures. IP addresses are hashed in memory and never returned or persisted. This in-process limiter is best-effort on multi-instance/serverless deployments; the next operational step before high-volume promotion is wiring the same policy to a shared rate-limit store. Anonymous scans do not create database rows, so no migration or RLS policy changed.

Tool source counts are derived from enabled `source_catalog` rows. The query is bounded at 500 source rows; if the exact catalog count indicates more rows than returned, the tool labels displayed totals as lower bounds. No count is estimated. Public pages are reviewed through the offline route, scanner projection, safe-public-text, plan-catalog, and rate-limit tests in `tests/public-growth.test.ts` plus the full milestone evaluation suite.
