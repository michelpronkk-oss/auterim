# M15.79 Coverage Certification and Runtime Exposure Evidence (design)

Status: proposed. No schema or runtime change is made by this document.

## Problem

Auterim already produces strong evidence, but no single, versioned statement tells a
customer what is protected, how strongly, and as of which commit and deployment:

- provider source coverage is labelled per provider (strong / partial / pending /
  unknown, [provider catalog](provider-catalog.md));
- Code Intelligence records `coverage_state` per exact-commit analysis
  (`complete | partial | unsupported | failed`);
- the Impact Graph records `assessment_state`
  (`evidence_present | absence_observed | unknown_incomplete | failed`) but keeps
  `production_exposure_state = unknown` ([M15.77](m1577-impact-graph.md));
- M15.7 can prove that an exact commit is the current Production deployment
  (`product_deployment_evidence.verification_state = production_verified`,
  [deployment surfaces](deployment-surfaces.md));
- Fix Runs can only record `production_exposure_state = 'unknown'`.

M15.79 joins these into **per-Product coverage certificates** and **exposure
assessments**, and makes every customer-visible protection claim derive from them.

## Principles

1. **Never stronger than the evidence.** Each dimension takes the weakest applicable
   state; a Product claim takes the weakest of its required dimensions.
2. **Absence of evidence is `unknown`, never a negative.** Stale, missing, truncated or
   unreadable evidence degrades to `unknown`.
3. **Append-only facts.** Certificates and exposure assessments are new immutable rows
   that reference existing evidence by ID. Graph builds, Fix Runs and the M15.78R
   acceptance evidence are not rewritten.
4. **Exact identity.** Code evidence is pinned to repository ID and commit SHA;
   deployment evidence to the provider deployment ID, commit and observation; source
   evidence to source IDs and scan IDs.
5. **Optional providers limit strength, not availability.** Without a runtime provider
   (Sentry and others), GitHub plus Vercel protection still certifies; the runtime
   dimension is `unknown` and caps the claim at "deployment-verified".
6. **Tenant isolation by construction.** Composite `(id, workspace_id)` foreign keys,
   member-read RLS, service-role-only writes through security-definer RPCs, global
   source records referenced only by ID.

## What exists vs what is new

| Capability                                                             | Exists                   | New in M15.79                                     |
| ---------------------------------------------------------------------- | ------------------------ | ------------------------------------------------- |
| Protected Products, Product↔repository and Product↔dependency mappings | yes                      | none                                              |
| Provider source coverage labels                                        | yes (catalog read)       | mapping to certificate states plus scan freshness |
| Exact-commit code analysis with `coverage_state`                       | yes                      | "analysed at the deployed or head commit" check   |
| Impact graph with assessment states                                    | yes                      | none (read only)                                  |
| Production-verified deployment evidence                                | yes (Vercel)             | none (read only)                                  |
| Per-Product certificate                                                | no                       | tables, builder, RPC, read API                    |
| Exposure assessment                                                    | no                       | table, evaluator, propagation                     |
| Fix Run exposure                                                       | constrained to `unknown` | linked assessment snapshot with provenance        |
| Customer claim text                                                    | ad hoc                   | generated only from a certificate                 |

## Certificate model

### States

Ordered from strongest to weakest: `complete` > `partial` > `unsupported` > `unknown`.

- `complete`: evidence exists, is fresh, is exact-identity, and covers the subject.
- `partial`: fresh exact evidence covers part of the subject (for example one of
  several source types, or an analysis with skipped files).
- `unsupported`: Auterim knows it cannot cover the subject (for example a pnpm
  lockfile, an unsupported language, or a provider without sources). This is explicit and
  customer-visible, not hidden.
- `unknown`: no evidence, stale evidence, failed evidence or an incomplete read.

### Dimensions (per Product)

| Dimension                    | Subjects                                           | Inputs                                                       | Freshness bound                                                                                      |
| ---------------------------- | -------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `dependency_sources`         | each confirmed workspace dependency of the Product | enabled `source_catalog` rows and latest successful scans    | last successful scan within 48 h of issuance                                                         |
| `repository_code`            | each active Product↔repository mapping             | latest completed `code_analysis_runs`                        | analysis commit equals the repository head commit, or the production-verified commit when one exists |
| `deployment_exposure`        | each Product deployment surface                    | `product_deployment_evidence` and `deployment_sync_attempts` | latest sync succeeded within 24 h                                                                    |
| `runtime_signals` (optional) | connected runtime providers                        | none in M15.79                                               | always `unknown` until a runtime adapter exists; never blocks                                        |

