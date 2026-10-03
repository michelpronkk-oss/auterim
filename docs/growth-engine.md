# Growth Engine Core V1

The Growth Engine converts customer-independent material provider changes into internal, evidence-backed growth opportunities. It does not publish pages, send messages, or read tenant impact, dependency selections, repository findings, billing records, or notifications.

## Data boundary and packet

`buildPublicIntelligencePacket` constructs a bounded packet from `dependency_catalog`, `source_catalog`, `source_changes`, and `source_change_classifications` only. It selects explicit columns and joins corroborating material classifications only when they match the same provider, category, affected public entity, effective date, and a 30-day detection window. Evidence keeps its original global source, change, classification, and excerpt references.

The strict versioned Zod schema rejects unknown fields. A separate public-safety validator checks URL protocol, host, private/customer-specific path segments, and text for secrets, private identifiers, code paths, email addresses, and embedded URLs. The persistence RPC rechecks each excerpt against the referenced classified evidence. An unsafe packet is not persisted as a public-ready opportunity.

## Deterministic evaluation

Policy `growth-policy-v1` and evaluator `growth-rules-v1` make deterministic decisions; no model call or paid AI request is made. Materiality and source evidence remain authoritative. Decisions are:

- `PUBLIC_PAGE`: only a high-intent, material change with strong confidence, distinct authoritative sources, a future effective date, a specific technical identifier in evidence, and a substantive summary. It is internal approval metadata only; no route/page is rendered.
- `HUB_UPDATE`: material, useful provider intelligence consolidated into the provider hub contract.
- `DISTRIBUTION_ONLY`: timely internal content opportunity without page/index intent. It receives structured future channel candidates, never an outbound send.
- `NOINDEX`: older evidence retained for internal/history use.
- `IGNORE`: non-material, weak, stale, unsafe, or unsupported opportunity.

Reasons, blockers, and explicit factors are stored per immutable evaluation. Policy/schema/evaluator versions are recorded so future reevaluations remain auditable. Topic identity uses provider, normalized category, affected entity, and effective date; when no effective date exists it uses the source-change ID. Stable hashes preserve distinctions such as `C` versus `C++`, and slug space is reserved for the event identity.

## Lifecycle, queue, and retries

Material classified changes enter `growth_evaluation_queue` through a database trigger. The migration also idempotently backfills at most 500 eligible material classifications from the previous 365 days. A scheduled Trigger.dev task runs every 15 minutes and processes at most 25 records per invocation. Claims use `SKIP LOCKED`, five-minute leases, attempt limits, and bounded retry delays. Obsolete work cleanup is capped at 100 rows per claim, and the claim query independently filters for currently eligible public classifications. Evaluation is global and does not fan out over customer workspaces or request tenant-specific scans.

Each provider/topic/event has one opportunity. Repeated identical evaluations reuse the same evaluation identity. Evidence changes append immutable evaluations/evidence. Ordering uses source-change and classification chronology plus policy/evaluator version so late older work does not replace newer state. Incompatible distribution candidates are marked stale, and all read contracts recheck the current evidence fingerprint and publication readiness.

## Internal read contracts

`src/lib/growth/read-models.ts` exposes server-only, cursor-paginated contracts for opportunity lists/details, canonical topics, distribution candidates, provider summaries, provider hubs, and future change pages. Read limits are capped; no public page or customer-facing dashboard is part of this milestone. Change-page contracts include safe general impact, affected public entities, authoritative evidence attribution, and CTA metadata.

Growth tables have RLS enabled with access revoked from `anon` and `authenticated`; only `service_role` can read/write the internal data or invoke evaluation/queue RPCs. There are no public routes exposing these models.

## Future integrations

Distribution candidates are structured records for review (channel, angle, claim boundaries, freshness, and evidence fingerprint). The engine does not publish or send them. Free-tool recommendations are metadata only, use noindex/nofollow link policy, and do not create tools or UI. Search Console feedback is implemented separately in Growth Engine V2; it cannot bypass this V1 public-safety and publication gate. See [Growth Engine V2](growth-engine-v2.md).

## Validation

Run `npm run eval:growth` for deterministic policy and database access tests. The growth evaluator has no live mode and does not consume OpenAI tokens. Standard project, lint, typecheck, test, prior milestone evaluation, formatting, and build gates remain required before migration/deployment.
