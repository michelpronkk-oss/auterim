# Auterim architecture

## Product boundary

Auterim protects a company from meaningful external changes in the software and services it depends on. The first product job is to make important changes visible early with low noise. The foundation does not crawl sources, classify changes, run customer workflows, or send notifications yet.

## Global and tenant data

Future global data describes public providers and their authoritative sources:

- Dependency catalog
- Source catalog
- Source snapshots
- Detected changes

Future tenant data describes a customer's workspace and interpretation:

- Workspaces and members
- Companies and company context
- Selected dependencies and dependency context
- Impact assessments
- Notifications and feedback

Public source content should be fetched and normalized once for shared use. Tenant-specific context and impact assessments remain isolated by workspace.

## Intended change pipeline

`source → fetch → normalize → hash → snapshot → deterministic diff → semantic classifier → tenant impact → notification/action`

The stages will have explicit inputs and outputs. Stable normalized content and hashes make repeated fetches comparable; deterministic diffs separate observed content changes from later semantic judgments.

## Shared monitoring

If 2,000 customers depend on OpenAI, Auterim should fetch a public OpenAI pricing page once globally, then evaluate that change against each customer's dependency context. This reduces duplicated work and keeps public observations consistent across tenants.

## Future security architecture

- Enforce explicit multi-tenant isolation in every tenant-owned data path.
- Use Row Level Security (RLS) on exposed tenant tables.
- Keep Supabase secret/service-role credentials in server-only code.
- Never authorize a request only because it supplies a workspace ID; derive and verify membership on the server.
- Treat external connectors and their content as untrusted input. Never infer Auterim credentials or project selection from connector state.

## Future job architecture

Trigger.dev will eventually run durable, bounded jobs for source fetching, semantic classification, impact analysis, and notifications. Jobs should be idempotent, retryable, observable, and separated by responsibility. No Trigger project has been selected or authenticated, and this foundation includes no job definitions.

## Snapshot and history model

Snapshots should preserve the normalized source observation, content hash, fetch time, and source metadata needed for reproducibility. Changes should reference the before/after snapshots. Retention and payload storage can be selected after the source types and operating costs are understood.

## Deferred features

Database schema, migrations, RLS policies, Supabase Auth, source fetching, crawling, snapshots, diffing, semantic classification, tenant impact, notifications, email delivery, billing, AI, browser automation, connectors, and production deployment are deferred. The database milestone must wait for the dedicated Auterim Supabase environment to be explicitly configured and verified.