Each subject has a deterministic state from a pure evaluator with explicit `reason`
codes (for example `no_successful_scan`, `analysis_commit_behind_head`,
`lockfile_unsupported`, `sync_stale`, `alias_ambiguous`).

`dependency_sources` maps the existing catalog labels (provider catalog: three or more
distinct enabled source types is _strong_, one or two _partial_, none _pending_) and then
applies scan freshness:

| Catalog label                     | Every enabled source has a successful scan within 48 h | Otherwise                                       |
| --------------------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| strong                            | `complete`                                             | `unknown` (`no_successful_scan` / `scan_stale`) |
| partial                           | `partial`                                              | `unknown`                                       |
| pending (no sources)              | `unsupported` (`no_configured_sources`)                | `unsupported`                                   |
| unknown (incomplete catalog read) | `unknown`                                              | `unknown`                                       |

### Tables (append-only)

- `product_coverage_certificates`: `id`, `workspace_id`, `product_id`,
  `contract_version` (`coverage-cert-v1`), `sequence` (per Product, monotonically
  increasing), `issued_at`, `valid_until` (the minimum freshness bound across subjects),
  `overall_state`, `claim_level` (below), `components_fingerprint`
  (sha256 of the canonical component JSON), `supersedes_certificate_id`. Unique on
  `(product_id, sequence)`. Update/delete rejected by trigger.
- `product_coverage_certificate_components`: `certificate_id`, `workspace_id`,
  `dimension`, `subject_type`, `subject_id`, `state`, `reason`, `evidence_refs`
  (bounded JSON of IDs: source/scan IDs, analysis run ID plus commit, deployment
  evidence plus observation ID plus commit), `observed_at`, `expires_at`.

Issuance happens only through `issue_product_coverage_certificate(product_id, ...)`
(service role). It recomputes the components inside the transaction from current rows,
so a caller cannot supply states, and returns the existing certificate when the
fingerprint is unchanged (idempotent).

## Exposure verification

`impact_exposure_assessments` (append-only): `graph_build_id`, `workspace_id`,
`product_id`, `repository_id`, `analysis_commit_sha`, `exposure_state`
(`proven | disproven | unknown`), `reason`, `product_deployment_evidence_id` (nullable),
`deployed_commit_sha` (nullable), `certificate_id`, `assessed_at`, `contract_version`.

Rules, evaluated by a pure function with table-driven tests:

| Situation                                                                                                                                   | Exposure                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Graph `evidence_present`, the Product has a fresh `production_verified` deployment whose verified commit equals the graph's analysis commit | `proven`                                                                                |
| Graph `absence_observed` from a complete `javascript-typescript-v2.3` analysis at the fresh production-verified commit                      | `disproven`                                                                             |
| Deployed commit differs from the analysed commit                                                                                            | `unknown` (`analysis_commit_not_deployed`); triggers re-analysis at the deployed commit |
| No deployment surface, stale sync, ambiguous alias, preview/failed deployment only                                                          | `unknown`                                                                               |
| Graph `unknown_incomplete` or `failed`                                                                                                      | `unknown`                                                                               |

`disproven` therefore needs both a complete negative analysis and proof that the
analysed commit is what runs in Production. No other combination produces a negative.

### Propagation to Fix Runs

- `fix_runs.production_exposure_state` stays as created (historical rows remain
  `unknown`).
- New Fix Runs snapshot the latest exposure assessment for their graph build at
  creation: a nullable `exposure_assessment_id` plus the copied state. A check
  constraint requires `unknown` when the ID is null, and allows `proven`/`disproven`
  only with a matching assessment in the same workspace, Product, graph build and
  commit.
- Later assessments are new rows; a Fix Run read model shows "exposure at start" and
  "latest exposure" separately.
- Existing Fix Engine gates are unchanged. Exposure informs risk and prioritisation;
  a future customer-facing Draft PR stage additionally requires a valid certificate.

## Customer-visible claims

`claim_level` is computed from the certificate and is the only input to claim text:

| Claim level                      | Requires                                                                     | Example wording                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `deployment_verified_protection` | every required dimension `complete`, a production-verified deployment, fresh | "Protected: monitored dependencies, code analysed at the commit running in Production."           |
| `code_verified_protection`       | sources and code `complete`; deployment not `complete`                       | "Protected at commit abc123; Production deployment not verified."                                 |
| `partial_protection`             | any required dimension `partial` or `unsupported`                            | "Partially protected: 3 of 5 dependencies have monitored sources; pnpm repository not supported." |
| `unverified`                     | sources or code `unknown`, or certificate expired                            | "Protection not currently verified."                                                              |

