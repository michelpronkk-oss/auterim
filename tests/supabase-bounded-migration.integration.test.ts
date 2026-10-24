import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CANDIDATE, runMigration } from "../scripts/supabase-bounded-migration.mjs";
import { disposableDatabaseUrl, fixturePlan } from "./helpers/bounded-migration-fixture";

const exec = promisify(execFile);
async function officialCli(args: string[]) {
  if (process.env.AUTERIM_SUPABASE_CLI_ENTRY)
    return exec(process.execPath, [process.env.AUTERIM_SUPABASE_CLI_ENTRY, ...args], {
      timeout: 60000,
    });
  return exec("npx", ["--yes", "supabase@2.122.0", ...args], { timeout: 60000 });
}
function cliFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "auterim-official-cli-"));
  mkdirSync(path.join(root, "supabase/migrations"), { recursive: true });
  writeFileSync(
    path.join(root, "supabase/config.toml"),
    'project_id = "auterim-local-lock-fixture"\n[db]\nport = 55579\nmajor_version = 17\n',
  );
  return root;
}
// This suite intentionally destroys fixture schemas. It can never target a hosted project.
const url = disposableDatabaseUrl(process.env.AUTERIM_MIGRATION_TEST_URL);
const { plan } = fixturePlan();
let clients: pg.Client[] = [];
async function connect(options?: string) {
  const c = new pg.Client({ connectionString: url.toString(), options });
  c.on("error", () => {});
  await c.connect();
  clients.push(c);
  return c;
}
const fixture = `
  DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;
  DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA auth;
  DROP SCHEMA IF EXISTS private CASCADE; CREATE SCHEMA private;
  DROP SCHEMA IF EXISTS supabase_migrations CASCADE; CREATE SCHEMA supabase_migrations;
  CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'select null::uuid';
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS 'select null::text';
  CREATE TABLE public.workspaces(id uuid PRIMARY KEY);
  CREATE TABLE public.workspace_members(workspace_id uuid,user_id uuid);
  CREATE TABLE public.workspace_products(id uuid PRIMARY KEY,workspace_id uuid,UNIQUE(id,workspace_id));
  CREATE TABLE public.impact_graph_builds(id uuid PRIMARY KEY,workspace_id uuid,source_change_id uuid,
    product_id uuid,repository_id uuid,commit_sha text,status text,assessment_state text,analysis_profile text,
    coverage_state text,UNIQUE(id,workspace_id),UNIQUE(id,source_change_id,product_id,repository_id,commit_sha));
  CREATE TABLE public.deployment_surfaces(id uuid PRIMARY KEY,workspace_id uuid,current_production_deployment_id text,UNIQUE(id,workspace_id));
  CREATE TABLE public.deployment_sync_attempts(id uuid PRIMARY KEY,workspace_id uuid,deployment_surface_id uuid,status text,completed_at timestamptz);
  CREATE TABLE public.product_deployment_evidence(id uuid PRIMARY KEY,workspace_id uuid,protected_product_id uuid,
    deployment_surface_id uuid,repository_id uuid,deployment_observation_id uuid,verification_state text,verified_commit_sha text);
  CREATE TABLE public.deployment_observations(id uuid PRIMARY KEY,workspace_id uuid,deployment_surface_id uuid,external_deployment_id text);
  CREATE TABLE public.workspace_product_deployment_surfaces(workspace_id uuid,protected_product_id uuid,deployment_surface_id uuid,repository_id uuid);
`;
async function state() {
  const c = await connect();
  return (
    await c.query(`SELECT
 (SELECT count(*)::int FROM supabase_migrations.schema_migrations) AS history,
 to_regclass('public.impact_exposure_assessments') IS NOT NULL AS applied`)
  ).rows[0];
}

