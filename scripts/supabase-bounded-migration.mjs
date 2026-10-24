#!/usr/bin/env node
// Deliberately supports only the reviewed, transaction-safe Step 4a migration.
// No SQL rewriting, general migration parser, automatic retry, or ledger repair.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  CA_SHA256,
  connectionFailure,
  migrationTls,
  verifiedTlsProtocol,
} from "./supabase-migration-tls.mjs";
import {
  checkHistory,
  EXPECTED_PROJECT_REF,
  repositoryMigrationVersions,
} from "./supabase-migration-gate.mjs";

export const CANDIDATE = Object.freeze({
  file: "20261228000000_m1579_impact_exposure_assessments.sql",
  version: "20261228000000",
  name: "m1579_impact_exposure_assessments",
  sha256: "e761b0d8e22acffd92bb1a5dcb44cb050679791a4cd392e7381b1d2799d55cef",
});

export function loadPlan(directory, approved) {
  if (approved !== CANDIDATE.file) throw new Error("approved_migration_not_supported");
  const bytes = readFileSync(path.join(directory, CANDIDATE.file));
  if (createHash("sha256").update(bytes).digest("hex") !== CANDIDATE.sha256)
    throw new Error("approved_migration_checksum_mismatch");
  const repository = repositoryMigrationVersions(directory);
  if (!repository.has(CANDIDATE.version)) throw new Error("repository_migration_missing");
  return { sql: bytes.toString("utf8"), repository };
}

export function connectionConfig(poolerUrl, password, projectRef) {
  if (projectRef !== EXPECTED_PROJECT_REF || !password)
    throw new Error("database_identity_or_password_invalid");
  let url;
  try {
    url = new URL(poolerUrl.trim());
  } catch {
    throw new Error("database_url_invalid");
  }
  if (
    url.protocol !== "postgresql:" ||
    url.username !== `postgres.${EXPECTED_PROJECT_REF}` ||
    !/^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname) ||
    url.port !== "5432" ||
    url.pathname !== "/postgres" ||
    url.search ||
    url.hash
  )
    throw new Error("database_target_mismatch");
  // Ignore the saved URL's password placeholder. Never put credentials in argv/logs.
  return {
    host: url.hostname,
    port: 5432,
    database: "postgres",
    user: url.username,
    password,
    ssl: migrationTls(url.hostname),
    connectionTimeoutMillis: 10_000,
    query_timeout: 35_000,
    application_name: "auterim-bounded-migration",
  };
}

async function history(client, plan, expected) {
  const rows = (
    await client.query("SELECT version FROM supabase_migrations.schema_migrations ORDER BY version")
  ).rows;
  if (rows.length !== new Set(rows.map((r) => r.version)).size)
    throw new Error("duplicate_migration_history");
  checkHistory({
    local: plan.repository,
    remote: new Set(rows.map((r) => r.version)),
    repository: plan.repository,
    expected: new Set(expected),
  });
}

const markerSql = `SELECT
  to_regclass('public.impact_exposure_assessments') IS NOT NULL AS table_present,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deployment_sync_attempts_id_surface_key'
    AND conrelid = 'public.deployment_sync_attempts'::regclass) AS sync_key_present,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_deployment_evidence_id_scope_key'
    AND conrelid = 'public.product_deployment_evidence'::regclass) AS evidence_key_present,
  to_regprocedure('public.issue_impact_exposure_assessment(uuid,uuid,uuid,uuid,uuid,text,text)') IS NOT NULL AS issuer_present,
  to_regprocedure('private.impact_exposure_outcome(text,text,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone)') IS NOT NULL AS outcome_present,
  to_regprocedure('private.reject_impact_exposure_mutation()') IS NOT NULL AS trigger_present`;

export class BoundedMigrationError extends Error {
  constructor(outcome, code) {
    super(`bounded_migration_failed:outcome=${outcome};code=${code}`);
    this.outcome = outcome;
    this.code = code;
  }
}

