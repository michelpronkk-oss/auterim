import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite, type PGliteInterface } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  COVERAGE_STATES,
  type CoverageCertificate,
  type SubjectEvaluation,
} from "@/lib/coverage-certification/contracts";
import {
  buildCertificate,
  claimLevelFor,
  evaluateDependencySources,
  evaluateDeploymentExposure,
  evaluateRepositoryCode,
  evaluateRuntimeSignals,
  weakestState,
} from "@/lib/coverage-certification/evaluate";
import { certificateIssueArguments } from "@/lib/coverage-certification/issue";

const migrationsDirectory = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));

const OWNER = "a0000000-0000-4000-8000-000000000001";
const OUTSIDER = "a0000000-0000-4000-8000-000000000002";
const WORKSPACE = "b0000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE = "b0000000-0000-4000-8000-000000000002";
const PRODUCT = "c0000000-0000-4000-8000-000000000001";
const OTHER_PRODUCT = "c0000000-0000-4000-8000-000000000002";
const CATALOG = "d0000000-0000-4000-8000-000000000001";
const DEPENDENCY = "e0000000-0000-4000-8000-000000000001";
const OTHER_DEPENDENCY = "e0000000-0000-4000-8000-000000000002";
const REPOSITORY = "f0000000-0000-4000-8000-000000000001";
const OTHER_REPOSITORY = "f0000000-0000-4000-8000-000000000002";
const ANALYSIS = "10000000-0000-4000-8000-000000000001";
const OTHER_ANALYSIS = "10000000-0000-4000-8000-000000000002";
const SURFACE = "20000000-0000-4000-8000-000000000001";
const OBSERVATION = "30000000-0000-4000-8000-000000000001";
const EVIDENCE = "40000000-0000-4000-8000-000000000001";
const SOURCES = [
  ["50000000-0000-4000-8000-000000000001", "pricing"],
  ["50000000-0000-4000-8000-000000000002", "changelog"],
  ["50000000-0000-4000-8000-000000000003", "deprecation"],
] as const;
const COMMIT = "94135df6f85bfb34ac83c046e5541e1ad8d73a86";

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