describe("bounded migration on disposable PostgreSQL 17", () => {
  beforeAll(async () => {
    const c = await connect();
    for (const role of ["anon", "authenticated", "service_role"])
      await c.query(
        `DO $$ BEGIN CREATE ROLE ${role}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
      );
  });
  beforeEach(async () => {
    const c = await connect();
    await c.query(fixture);
    for (const version of plan.repository)
      if (version !== CANDIDATE.version)
        await c.query("INSERT INTO supabase_migrations.schema_migrations(version) VALUES($1)", [
          version,
        ]);
  });
  afterEach(async () => {
    await Promise.all(clients.map((c) => c.end().catch(() => {})));
    clients = [];
  });
  it("plans read-only and applies exact bytes, schema and Supabase ledger atomically", async () => {
    const c = await connect();
    expect(await runMigration(c, plan, "plan")).toMatchObject({
      outcome: "planned",
      lock_ms: 5000,
      statement_ms: 30000,
      transaction_ms: 60000,
    });
    expect(await state()).toEqual({ history: 87, applied: false });
    expect(await runMigration(c, plan, "apply")).toMatchObject({ outcome: "applied" });
    expect(await state()).toEqual({ history: 88, applied: true });
    const row = (
      await c.query(
        "SELECT name,statements FROM supabase_migrations.schema_migrations WHERE version=$1",
        [CANDIDATE.version],
      )
    ).rows[0];
    expect(row).toEqual({ name: CANDIDATE.name, statements: [plan.sql] });
    const root = cliFixtureRoot();
    const { dir } = fixturePlan();
    for (const name of readdirSync(dir))
      copyFileSync(path.join(dir, name), path.join(root, "supabase/migrations", name));
    const listed = await officialCli([
      "migration",
      "list",
      "--db-url",
      url.toString(),
      "--workdir",
      root,
    ]);
    expect(listed.stdout).toContain(CANDIDATE.version);
    const dry = await officialCli([
      "db",
      "push",
      "--db-url",
      url.toString(),
      "--workdir",
      root,
      "--dry-run",
      "--skip-vault",
    ]);
    expect(dry.stdout + dry.stderr).toMatch(/up to date/i);
    await expect(runMigration(c, plan, "apply")).rejects.toThrow(/rolled_back/);
  });
  it("aborts lock contention at five seconds without advancing history", async () => {
    const blocker = await connect();
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE public.deployment_sync_attempts IN ACCESS SHARE MODE");
    const start = Date.now();
    try {
      await expect(runMigration(await connect(), plan, "apply")).rejects.toMatchObject({
        outcome: "rolled_back",
        code: "55P03",
      });
    } finally {
      await blocker.query("ROLLBACK");
    }
    expect(Date.now() - start).toBeGreaterThanOrEqual(4500);
    expect(Date.now() - start).toBeLessThan(12000);
    expect(await state()).toEqual({ history: 87, applied: false });
  });
  it("aborts a statement after thirty seconds", async () => {
    const c = await connect(),
      query = c.query.bind(c);
    const wrapped = {
      query: async (sql: string, params?: unknown[]) =>
        query(sql === plan.sql ? "SELECT pg_sleep(31)" : sql, params),
    };
    await expect(runMigration(wrapped, plan, "apply")).rejects.toMatchObject({
      outcome: "rolled_back",
      code: "57014",
    });
    expect(await state()).toEqual({ history: 87, applied: false });
  });
  it("caps the whole transaction at sixty seconds", async () => {
    const c = await connect(),
      query = c.query.bind(c);
    const wrapped = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql === plan.sql) for (let i = 0; i < 3; i++) await query("SELECT pg_sleep(21)");
        return query(sql, params);
      },
    };
    await expect(runMigration(wrapped, plan, "apply")).rejects.toMatchObject({
      outcome: "ambiguous",
    });
    expect(await state()).toEqual({ history: 87, applied: false });
  });
  it("rolls back completed DDL when the history write fails", async () => {
    const c = await connect(),
      query = c.query.bind(c);
    const wrapped = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith("INSERT INTO supabase_migrations"))
          throw Object.assign(Error("redacted"), { code: "23514" });
        return query(sql, params);
      },
    };
    await expect(runMigration(wrapped, plan, "apply")).rejects.toMatchObject({
      outcome: "rolled_back",
      code: "23514",
    });
    expect(await state()).toEqual({ history: 87, applied: false });
  });
  it("reports a lost commit acknowledgement as ambiguous and never retries", async () => {
    const c = await connect(),
      query = c.query.bind(c);
    let commits = 0;
    const wrapped = {
      query: async (sql: string, params?: unknown[]) => {
        const result = await query(sql, params);
        if (sql === "COMMIT") {
          commits++;
          throw Error("connection lost with secret that must not be printed");
        }
        return result;
      },
    };
    await expect(runMigration(wrapped, plan, "apply")).rejects.toMatchObject({
      outcome: "ambiguous",
      message: expect.not.stringContaining("secret"),
    });
    expect(commits).toBe(1);
    expect(await state()).toEqual({ history: 88, applied: true });
  });
  it("refuses mismatched history and partially applied schema before DDL", async () => {
    const c = await connect();
    await c.query(
      "DELETE FROM supabase_migrations.schema_migrations WHERE version=(SELECT min(version) FROM supabase_migrations.schema_migrations)",
    );
    // A missing historical version becomes an extra pending migration and must fail closed.
    await expect(runMigration(c, plan, "apply")).rejects.toMatchObject({ outcome: "rolled_back" });
    expect((await state()).applied).toBe(false);
    await c.query(fixture);
    for (const version of plan.repository)
      if (version !== CANDIDATE.version)
        await c.query("INSERT INTO supabase_migrations.schema_migrations(version) VALUES($1)", [
          version,
        ]);
    await c.query(
      "ALTER TABLE public.deployment_sync_attempts ADD CONSTRAINT deployment_sync_attempts_id_surface_key UNIQUE(id,workspace_id,deployment_surface_id)",
    );
    await expect(runMigration(c, plan, "plan")).rejects.toMatchObject({ outcome: "rolled_back" });
    expect((await state()).applied).toBe(false);
  });
  it("rejects an unexpected connection identity", async () => {
    const c = await connect(),
      query = c.query.bind(c);
    const wrapped = {
      query: async (sql: string, params?: unknown[]) => {
        const result = await query(sql, params);
        if (sql.includes("AS database")) result.rows[0].database = "unexpected";
        return result;
      },
    };
    await expect(runMigration(wrapped, plan, "apply")).rejects.toMatchObject({
      outcome: "not_started",
    });
    expect(await state()).toEqual({ history: 87, applied: false });
  });
  it("refuses DDL if effective transaction-local settings differ", async () => {
    const c = await connect(),
      query = c.query.bind(c);
    const wrapped = {
      query: async (sql: string, params?: unknown[]) => {
        const result = await query(sql, params);
        if (sql.includes("AS lock_ms")) result.rows[0].lock_ms = 0;
        return result;
      },
    };
    await expect(runMigration(wrapped, plan, "apply")).rejects.toMatchObject({
      outcome: "rolled_back",
    });
    expect(await state()).toEqual({ history: 87, applied: false });
  });
  it("verifies actual official CLI RESET ALL behavior on a separate local fixture", async () => {
    const c = await connect();
    await c.query("DROP SCHEMA supabase_migrations CASCADE");
    const root = cliFixtureRoot();
    writeFileSync(
      path.join(root, "supabase/migrations/20260930000000_session_settings.sql"),
      "SET lock_timeout='1s'; SET statement_timeout='2s';",
    );
    writeFileSync(
      path.join(root, "supabase/migrations/20261001000000_probe.sql"),
      `CREATE TABLE public.cli_probe AS SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout;`,
    );
    const target = new URL(url);
    target.searchParams.set("lock_timeout", "5s");
    target.searchParams.set("statement_timeout", "30s");
    const args = [
      "db",
      "push",
      "--db-url",
      target.toString(),
      "--skip-vault",
      "--yes",
      "--workdir",
      root,
    ];
    await officialCli(args);
    expect((await c.query("SELECT * FROM public.cli_probe")).rows).toEqual([
      { lock_timeout: "5s", statement_timeout: "30s" },
    ]);
    expect(
      (
        await c.query(
          "SELECT version,name FROM supabase_migrations.schema_migrations ORDER BY version",
        )
      ).rows,
    ).toEqual([
      { version: "20260930000000", name: "session_settings" },
      { version: "20261001000000", name: "probe" },
    ]);
  });
});