/** Client must be a fresh, dedicated connection. A single attempt; caller always closes it. */
export async function runMigration(client, plan, mode) {
  // Recheck immutable payload even when called without the CLI loader.
  if (
    !["plan", "apply"].includes(mode) ||
    createHash("sha256").update(plan.sql).digest("hex") !== CANDIDATE.sha256
  )
    throw new BoundedMigrationError("not_started", "invalid_plan");
  let transaction = false;
  let committing = false;
  let committed = false;
  try {
    const identity = (
      await client.query(`SELECT current_database() AS database,
      current_user AS role, session_user AS login, current_setting('server_version_num')::int AS version,
      pg_is_in_recovery() AS recovery`)
    ).rows[0];
    if (
      identity.database !== "postgres" ||
      identity.role !== "postgres" ||
      identity.login !== "postgres" ||
      !Number.isInteger(identity.version) ||
      identity.version < 170000 ||
      identity.recovery !== false
    )
      throw new Error("connection_state_invalid");
    await client.query(mode === "plan" ? "BEGIN READ ONLY" : "BEGIN");
    transaction = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL transaction_timeout = '60s'");
    const settings = (
      await client.query(`SELECT
      (SELECT setting::int FROM pg_settings WHERE name='lock_timeout') AS lock_ms,
      (SELECT setting::int FROM pg_settings WHERE name='statement_timeout') AS statement_ms,
      (SELECT setting::int FROM pg_settings WHERE name='transaction_timeout') AS transaction_ms,
      current_setting('transaction_read_only') AS read_only`)
    ).rows[0];
    if (
      settings.lock_ms !== 5000 ||
      settings.statement_ms !== 30000 ||
      settings.transaction_ms !== 60000 ||
      settings.read_only !== (mode === "plan" ? "on" : "off")
    )
      throw new Error("transaction_settings_mismatch");
    // No waiting behind another instance of this helper. Workflow concurrency is also retained.
    if (
      mode === "apply" &&
      !(await client.query("SELECT pg_try_advisory_xact_lock(1579, 4) AS acquired")).rows[0]
        .acquired
    )
      throw new Error("migration_runner_busy");
    await history(client, plan, [CANDIDATE.version]);
    const before = (await client.query(markerSql)).rows[0];
    if (Object.keys(before).length !== 6 || Object.values(before).some((value) => value !== false))
      throw new Error("partial_schema_state");
    if (mode === "plan") {
      await client.query("ROLLBACK");
      transaction = false;
      return { outcome: "planned", ...settings };
    }
    // The hash allowlist excludes transaction control and nontransactional DDL. Execute the
    // exact reviewed bytes inside our transaction; the migration itself is never edited.
    await client.query(plan.sql);
    await history(client, plan, [CANDIDATE.version]);
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements)
      VALUES ($1,$2,$3)`,
      [CANDIDATE.version, CANDIDATE.name, [plan.sql]],
    );
    await history(client, plan, []);
    const after = (await client.query(markerSql)).rows[0];
    if (Object.keys(after).length !== 6 || Object.values(after).some((value) => value !== true))
      throw new Error("schema_postflight_mismatch");
    committing = true;
    await client.query("COMMIT");
    committed = true;
    transaction = false;
    // A failed acknowledgement or readback is never treated as permission to retry.
    const recorded = (
      await client.query(
        `SELECT name,statements FROM supabase_migrations.schema_migrations
      WHERE version=$1`,
        [CANDIDATE.version],
      )
    ).rows[0];
    if (
      recorded?.name !== CANDIDATE.name ||
      recorded.statements?.length !== 1 ||
      recorded.statements[0] !== plan.sql
    )
      throw new Error("history_postflight_mismatch");
    return { outcome: "applied", ...settings };
  } catch (error) {
    let outcome = committing || committed ? "ambiguous" : "not_started";
    if (transaction && !committing) {
      try {
        await client.query("ROLLBACK");
        outcome = "rolled_back";
      } catch {
        outcome = "ambiguous";
      }
    }
    // Do not include driver messages/details: they can contain SQL or connection credentials.
    const code = /^[A-Z0-9]{5}$/.test(error?.code ?? "")
      ? error.code
      : "safety_or_connection_failure";
    throw new BoundedMigrationError(outcome, code);
  }
}

async function main() {
  const mode = process.argv[2];
  if (
    process.argv.length !== 3 ||
    !["plan", "apply"].includes(mode) ||
    (mode === "apply" && process.env.SUPABASE_MIGRATION_APPLY !== "true")
  )
    throw new Error("bounded_migration_mode_invalid");
  const sha = process.env.MERGE_SHA ?? "";
  if (
    !/^[a-f0-9]{40}$/.test(sha) ||
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== sha
  )
    throw new Error("checked_out_sha_mismatch");
  const ref = readFileSync("supabase/.temp/project-ref", "utf8").trim();
  if (process.env.SUPABASE_PROJECT_REF !== EXPECTED_PROJECT_REF || ref !== EXPECTED_PROJECT_REF)
    throw new Error("linked_project_ref_mismatch");
  const plan = loadPlan("supabase/migrations", process.env.APPROVED);
  const config = connectionConfig(
    readFileSync("supabase/.temp/pooler-url", "utf8"),
    process.env.SUPABASE_DB_PASSWORD,
    ref,
  );
  const client = new pg.Client(config);
  // Pool errors must not crash the process or leak their raw messages.
  client.on("error", () => {});
  try {
    await client.connect();
    const protocol = verifiedTlsProtocol(client.connection.stream);
    console.log(
      `bounded migration TLS verified: ca_sha256=${CA_SHA256} protocol=${protocol} hostname_verified=true`,
    );
    const result = await runMigration(client, plan, mode);
    console.log(
      `bounded migration ${result.outcome}: ${CANDIDATE.file} sha256=${CANDIDATE.sha256} lock=5s statement=30s transaction=60s`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      error instanceof BoundedMigrationError ? error.message : connectionFailure(error),
    );
    process.exitCode = 1;
  });
}
