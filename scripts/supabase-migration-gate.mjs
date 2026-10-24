#!/usr/bin/env node
// Fail-closed gate for Production Supabase migrations in CI.
// Parses Supabase CLI output and refuses anything other than the exact
// migrations an operator approved. Prints filenames and digests only.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_PROJECT_REF = "lnljaacbptrubppoypaz";
const VERSION = /^\d{14}$/;
const MIGRATION_FILE = /^(\d{14})_[a-z0-9_]+\.sql$/;

/** Parses `supabase migration list` table output into local and remote version sets. */
export function parseMigrationList(output) {
  const local = new Set();
  const remote = new Set();
  let rows = 0;
  for (const line of output.split(/\r?\n/)) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const [localCell, remoteCell] = cells;
    if (!VERSION.test(localCell) && !VERSION.test(remoteCell)) continue;
    if ((localCell && !VERSION.test(localCell)) || (remoteCell && !VERSION.test(remoteCell)))
      throw new Error("migration_list_row_invalid");
    rows += 1;
    if (localCell) local.add(localCell);
    if (remoteCell) remote.add(remoteCell);
  }
  if (rows === 0) throw new Error("migration_list_unparsed");
  return { local, remote };
}

export function repositoryMigrationVersions(directory) {
  const versions = new Set();
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".sql")) continue;
    const match = MIGRATION_FILE.exec(name);
    if (!match) throw new Error(`migration_filename_invalid:${name}`);
    if (versions.has(match[1])) throw new Error(`migration_version_duplicate:${match[1]}`);
    versions.add(match[1]);
  }
  return versions;
}

/**
 * Remote history must be a prefix-consistent subset of the repository: nothing applied
 * remotely may be missing locally, and the pending set must equal the approved set and
 * sort after every applied version.
 */
export function checkHistory({ local, remote, repository, expected }) {
  const sameLocal =
    local.size === repository.size && [...repository].every((version) => local.has(version));
  if (!sameLocal) throw new Error("migration_list_local_mismatch");
  const remoteOnly = [...remote].filter((version) => !repository.has(version)).sort();
  if (remoteOnly.length) throw new Error(`remote_only_migrations:${remoteOnly.join(",")}`);
  const pending = [...repository].filter((version) => !remote.has(version)).sort();
  const approved = [...expected].sort();
  if (pending.join(",") !== approved.join(","))
    throw new Error(`pending_mismatch:pending=${pending.join(",")};approved=${approved.join(",")}`);
  const latestApplied = [...remote].sort().at(-1) ?? "";
  if (pending.some((version) => version <= latestApplied))
    throw new Error("pending_migration_out_of_order");
  return { pending, appliedCount: remote.size, latestApplied };
}

/** Extracts migration filenames that `db push --dry-run` reports it would apply. */
export function parseDryRun(output) {
  if (/remote database is up to date/i.test(output)) return [];
  const names = [...output.matchAll(/\b(\d{14}_[a-z0-9_]+\.sql)\b/g)].map((match) => match[1]);
  if (!names.length) throw new Error("dry_run_unparsed");
  return [...new Set(names)].sort();
}

export function checkDryRun(names, expectedFiles) {
  const approved = [...expectedFiles].sort();
  if (names.join(",") !== approved.join(","))
    throw new Error(
      `dry_run_mismatch:would_apply=${names.join(",")};approved=${approved.join(",")}`,
    );
}

export function migrationDigests(directory, files) {
  return files.map((name) => ({
    name,
    sha256: createHash("sha256")
      .update(readFileSync(path.join(directory, name)))
      .digest("hex"),
  }));
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    if (!key?.startsWith("--") || rest[index + 1] === undefined)
      throw new Error("arguments_invalid");
    options[key.slice(2)] = rest[index + 1];
  }
  return { command, options };
}

function expectedFiles(directory, list) {
  const files = list
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!files.length) throw new Error("approved_migrations_empty");
  for (const name of files) {
    if (!MIGRATION_FILE.test(name)) throw new Error(`approved_migration_invalid:${name}`);
    readFileSync(path.join(directory, name));
  }
  return files;
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const directory = options["migrations-dir"] ?? "supabase/migrations";
  if (command === "project-ref") {
    const ref = readFileSync(options.file, "utf8").trim();
    if (ref !== EXPECTED_PROJECT_REF) throw new Error("linked_project_ref_mismatch");
    console.log(`linked project ref: ${ref}`);
    return;
  }
  const files = expectedFiles(directory, options.approved ?? "");
  const versions = new Set(files.map((name) => MIGRATION_FILE.exec(name)[1]));
  if (command === "history") {
    const parsed = parseMigrationList(readFileSync(options.output, "utf8"));
    const result = checkHistory({
      ...parsed,
      repository: repositoryMigrationVersions(directory),
      expected: versions,
    });
    console.log(
      `migration history ok: ${result.appliedCount} applied, latest ${result.latestApplied}, pending ${result.pending.join(",")}`,
    );
    return;
  }
  if (command === "history-applied") {
    const parsed = parseMigrationList(readFileSync(options.output, "utf8"));
    checkHistory({
      ...parsed,
      repository: repositoryMigrationVersions(directory),
      expected: new Set(),
    });
    console.log("migration history ok: no pending migrations");
    return;
  }
  if (command === "dry-run") {
    checkDryRun(parseDryRun(readFileSync(options.output, "utf8")), files);
    for (const { name, sha256 } of migrationDigests(directory, files))
      console.log(`would apply ${name} sha256=${sha256}`);
    return;
  }
  throw new Error("command_invalid");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `supabase migration gate failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    process.exit(1);
  }
}
