# M15.77 Impact Graph foundation

M15.77 turns a persisted provider-change route and an exact-commit Code Intelligence analysis into a versioned, explainable graph. It records potential code/Product impact only. Production exposure remains `unknown` in this graph and must come from exact M15.7 deployment evidence; this graph does not create customer impact or downstream work.

## Evidence layers

- **Observed** edges reference persisted M15.76 code relations, external references, code entities, exact analysis identity, or canonical Product/dependency mappings.
- **Inferred** edges are separately typed and retain the M15.75 decision, source classification where used, Product/repository mapping, dependency mapping, and matched external-reference IDs.
- No raw source body is copied into graph rows. Source paths and bounded line/column spans are retained as provenance.

The change matcher uses exact normalized typed entities from the latest classified source-change result and exact M15.76 structural references. Package namespace matching permits a statically known package subpath. Event, schema, endpoint, and SDK-symbol matches require an exact typed value; a route label or provider-domain match alone cannot create a change-to-code edge. A route-relevant reference that is not an exact match remains `unknown_incomplete`, not `absence_observed`.

## Coverage and exact commit

Builds pin the workspace, protected Product, active Product/repository mapping, active Product/dependency mapping, source change, route intent, decision, exact repository, completed Code Intelligence run, exact commit SHA, analyzer version/profile, policy version, and graph-builder version. Repeated builds use a unique identity across the source change, route, analysis run, Product/repository scope, and builder version.

Only complete `javascript-typescript-v2.3` runs with a recognized provider matcher can make a negative assessment. Earlier profiles remain valid positive evidence but are treated as partial for negative conclusions because they did not classify the expanded set of unsupported source extensions. Unsupported or unmatched route-relevant evidence blocks absence.

## Temporal and read model

Graph edges keep historical validity intervals. Edge `valid_from` is pinned to the graph build creation time. The completion RPC locks the source-change row, then expires older active edges or immediately bounds late-arriving stale edges at a newer completed generation's completion time. It never rewrites the source code facts or the old graph build.

`src/lib/impact-graph/query.ts` provides bounded, server-only read functions scoped by workspace and at least one Product/repository/source-change selector. It verifies the request bearer token and authenticated user's workspace membership before privileged reads. It can answer current and historical (`asOf`) graph queries. It reports Production exposure as unknown and returns no deployment-derived assertion.

## Current limits

- JavaScript/TypeScript M15.76 facts are consumed; this milestone does not add language adapters.
- Typed source-change entity matching is exact and intentionally conservative. Semantic near-matches are not promoted to impact.
- The graph does not infer runtime usage, deployed commit, customer impact, fixes, notifications, remediation, or PRs.
- Blast-radius scoring is represented by queryable graph evidence components; no opaque score is emitted.
