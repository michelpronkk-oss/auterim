# Security boundaries

## Isolation and database access

Tenant tables are protected by workspace membership policies; global dependency catalogs, scan runs, snapshots, changes, and semantic classifications contain no tenant context and have no grants to `anon` or `authenticated`. RLS is enabled on the classification table. Its persistence/queue RPCs are revoked from client roles and granted only to `service_role`. Privileged Supabase access is server-only and reads the dedicated Auterim URL and server secret from this repository's environment.

## Source and AI input

Fetched HTML is parsed as inert text; scripts do not run. The fetcher limits protocols, DNS destinations, redirects, time, content type, and body size to reduce SSRF and resource-exhaustion risk. Raw bodies and request headers are not persisted. The classifier receives a bounded diff packet without customer/tenant data. URL credentials, path, query, and fragment are removed before provider submission.

All monitored content is untrusted data, even if it contains prompts, role claims, requests for secrets, or links. The classifier has no tools, and evidence is JSON encoded with escaped angle brackets. Output must pass strict Zod validation, typed evidence must match the declared deterministic diff side, and only structured summaries are persisted. These controls reduce prompt injection risk but cannot make probabilistic model judgments infallible.

## Failure and audit behavior

AI provider failures are recorded independently of scan evidence. Missing provider configuration is marked permanent and is not redispatched. Other failures receive bounded task retries and at most six total database claims. The source change, snapshots, and diff are not modified by classification. Logs avoid raw provider error messages to reduce the chance that request details or source text leak into logs.

## Customer impact isolation

Customer impact assessments have their own tenant-scoped table and do not modify global semantic classifications. The packet loader validates that the selected workspace dependency monitors the same dependency as the classification and returns only that workspace dependency's context. `impact_assessments` is readable only by workspace members through RLS; client roles have no write grant. Privileged writes and server-only context interfaces use the dedicated service role and must not be exposed directly to unauthenticated or client callers.

The impact classifier applies the untrusted-data rule to provider evidence and customer-supplied dependency context. It has no tools or web access, uses strict structured output with `store: false`, redacts secret-shaped context strings before transport, and rejects evidence references that do not match the selected packet.

## External-resource safeguards

Before remote database operations, the project identity checker and environment checker must pass and the Supabase ref must match the dedicated Auterim project. No account-wide project discovery is used. The GitHub remote is restricted by repository checks; this milestone does not require Vercel deployment, external Trigger execution, or Resend. Wanterest is outside the allowed project boundary and must remain untouched.