Unknown deployment evidence caps the claim at code-verified rather than hiding code
and source coverage that exists. Required dimensions are `dependency_sources`, `repository_code` and
`deployment_exposure`; `runtime_signals` is optional and only adds a "runtime-verified"
qualifier when present. A claim never states "no impact" unless the specific finding
has `disproven` exposure. The claim generator takes only the certificate (no other
inputs), and a property test asserts no generated claim exceeds its certificate.

## Tenant isolation, RLS and tests

- All new tables carry `workspace_id` with composite foreign keys to the workspace's
  Product, repository, graph build and deployment evidence rows; cross-tenant
  references fail at the database.
- RLS: authenticated workspace members can select; only `service_role` writes, through
  the issuing RPCs; no update or delete (immutability triggers).
- PGlite tests (repo convention): member versus non-member reads; cross-workspace
  reference rejection; immutability; idempotent issuance by fingerprint; staleness
  degrading to `unknown`; every row of the exposure rule table; Fix Run
  snapshot constraint; claim generator never exceeding its certificate.

## Implementation sequence (small, independently testable PRs)

1. **Contracts and pure evaluators** (no DB): state lattice, per-dimension evaluators,
   freshness, exposure rules, claim generator, canonical fingerprint. Unit and property
   tests. Smallest reviewable core.
2. **Certificate schema**: two tables, RLS, immutability, issuing RPC that recomputes
   components from existing rows. PGlite tests.
3. **Certificate builder and read API**: server lib plus a scheduled and post-sync
   Trigger task issuing certificates; `GET /api/products/{id}/coverage-certificate`
   (member-authorized). No UI.
4. **Exposure assessments**: table, evaluator wired to graph builds and
   `product_deployment_evidence`, re-analysis request when the deployed commit differs.
5. **Fix Run exposure snapshot**: migration (nullable FK plus constraint), creation-time
   snapshot, read model. Fix Engine gates unchanged.
6. **Customer claims**: protection graph read model and UI copy driven only by
   `claim_level`.
7. **End-to-end acceptance** on the internal QA Product (see below).

Optional integrations (Sentry, Linear, Slack) come after step 6 and only feed the
optional `runtime_signals` dimension or notifications.

### Smallest end-to-end certified path

Internal QA Product `de1f2a12…` with repository `auterim-m15-github-qa` and its
confirmed OpenAI dependency. OpenAI has three enabled source types (pricing,
changelog, deprecation), so it is _strong_ and maps to `complete` when every source has
a successful scan within 48 h.

**Prerequisite (not yet in place):** no Vercel project currently deploys the QA
repository. One must be created, connected through the Vercel connector and selected for
the QA Product before the deployment dimension can be anything but `unknown`.

Path: sync the deployment (production_verified at the fixture commit), analyse at that
commit, issue a certificate, assess exposure for the M15.78R graph build `382d7644…`
(expected `proven` when the deployed commit equals `94135df6…`), and render the claim.
Expected claim level: `deployment_verified_protection` when the Vercel prerequisite is
met and all inputs are fresh; `code_verified_protection` before it is met. Either
outcome is a valid acceptance result as long as it matches the evidence.

## Acceptance criteria

1. A certificate is issued for the QA Product with exact identities for every subject and
   a stable fingerprint; reissuing without evidence changes returns the same certificate.
2. Ageing any input past its freshness bound degrades that component to `unknown` and
   the claim to `unverified` on the next issuance.
3. Exposure for graph build `382d7644…` is `proven` only with a fresh production-verified
   deployment at the analysed commit; changing the deployed commit yields `unknown`
   with `analysis_commit_not_deployed`.
4. No code path can produce `disproven` without a complete negative analysis at the
   production-verified commit (rule-table tests plus database constraint).
5. A non-member cannot read any certificate, component or assessment; cross-workspace
   references are rejected by the database.
6. Every customer-visible protection sentence is generated from a certificate, and the
   property test shows none exceeds its certificate.
7. No Sentry, Linear or Slack connection is required for steps 1–7.
8. M15.78R acceptance evidence and historical graph and Fix Run rows are unchanged.

## Non-goals

Runtime provider adapters, customer-facing Draft PRs, multi-language analysers and
pnpm/Yarn verification. Each needs its own milestone and is represented here only as
`unsupported` or `unknown`.