/** A protected Product with fresh provider sources, a complete analysis and a verified deployment. */
async function seed(db: PGliteInterface) {
  await db.exec("set session_replication_role = replica");
  await db.exec(`
    insert into auth.users(id) values ('${OWNER}'), ('${OUTSIDER}');
    insert into public.workspaces(id, name, created_by)
      values ('${WORKSPACE}', 'Acme', '${OWNER}'), ('${OTHER_WORKSPACE}', 'Other', '${OUTSIDER}');
    insert into public.workspace_members(workspace_id, user_id, role)
      values ('${WORKSPACE}', '${OWNER}', 'owner'), ('${OTHER_WORKSPACE}', '${OUTSIDER}', 'owner');
    insert into public.workspace_products(id, workspace_id, name, slug, status, protected_at)
      values ('${PRODUCT}', '${WORKSPACE}', 'App', 'app', 'protected', now()),
             ('${OTHER_PRODUCT}', '${OTHER_WORKSPACE}', 'App', 'app', 'protected', now());
    insert into public.dependency_catalog(id, slug, name, category, website_url)
      values ('${CATALOG}', 'openai-test', 'OpenAI', 'ai', 'https://openai.com');
    insert into public.source_catalog(id, dependency_id, name, source_type, url, enabled, last_success_at)
      values ${SOURCES.map(([id, type]) => `('${id}', '${CATALOG}', '${type}', '${type}', 'https://example.com/${type}', true, now() - interval '1 hour')`).join(", ")};
    insert into public.workspace_dependencies(id, workspace_id, dependency_id, selected_by, protected_product_id, monitoring_enabled)
      values ('${DEPENDENCY}', '${WORKSPACE}', '${CATALOG}', '${OWNER}', '${PRODUCT}', true),
             ('${OTHER_DEPENDENCY}', '${OTHER_WORKSPACE}', '${CATALOG}', '${OUTSIDER}', '${OTHER_PRODUCT}', true);
    insert into public.repositories(id, workspace_id, connection_id, external_id, owner, name, default_branch, status, archived)
      values ('${REPOSITORY}', '${WORKSPACE}', gen_random_uuid(), 1, 'acme', 'app', 'main', 'available', false),
             ('${OTHER_REPOSITORY}', '${OTHER_WORKSPACE}', gen_random_uuid(), 2, 'other', 'app', 'main', 'available', false);
    insert into public.workspace_product_repositories(workspace_id, protected_product_id, repository_id, provenance, status)
      values ('${WORKSPACE}', '${PRODUCT}', '${REPOSITORY}', 'user_selected', 'active');
    insert into public.code_analysis_runs(id, workspace_id, product_id, repository_id, provider_repository_identity,
      commit_sha, analyzer_version, language_profile, analysis_profile, idempotency_key, status, coverage_state, completed_at)
      values ('${ANALYSIS}', '${WORKSPACE}', '${PRODUCT}', '${REPOSITORY}', 'acme/app', '${COMMIT}', 'code-intelligence-v3',
              'javascript-typescript', 'javascript-typescript-v2.3', 'k1', 'completed', 'complete', now()),
             ('${OTHER_ANALYSIS}', '${OTHER_WORKSPACE}', '${OTHER_PRODUCT}', '${OTHER_REPOSITORY}', 'other/app', '${COMMIT}',
              'code-intelligence-v3', 'javascript-typescript', 'javascript-typescript-v2.3', 'k2', 'completed', 'complete', now());
    insert into public.deployment_surfaces(id, workspace_id, installation_id, external_project_id, project_name, environment_scope)
      values ('${SURFACE}', '${WORKSPACE}', gen_random_uuid(), 'prj_1', 'app', 'production');
    insert into public.workspace_product_deployment_surfaces(workspace_id, protected_product_id, deployment_surface_id, repository_id, provenance)
      values ('${WORKSPACE}', '${PRODUCT}', '${SURFACE}', '${REPOSITORY}', 'protected_repository_identity');
    insert into public.product_deployment_evidence(id, workspace_id, protected_product_id, deployment_surface_id,
      deployment_observation_id, repository_id, verification_state, verified_commit_sha)
      values ('${EVIDENCE}', '${WORKSPACE}', '${PRODUCT}', '${SURFACE}', '${OBSERVATION}', '${REPOSITORY}', 'production_verified', '${COMMIT}');
    insert into public.deployment_sync_attempts(workspace_id, deployment_surface_id, status, started_at, completed_at)
      values ('${WORKSPACE}', '${SURFACE}', 'succeeded', now() - interval '1 hour', now() - interval '1 hour');
  `);
  await db.exec("set session_replication_role = origin");
}

type Evidence = {
  sources: Array<{ sourceId: string; sourceType: string; lastSuccessAt: string | null }>;
  syncCompletedAt: string;
};

/** Reads the stored evidence timestamps, exactly as the certificate builder will. */
async function readEvidence(db: PGliteInterface): Promise<Evidence> {
  const sources = await db.query<{ id: string; source_type: string; last_success_at: Date | null }>(
    `select id, source_type, last_success_at from public.source_catalog
     where dependency_id = '${CATALOG}' and enabled and source_mode = 'provider' order by id`,
  );
  const sync = await db.query<{ completed_at: Date }>(
    `select completed_at from public.deployment_sync_attempts order by completed_at desc limit 1`,
  );
  return {
    sources: sources.rows.map((row) => ({
      sourceId: row.id,
      sourceType: row.source_type,
      lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
    })),
    syncCompletedAt: new Date(sync.rows[0]!.completed_at).toISOString(),
  };
}

function components(
  evidence: Evidence,
  overrides: Partial<Record<string, SubjectEvaluation>> = {},
) {
  const now = new Date();
  return [
    overrides.sources ??
      evaluateDependencySources({
        dependencyId: DEPENDENCY,
        catalogReadComplete: true,
        sources: evidence.sources,
        now,
      }),
    overrides.code ??
      evaluateRepositoryCode({
        repositoryId: REPOSITORY,
        analysis: {
          runId: ANALYSIS,
          commitSha: COMMIT,
          status: "completed",
          coverageState: "complete",
        },
        headCommitSha: COMMIT,
        productionCommitSha: COMMIT,
      }),
    overrides.deployment ??
      evaluateDeploymentExposure({
        surfaceId: SURFACE,
        evidence: {
          evidenceId: EVIDENCE,
          verificationState: "production_verified",
          verifiedCommitSha: COMMIT,
        },
        lastSync: { status: "succeeded", completedAt: evidence.syncCompletedAt },
        now,
      }),
    evaluateRuntimeSignals(),
  ];
}

