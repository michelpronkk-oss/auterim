import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite, type PGliteInterface } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  exposureAt,
  exposureForSurface,
  exposureIssueArguments,
  type ExposureEvidence,
} from "@/lib/coverage-certification/exposure";

const migrationsDirectory = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));

const OWNER = "a0000000-0000-4000-8000-000000000001";
const OUTSIDER = "a0000000-0000-4000-8000-000000000002";
const WORKSPACE = "b0000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE = "b0000000-0000-4000-8000-000000000002";
const PRODUCT = "c0000000-0000-4000-8000-000000000001";
const REPOSITORY = "f0000000-0000-4000-8000-000000000001";
const OTHER_REPOSITORY = "f0000000-0000-4000-8000-000000000002";
const GRAPH = "60000000-0000-4000-8000-000000000001";
const FOREIGN_GRAPH = "60000000-0000-4000-8000-000000000002";
const SURFACE = "20000000-0000-4000-8000-000000000001";
const OTHER_SURFACE = "20000000-0000-4000-8000-000000000002";
const EVIDENCE = "40000000-0000-4000-8000-000000000001";
const NEWER_EVIDENCE = "40000000-0000-4000-8000-000000000002";
const SYNC = "70000000-0000-4000-8000-000000000001";
const COMMIT = "94135df6f85bfb34ac83c046e5541e1ad8d73a86";
const OTHER_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const uuid = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function migratedDatabase() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.waitReady;
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create schema extensions;
    create extension pgcrypto with schema extensions;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz,
      raw_user_meta_data jsonb, created_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create function auth.role() returns text language sql stable as $$
      select nullif(current_setting('request.jwt.claim.role', true), '')
    $$;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean default false,
      file_size_limit bigint, allowed_mime_types text[]);
    grant usage on schema auth, storage, extensions to anon, authenticated, service_role;
    grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
  `);
  const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) await db.exec(await readFile(`${migrationsDirectory}${name}`, "utf8"));
  return db;
}

function graphRow(id: string, workspace: string, repository: string, n: number) {
  return `('${id}', '${workspace}', '${PRODUCT}', '${repository}', '${uuid(n + 1)}', '${uuid(n + 2)}', '${uuid(n + 3)}',
    '${uuid(n + 4)}', '${uuid(n + 5)}', '${COMMIT}', 'code-intelligence-v3', 'javascript-typescript-v2.3', 'graph-v1',
    'policy-v1', 'complete', 'FULL_SUPPORTED_PROFILE', 'evidence_present', 'completed', now(), 'graph-${id}')`;
}

/** A completed graph build with impacted code, and a fresh production-verified deployment of it. */
async function seed(db: PGliteInterface) {
  await db.exec("set session_replication_role = replica");
  await db.exec(`
    insert into auth.users(id) values ('${OWNER}'), ('${OUTSIDER}');
    insert into public.workspaces(id, name, created_by)
      values ('${WORKSPACE}', 'Acme', '${OWNER}'), ('${OTHER_WORKSPACE}', 'Other', '${OUTSIDER}');
    insert into public.workspace_members(workspace_id, user_id, role)
      values ('${WORKSPACE}', '${OWNER}', 'owner'), ('${OTHER_WORKSPACE}', '${OUTSIDER}', 'owner');
    insert into public.workspace_products(id, workspace_id, name, slug, status, protected_at)
      values ('${PRODUCT}', '${WORKSPACE}', 'App', 'app', 'protected', now());
    insert into public.repositories(id, workspace_id, connection_id, external_id, owner, name, default_branch, status, archived)
      values ('${REPOSITORY}', '${WORKSPACE}', gen_random_uuid(), 1, 'acme', 'app', 'main', 'available', false),
             ('${OTHER_REPOSITORY}', '${WORKSPACE}', gen_random_uuid(), 2, 'acme', 'api', 'main', 'available', false);
    insert into public.impact_graph_builds(id, workspace_id, product_id, repository_id, workspace_dependency_id,
      source_change_id, route_intent_id, intelligence_decision_id, analysis_run_id, commit_sha, analyzer_version,
      analysis_profile, graph_builder_version, policy_version, coverage_state, coverage_truth, assessment_state,
      status, completed_at, idempotency_key)
      values ${graphRow(GRAPH, WORKSPACE, REPOSITORY, 0)}, ${graphRow(FOREIGN_GRAPH, OTHER_WORKSPACE, REPOSITORY, 10)};
    insert into public.deployment_surfaces(id, workspace_id, installation_id, external_project_id, project_name, environment_scope)
      values ('${SURFACE}', '${WORKSPACE}', gen_random_uuid(), 'prj_1', 'app', 'production'),
             ('${OTHER_SURFACE}', '${WORKSPACE}', gen_random_uuid(), 'prj_2', 'api', 'production');
    insert into public.workspace_product_deployment_surfaces(workspace_id, protected_product_id, deployment_surface_id, repository_id, provenance)
      values ('${WORKSPACE}', '${PRODUCT}', '${SURFACE}', '${REPOSITORY}', 'protected_repository_identity'),
             ('${WORKSPACE}', '${PRODUCT}', '${OTHER_SURFACE}', '${OTHER_REPOSITORY}', 'protected_repository_identity');
    insert into public.product_deployment_evidence(id, workspace_id, protected_product_id, deployment_surface_id,
      deployment_observation_id, repository_id, verification_state, verified_commit_sha)
      values ('${EVIDENCE}', '${WORKSPACE}', '${PRODUCT}', '${SURFACE}', gen_random_uuid(), '${REPOSITORY}',
        'production_verified', '${COMMIT}');
    insert into public.deployment_sync_attempts(id, workspace_id, deployment_surface_id, status, started_at, completed_at)
      values ('${SYNC}', '${WORKSPACE}', '${SURFACE}', 'succeeded', now() - interval '1 hour', now() - interval '1 hour');
  `);
  await db.exec("set session_replication_role = origin");
}

/** Reads the rows exactly as the future exposure builder will. */
async function readEvidence(db: PGliteInterface, surface = SURFACE): Promise<ExposureEvidence> {
  const graph = (
    await db.query<Record<string, string>>(
      `select id, repository_id, status, assessment_state, analysis_profile, coverage_state, commit_sha
       from public.impact_graph_builds where id = '${GRAPH}'`,
    )
  ).rows[0]!;
  const evidence = (
    await db.query<Record<string, string | null>>(
      `select id, repository_id, verification_state, verified_commit_sha from public.product_deployment_evidence
       where workspace_id = '${WORKSPACE}' and protected_product_id = '${PRODUCT}' and deployment_surface_id = '${surface}'
       order by observed_at desc, id desc limit 1`,
    )
  ).rows[0];
  const sync = (
    await db.query<{ id: string; status: "succeeded" | "failed"; completed_at: Date }>(
      `select id, status, completed_at from public.deployment_sync_attempts
       where workspace_id = '${WORKSPACE}' and deployment_surface_id = '${surface}'
         and status in ('succeeded','failed') and completed_at is not null
       order by completed_at desc, id desc limit 1`,
    )
  ).rows[0];
  return {
    graph: {
      id: graph.id!,
      repositoryId: graph.repository_id!,
      status: graph.status as ExposureEvidence["graph"]["status"],
      assessmentState: graph.assessment_state as ExposureEvidence["graph"]["assessmentState"],
      analysisProfile: graph.analysis_profile!,
      coverageState: graph.coverage_state as ExposureEvidence["graph"]["coverageState"],
      commitSha: graph.commit_sha!,
    },
    surfaceId: surface,
    evidence: evidence
      ? {
          id: evidence.id!,
          repositoryId: evidence.repository_id!,
          verificationState: evidence.verification_state as NonNullable<
            ExposureEvidence["evidence"]
          >["verificationState"],
          verifiedCommitSha: evidence.verified_commit_sha,
        }
      : null,
    lastSync: sync
      ? { id: sync.id, status: sync.status, completedAt: new Date(sync.completed_at).toISOString() }
      : null,
  };
}

async function issue(db: PGliteInterface, args: Record<string, unknown>) {
  const names = Object.keys(args);
  const result = await db.query<{ value: Record<string, unknown> }>(
    `select public.issue_impact_exposure_assessment(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as value`,
    names.map((n) => args[n]),
  );
  return result.rows[0]!.value;
}

const argsFor = (evidence: ExposureEvidence, surface = SURFACE) =>
  exposureIssueArguments({
    workspaceId: WORKSPACE,
    graphBuildId: GRAPH,
    surfaceId: surface,
    exposure: exposureForSurface(evidence, new Date()),
  });

async function replica(db: PGliteInterface, sql: string) {
  await db.exec("set session_replication_role = replica");
  await db.exec(sql);
  await db.exec("set session_replication_role = origin");
}

describe("M15.79 Production exposure assessments (database)", { timeout: 120_000 }, () => {
  let migrated: PGlite;
  beforeAll(async () => {
    migrated = await migratedDatabase();
  }, 120_000);

  async function fresh() {
    const db = await migrated.clone();
    await seed(db);
    await db.query("select set_config('request.jwt.claim.role', 'service_role', false)");
    return db;
  }

  it("issues the evaluator's outcome, idempotently, and supersedes it when Production moves", async () => {
    const db = await fresh();
    const proven = exposureForSurface(await readEvidence(db), new Date());
    expect(proven).toMatchObject({
      state: "proven",
      reason: "deployed_commit_contains_impacted_code",
      evidenceId: EVIDENCE,
      syncAttemptId: SYNC,
    });
    const first = await issue(db, argsFor(await readEvidence(db)));
    expect(first).toMatchObject({ status: "issued", sequence: 1, exposureState: "proven" });
    expect(await issue(db, argsFor(await readEvidence(db)))).toEqual({
      ...first,
      status: "unchanged",
    });
    const row = (
      await db.query<Record<string, unknown>>("select * from public.impact_exposure_assessments")
    ).rows[0]!;
    expect(row).toMatchObject({
      product_id: PRODUCT,
      repository_id: REPOSITORY,
      analysis_commit_sha: COMMIT,
      deployed_commit_sha: COMMIT,
      product_deployment_evidence_id: EVIDENCE,
      deployment_sync_attempt_id: SYNC,
      contract_version: "exposure-v1",
    });
    expect(new Date(row.valid_until as string).toISOString()).toBe(proven.validUntil);

    // Production now runs another commit.
    await replica(
      db,
      `insert into public.product_deployment_evidence(id, workspace_id, protected_product_id, deployment_surface_id,
        deployment_observation_id, repository_id, verification_state, verified_commit_sha, observed_at)
       values ('${NEWER_EVIDENCE}', '${WORKSPACE}', '${PRODUCT}', '${SURFACE}', gen_random_uuid(), '${REPOSITORY}',
        'production_verified', '${OTHER_COMMIT}', now() + interval '1 minute')`,
    );
    const moved = await issue(db, argsFor(await readEvidence(db)));
    expect(moved).toMatchObject({ status: "issued", sequence: 2, exposureState: "unknown" });
    const second = (
      await db.query<Record<string, unknown>>(
        "select * from public.impact_exposure_assessments where sequence = 2",
      )
    ).rows[0]!;
    expect(second).toMatchObject({
      reason: "analysis_commit_not_deployed",
      supersedes_assessment_id: first.assessmentId,
      valid_until: null,
    });

    // A complete negative analysis at the deployed commit disproves exposure.
    await replica(
      db,
      `delete from public.product_deployment_evidence where id = '${NEWER_EVIDENCE}';
       update public.impact_graph_builds set assessment_state = 'absence_observed' where id = '${GRAPH}'`,
    );
    expect(await issue(db, argsFor(await readEvidence(db)))).toMatchObject({
      status: "issued",
      sequence: 3,
      exposureState: "disproven",
    });
  });

  it("rejects any claim that is not exactly the outcome of the cited, current evidence", async () => {
    const db = await fresh();
    const evidence = await readEvidence(db);
    const good = argsFor(evidence);
    const mismatches: Array<[string, Record<string, unknown>]> = [
      ["stronger state", { ...good, p_exposure_state: "disproven" }],
      [
        "wrong reason",
        { ...good, p_exposure_state: "unknown", p_reason: "graph_evidence_incomplete" },
      ],
      ["no evidence cited", { ...good, p_product_deployment_evidence_id: null }],
      ["other sync cited", { ...good, p_deployment_sync_attempt_id: uuid(99) }],
    ];
    for (const [label, args] of mismatches)
      await expect(issue(db, args), label).rejects.toThrow(/impact_exposure_assessment_mismatch/);

    // Superseded evidence cannot be cited, even at the same commit.
    await replica(
      db,
      `insert into public.product_deployment_evidence(id, workspace_id, protected_product_id, deployment_surface_id,
        deployment_observation_id, repository_id, verification_state, verified_commit_sha, observed_at)
       values ('${NEWER_EVIDENCE}', '${WORKSPACE}', '${PRODUCT}', '${SURFACE}', gen_random_uuid(), '${REPOSITORY}',
        'production_verified', '${COMMIT}', now() + interval '1 minute')`,
    );
    await expect(issue(db, good)).rejects.toThrow(/impact_exposure_assessment_mismatch/);

    // A stale sync no longer supports the proven claim.
    await replica(
      db,
      `delete from public.product_deployment_evidence where id = '${NEWER_EVIDENCE}';
       update public.deployment_sync_attempts set completed_at = now() - interval '25 hours'`,
    );
    await expect(issue(db, good)).rejects.toThrow(/impact_exposure_assessment_mismatch/);
    expect(exposureForSurface(await readEvidence(db), new Date())).toMatchObject({
      state: "unknown",
      reason: "deployment_not_production_verified",
    });

    // Another workspace's graph, and a surface linked to a different repository.
    await expect(issue(db, { ...good, p_graph_build_id: FOREIGN_GRAPH })).rejects.toThrow(
      /impact_exposure_graph_invalid/,
    );
    await expect(issue(db, { ...good, p_deployment_surface_id: OTHER_SURFACE })).rejects.toThrow(
      /impact_exposure_surface_invalid/,
    );
    expect(
      (
        await db.query<{ n: number }>(
          "select count(*)::int as n from public.impact_exposure_assessments",
        )
      ).rows[0]!.n,
    ).toBe(0);
  });

  it("treats evidence about another repository and unfinished graph builds as no evidence", async () => {
    const db = await fresh();
    await replica(
      db,
      `update public.product_deployment_evidence set repository_id = '${OTHER_REPOSITORY}'`,
    );
    const foreign = exposureForSurface(await readEvidence(db), new Date());
    expect(foreign).toMatchObject({
      state: "unknown",
      reason: "deployment_not_production_verified",
      evidenceId: null,
    });
    expect(await issue(db, argsFor(await readEvidence(db)))).toMatchObject({
      status: "issued",
      exposureState: "unknown",
    });

    const db2 = await fresh();
    await replica(
      db2,
      `update public.impact_graph_builds set status = 'building', completed_at = null where id = '${GRAPH}'`,
    );
    expect(exposureForSurface(await readEvidence(db2), new Date())).toMatchObject({
      state: "unknown",
      reason: "graph_evidence_incomplete",
    });
    expect(await issue(db2, argsFor(await readEvidence(db2)))).toMatchObject({
      exposureState: "unknown",
    });
  });

  it("is service-role only, append-only, member-readable and self-consistent", async () => {
    const db = await fresh();
    const good = argsFor(await readEvidence(db));
    await db.query("select set_config('request.jwt.claim.role', 'authenticated', false)");
    await expect(issue(db, good)).rejects.toThrow(/service_role_required/);
    await db.query("select set_config('request.jwt.claim.role', 'service_role', false)");
    await issue(db, good);
    await expect(
      db.exec("update public.impact_exposure_assessments set exposure_state = 'unknown'"),
    ).rejects.toThrow(/impact_exposure_assessment_immutable/);
    await expect(db.exec("delete from public.impact_exposure_assessments")).rejects.toThrow(
      /impact_exposure_assessment_immutable/,
    );

    // The table itself refuses a definite state without its evidence, even from the owner.
    await expect(
      db.exec(
        `insert into public.impact_exposure_assessments(workspace_id, graph_build_id, source_change_id, product_id,
          repository_id, analysis_commit_sha, deployment_surface_id, exposure_state, reason, contract_version, sequence,
          supersedes_assessment_id)
         select workspace_id, graph_build_id, source_change_id, product_id, repository_id, analysis_commit_sha,
          deployment_surface_id, 'disproven', 'complete_negative_analysis_at_deployed_commit', 'exposure-v1', 2, id
         from public.impact_exposure_assessments`,
      ),
    ).rejects.toThrow(/impact_exposure_definite_evidence/);

    const visible = async (user: string) => {
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user]);
      await db.exec("set role authenticated");
      try {
        return (
          await db.query<{ n: number }>(
            "select count(*)::int as n from public.impact_exposure_assessments",
          )
        ).rows[0]!.n;
      } finally {
        await db.exec("reset role");
      }
    };
    expect(await visible(OWNER)).toBe(1);
    expect(await visible(OUTSIDER)).toBe(0);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER]);
    await db.exec("set role authenticated");
    await expect(
      db.exec(
        "insert into public.impact_exposure_assessments(workspace_id) values (gen_random_uuid())",
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.query(
        `select public.issue_impact_exposure_assessment('${WORKSPACE}', '${GRAPH}', '${SURFACE}', null, null, 'unknown', 'graph_evidence_incomplete')`,
      ),
    ).rejects.toThrow(/permission denied/);
    await db.exec("reset role");
    await db.exec("set role anon");
    await expect(db.query("select * from public.impact_exposure_assessments")).rejects.toThrow(
      /permission denied/,
    );
    await db.exec("reset role");
  });

  it("computes the same outcome in SQL and TypeScript for every input combination", async () => {
    const db = await migrated.clone();
    const now = new Date("2026-10-24T12:00:00.000Z");
    const fresh = "2026-10-24T11:00:00.000Z";
    const stale = "2026-10-23T11:00:00.000Z";
    const evidences = [
      null,
      { verificationState: "production_verified" as const, verifiedCommitSha: COMMIT },
      { verificationState: "production_verified" as const, verifiedCommitSha: OTHER_COMMIT },
      { verificationState: "production_verified" as const, verifiedCommitSha: null },
      { verificationState: "commit_verified" as const, verifiedCommitSha: COMMIT },
    ];
    const syncs = [
      null,
      { status: "succeeded" as const, completedAt: fresh },
      { status: "succeeded" as const, completedAt: stale },
      { status: "failed" as const, completedAt: fresh },
    ];
    let checked = 0;
    for (const status of ["completed", "building"] as const)
      for (const assessmentState of [
        "evidence_present",
        "absence_observed",
        "unknown_incomplete",
        "failed",
      ] as const)
        for (const analysisProfile of ["javascript-typescript-v2.3", "javascript-typescript-v2.2"])
          for (const coverageState of ["complete", "partial", "unsupported", "failed"] as const)
            for (const evidence of evidences)
              for (const sync of syncs) {
                const ts = exposureForSurface(
                  {
                    graph: {
                      id: GRAPH,
                      repositoryId: REPOSITORY,
                      status,
                      assessmentState,
                      analysisProfile,
                      coverageState,
                      commitSha: COMMIT,
                    },
                    surfaceId: SURFACE,
                    evidence: evidence && { id: EVIDENCE, repositoryId: REPOSITORY, ...evidence },
                    lastSync: sync && { id: SYNC, ...sync },
                  },
                  now,
                );
                const sql = (
                  await db.query<{ outcome: string[] }>(
                    "select private.impact_exposure_outcome($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as outcome",
                    [
                      status,
                      assessmentState,
                      analysisProfile,
                      coverageState,
                      COMMIT,
                      evidence?.verificationState ?? null,
                      evidence?.verifiedCommitSha ?? null,
                      sync?.status ?? null,
                      sync?.completedAt ?? null,
                      now.toISOString(),
                    ],
                  )
                ).rows[0]!.outcome;
                expect(
                  sql,
                  JSON.stringify({
                    status,
                    assessmentState,
                    analysisProfile,
                    coverageState,
                    evidence,
                    sync,
                  }),
                ).toEqual([ts.state, ts.reason]);
                // A definite state needs a fresh production-verified deployment of the analysed commit.
                if (ts.state !== "unknown") {
                  expect(evidence?.verificationState).toBe("production_verified");
                  expect(evidence?.verifiedCommitSha).toBe(COMMIT);
                  expect(sync).toMatchObject({ status: "succeeded", completedAt: fresh });
                  expect(status).toBe("completed");
                }
                if (ts.state === "disproven") {
                  expect(assessmentState).toBe("absence_observed");
                  expect(analysisProfile).toBe("javascript-typescript-v2.3");
                  expect(coverageState).toBe("complete");
                }
                checked += 1;
              }
    expect(checked).toBe(2 * 4 * 2 * 4 * 5 * 4);
  });

  it("treats an expired definite assessment as unknown", () => {
    const at = new Date("2026-10-24T12:00:00.000Z");
    expect(
      exposureAt({ exposureState: "proven", validUntil: "2026-10-24T13:00:00.000Z" }, at),
    ).toBe("proven");
    expect(
      exposureAt({ exposureState: "proven", validUntil: "2026-10-24T12:00:00.000Z" }, at),
    ).toBe("unknown");
    expect(exposureAt({ exposureState: "disproven", validUntil: null }, at)).toBe("unknown");
  });
});