async function issue(
  db: PGliteInterface,
  certificate: CoverageCertificate,
  extra: Record<string, unknown> = {},
) {
  const args = {
    ...certificateIssueArguments({ workspaceId: WORKSPACE, productId: PRODUCT, certificate }),
    ...extra,
  };
  const names = Object.keys(args);
  const result = await db.query<{ value: Record<string, unknown> }>(
    `select public.issue_product_coverage_certificate(${names.map((name, index) => `${name} => $${index + 1}`).join(", ")}) as value`,
    names.map((name) =>
      typeof args[name as keyof typeof args] === "object"
        ? JSON.stringify(args[name as keyof typeof args])
        : args[name as keyof typeof args],
    ),
  );
  return result.rows[0]!.value;
}

const asServiceRole = (db: PGliteInterface) =>
  db.query("select set_config('request.jwt.claim.role', 'service_role', false)");

describe("M15.79 coverage certificates (database)", { timeout: 60_000 }, () => {
  let migrated: PGlite;
  beforeAll(async () => {
    migrated = await migratedDatabase();
  }, 180_000);

  async function fresh() {
    const db = await migrated.clone();
    await seed(db);
    await asServiceRole(db);
    return { db, evidence: await readEvidence(db) };
  }

  it("issues a certificate whose stored states and claim match the evaluator, idempotently", async () => {
    const { db, evidence } = await fresh();
    const certificate = buildCertificate({
      components: components(evidence),
      issuedAt: new Date(),
    });
    expect(certificate.claimLevel).toBe("deployment_verified_protection");
    const first = await issue(db, certificate);
    expect(first).toMatchObject({
      status: "issued",
      sequence: 1,
      claimLevel: certificate.claimLevel,
    });
    const row = (
      await db.query<Record<string, unknown>>("select * from public.product_coverage_certificates")
    ).rows[0]!;
    expect(row).toMatchObject({
      dependency_sources_state: certificate.dimensions.dependency_sources,
      repository_code_state: certificate.dimensions.repository_code,
      deployment_exposure_state: certificate.dimensions.deployment_exposure,
      runtime_signals_state: "unknown",
      overall_state: certificate.overallState,
      claim_level: certificate.claimLevel,
      components_fingerprint: certificate.componentsFingerprint,
      component_count: 4,
      supersedes_certificate_id: null,
    });
    expect(new Date(row.valid_until as string).toISOString()).toBe(certificate.validUntil);

    const again = buildCertificate({ components: certificate.components, issuedAt: new Date() });
    expect(await issue(db, again)).toEqual({ ...first, status: "unchanged" });

    const weaker = buildCertificate({
      components: components(evidence, {
        code: evaluateRepositoryCode({
          repositoryId: REPOSITORY,
          analysis: {
            runId: ANALYSIS,
            commitSha: COMMIT,
            status: "completed",
            coverageState: "partial",
          },
          headCommitSha: COMMIT,
          productionCommitSha: COMMIT,
        }),
      }),
      issuedAt: new Date(),
    });
    expect(await issue(db, weaker)).toMatchObject({
      status: "issued",
      sequence: 2,
      claimLevel: "partial_protection",
    });
    const second = (
      await db.query<{ supersedes_certificate_id: string }>(
        "select supersedes_certificate_id from public.product_coverage_certificates where sequence = 2",
      )
    ).rows[0]!;
    expect(second.supersedes_certificate_id).toBe(first.certificateId);
  });

  it("rejects claims stronger than the referenced evidence", async () => {
    const { db, evidence } = await fresh();
    const cases: Array<[string, () => Promise<void> | void, SubjectEvaluation[]]> = [];
    const strongSources = components(evidence)[0]!;

    // A stale provider source cannot support fresh source coverage.
    cases.push([
      "stale source",
      async () => {
        await db.exec(
          `update public.source_catalog set last_success_at = now() - interval '3 days' where id = '${SOURCES[0][0]}'`,
        );
      },
      components(evidence, { sources: strongSources }),
    ]);
    for (const [label, mutate, list] of cases) {
      await mutate();
      await expect(
        issue(db, buildCertificate({ components: list, issuedAt: new Date() })),
        label,
      ).rejects.toThrow(/coverage_certificate_claim_exceeds_evidence/);
    }
    await db.exec(`update public.source_catalog set last_success_at = now() - interval '1 hour'`);

    // Deployment claimed complete while the evidence is only commit-verified.
    await db.exec("set session_replication_role = replica");
    await db.exec(
      `update public.product_deployment_evidence set verification_state = 'commit_verified'`,
    );
    await db.exec("set session_replication_role = origin");
    await expect(
      issue(db, buildCertificate({ components: components(evidence), issuedAt: new Date() })),
    ).rejects.toThrow(/coverage_certificate_claim_exceeds_evidence/);
    await db.exec("set session_replication_role = replica");
    await db.exec(
      `update public.product_deployment_evidence set verification_state = 'production_verified'`,
    );
    await db.exec("set session_replication_role = origin");

    // Code claimed from another tenant's analysis run.
    const foreignCode: SubjectEvaluation = {
      ...components(evidence)[1]!,
      evidenceRefs: [{ kind: "code_analysis_run", id: OTHER_ANALYSIS, commitSha: COMMIT }],
    };
    await expect(
      issue(
        db,
        buildCertificate({
          components: components(evidence, { code: foreignCode }),
          issuedAt: new Date(),
        }),
      ),
    ).rejects.toThrow(/coverage_certificate_claim_exceeds_evidence/);

    // Runtime evidence cannot be claimed without an adapter.
    const runtime = {
      ...evaluateRuntimeSignals(),
      state: "complete" as const,
      reason: "covered" as const,
    };
    await expect(
      issue(
        db,
        buildCertificate({
          components: [...components(evidence).slice(0, 3), runtime],
          issuedAt: new Date(),
        }),
      ),
    ).rejects.toThrow(/coverage_certificate_claim_exceeds_evidence/);

    // An internal-test source does not count as provider coverage.
    await db.exec("set session_replication_role = replica");
    await db.exec(
      `update public.source_catalog set source_mode = 'internal_test', processing_mode = 'evidence_only',
        workspace_id = '${WORKSPACE}', scope_product_id = '${PRODUCT}', internal_acceptance_key = 'coverage-test-internal'
       where id = '${SOURCES[2][0]}'`,
    );
    await db.exec("set session_replication_role = origin");
    await expect(
      issue(db, buildCertificate({ components: components(evidence), issuedAt: new Date() })),
    ).rejects.toThrow(/coverage_certificate_claim_exceeds_evidence/);
    expect(
      (
        await db.query<{ n: number }>(
          "select count(*)::int as n from public.product_coverage_certificates",
        )
      ).rows[0]!.n,
    ).toBe(0);
  });

  it("requires every current subject and rejects foreign or tampered input", async () => {
    const { db, evidence } = await fresh();
    const all = components(evidence);
    await expect(
      issue(
        db,
        buildCertificate({
          components: all.filter((c) => c.dimension !== "dependency_sources"),
          issuedAt: new Date(),
        }),
      ),
    ).rejects.toThrow(/coverage_certificate_subjects_incomplete/);

    const foreignSubject = {
      ...all[0]!,
      subjectId: OTHER_DEPENDENCY,
      state: "unknown" as const,
      reason: "no_successful_scan" as const,
      evidenceRefs: [],
    };
    await expect(
      issue(
        db,
        buildCertificate({ components: [foreignSubject, ...all.slice(1)], issuedAt: new Date() }),
      ),
    ).rejects.toThrow(/coverage_certificate_subject_invalid/);

    const certificate = buildCertificate({ components: all, issuedAt: new Date() });
    const tampered = certificate.components.map((c) =>
      c.dimension === "repository_code" ? { ...c, state: "complete" as const } : c,
    );
    const weakened = buildCertificate({
      components: all.map((c) =>
        c.dimension === "repository_code" ? { ...c, state: "unknown" as const } : c,
      ),
      issuedAt: new Date(),
    });
    await expect(issue(db, weakened, { p_components: tampered })).rejects.toThrow(
      /coverage_certificate_fingerprint_mismatch/,
    );
    await expect(
      issue(db, certificate, { p_components_fingerprint: "0".repeat(64) }),
    ).rejects.toThrow(/coverage_certificate_fingerprint_mismatch/);
    await expect(issue(db, certificate, { p_product_id: OTHER_PRODUCT })).rejects.toThrow(
      /coverage_certificate_product_invalid/,
    );
  });

  it("allows only the service role to issue, and never updates or deletes", async () => {
    const { db, evidence } = await fresh();
    const certificate = buildCertificate({
      components: components(evidence),
      issuedAt: new Date(),
    });
    await db.query("select set_config('request.jwt.claim.role', 'authenticated', false)");
    await expect(issue(db, certificate)).rejects.toThrow(/service_role_required/);
    await asServiceRole(db);
    await issue(db, certificate);
    await expect(
      db.exec("update public.product_coverage_certificates set claim_level = 'unverified'"),
    ).rejects.toThrow(/coverage_certificate_immutable/);
    await expect(
      db.exec("delete from public.product_coverage_certificate_components"),
    ).rejects.toThrow(/coverage_certificate_immutable/);

    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER]);
    await db.exec("set role authenticated");
    await expect(
      db.exec(
        `insert into public.product_coverage_certificates(workspace_id, product_id, contract_version, sequence,
          dependency_sources_state, repository_code_state, deployment_exposure_state, runtime_signals_state,
          overall_state, claim_level, components_fingerprint, component_count)
         values ('${WORKSPACE}', '${PRODUCT}', 'coverage-cert-v1', 9, 'complete', 'complete', 'complete',
          'unknown', 'complete', 'deployment_verified_protection', '${"a".repeat(64)}', 0)`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.query(
        `select public.issue_product_coverage_certificate('${WORKSPACE}', '${PRODUCT}', 'coverage-cert-v1', '[]'::jsonb, '{}', '${"a".repeat(64)}')`,
      ),
    ).rejects.toThrow(/permission denied/);
    await db.exec("reset role");
  });

  it("isolates tenants through RLS", async () => {
    const { db, evidence } = await fresh();
    await issue(db, buildCertificate({ components: components(evidence), issuedAt: new Date() }));
    const visible = async (user: string) => {
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user]);
      await db.exec("set role authenticated");
      const certificates = await db.query<{ n: number }>(
        "select count(*)::int as n from public.product_coverage_certificates",
      );
      const parts = await db.query<{ n: number }>(
        "select count(*)::int as n from public.product_coverage_certificate_components",
      );
      await db.exec("reset role");
      return [certificates.rows[0]!.n, parts.rows[0]!.n];
    };
    expect(await visible(OWNER)).toEqual([1, 4]);
    expect(await visible(OUTSIDER)).toEqual([0, 0]);
    await db.exec("set role anon");
    await expect(db.query("select * from public.product_coverage_certificates")).rejects.toThrow(
      /permission denied/,
    );
    await db.exec("reset role");
  });

  it("derives the same weakest state and claim level as the TypeScript contract", async () => {
    const db = await migrated.clone();
    for (const sources of COVERAGE_STATES)
      for (const code of COVERAGE_STATES)
        for (const deployment of COVERAGE_STATES) {
          const sql = await db.query<{ claim: string; weakest: string }>(
            "select private.coverage_claim_level($1, $2, $3) as claim, private.coverage_weakest_state(array[$1, $2, $3]) as weakest",
            [sources, code, deployment],
          );
          expect(sql.rows[0]).toEqual({
            claim: claimLevelFor({
              dependency_sources: sources,
              repository_code: code,
              deployment_exposure: deployment,
              runtime_signals: "unknown",
            }),
            weakest: weakestState([sources, code, deployment]),
          });
        }
    expect(
      (await db.query<{ w: string }>("select private.coverage_weakest_state('{}') as w")).rows[0]!
        .w,
    ).toBe("unknown");
  });
});
