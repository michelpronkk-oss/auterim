import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkDryRun,
  checkHistory,
  parseDryRun,
  parseMigrationList,
  repositoryMigrationVersions,
} from "../scripts/supabase-migration-gate.mjs";

const migrationsDirectory = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
const workflow = readFileSync(
  new URL("../.github/workflows/supabase-production-migrations.yml", import.meta.url),
  "utf8",
);
const RECOVERY = "20261226000000";
const executableLines = workflow.split("\n").filter((line) => !/^\s*#/.test(line));

function table(rows: Array<[string, string]>) {
  return [
    "Connecting to remote database...",
    "",
    "   Local          | Remote         | Time (UTC)          ",
    "  ----------------|----------------|---------------------",
    ...rows.map(
      ([local, remote]) => `   ${local.padEnd(14)} | ${remote.padEnd(14)} | 2026-12-26 00:00:00 `,
    ),
    "",
  ].join("\n");
}

describe("supabase migration gate", () => {
  const repository = new Set(["20261224000000", "20261225000000", RECOVERY]);

  it("accepts exactly the approved pending migration after all applied history", () => {
    const parsed = parseMigrationList(
      table([
        ["20261224000000", "20261224000000"],
        ["20261225000000", "20261225000000"],
        [RECOVERY, ""],
      ]),
    );
    expect(checkHistory({ ...parsed, repository, expected: new Set([RECOVERY]) })).toEqual({
      pending: [RECOVERY],
      appliedCount: 2,
      latestApplied: "20261225000000",
    });
  });

  it("rejects remote-only history, extra pending work and out-of-order pending versions", () => {
    const remoteOnly = parseMigrationList(
      table([
        ["20261224000000", "20261224000000"],
        ["", "20261224500000"],
        ["20261225000000", "20261225000000"],
        [RECOVERY, ""],
      ]),
    );
    expect(() =>
      checkHistory({ ...remoteOnly, repository, expected: new Set([RECOVERY]) }),
    ).toThrow(/remote_only_migrations:20261224500000|migration_list_local_mismatch/);

    const extraPending = parseMigrationList(
      table([
        ["20261224000000", "20261224000000"],
        ["20261225000000", ""],
        [RECOVERY, ""],
      ]),
    );
    expect(() =>
      checkHistory({ ...extraPending, repository, expected: new Set([RECOVERY]) }),
    ).toThrow(/pending_mismatch/);

    const outOfOrder = parseMigrationList(
      table([
        ["20261224000000", ""],
        ["20261225000000", "20261225000000"],
        [RECOVERY, "20261226000000"],
      ]),
    );
    expect(() =>
      checkHistory({ ...outOfOrder, repository, expected: new Set(["20261224000000"]) }),
    ).toThrow(/pending_migration_out_of_order/);
  });

  it("fails closed on unparseable CLI output", () => {
    expect(() => parseMigrationList("error: password authentication failed")).toThrow(
      /migration_list_unparsed/,
    );
    expect(() => parseDryRun("failed to connect to postgres")).toThrow(/dry_run_unparsed/);
  });

  it("requires the dry run to list exactly the approved files", () => {
    const name = `${RECOVERY}_m1578r_fresh_v4_verification_recovery.sql`;
    const names = parseDryRun(
      `DRY RUN: migrations will *not* be pushed to the database.\nWould push these migrations:\n • ${name}\n`,
    );
    expect(names).toEqual([name]);
    expect(() => checkDryRun(names, [name])).not.toThrow();
    expect(() => checkDryRun([...names, "20261227000000_other.sql"], [name])).toThrow(
      /dry_run_mismatch/,
    );
    expect(parseDryRun("Remote database is up to date.")).toEqual([]);
    expect(() => checkDryRun([], [name])).toThrow(/dry_run_mismatch/);
  });

  it("reads unique, well-formed repository migration versions", () => {
    const versions = repositoryMigrationVersions(migrationsDirectory);
    expect(versions.size).toBeGreaterThan(80);
    expect([...versions].every((version) => /^\d{14}$/.test(version))).toBe(true);
  });
});

describe("supabase production migration workflow", () => {
  it("is manual, plan-first and approval-gated", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s+push:/m);
    expect(workflow).toContain("environment: supabase-production\n");
    expect(workflow).toContain("required_reviewers");
    expect(workflow).toContain("if: github.event_name == 'workflow_dispatch' && inputs.apply");
    expect(workflow).toContain("SUPABASE_PROJECT_REF: lnljaacbptrubppoypaz");
    expect(workflow).toContain("SUPABASE_CLI_VERSION: 2.122.0");
    expect(workflow).toContain("git merge-base --is-ancestor");
  });

  it("never pushes seeds, roles, vault or unlisted history", () => {
    for (const line of executableLines.filter((value) => value.includes("db push"))) {
      expect(line).not.toMatch(/--include-(all|seed|roles)|--db-url/);
      expect(line).toContain("--skip-vault");
      expect(line).toContain("--linked");
    }
    expect(workflow).not.toMatch(/supabase@\$\{SUPABASE_CLI_VERSION\}" (?:db reset|projects)/);
  });

  it("keeps secrets in environment variables, never in command arguments", () => {
    expect(workflow).not.toMatch(/--password/);
    expect(workflow).not.toMatch(/\$\{\{\s*secrets\.[A-Z_]+\s*\}\}[^\n]*\brun:/);
    for (const line of executableLines.filter((value) => value.includes("secrets."))) {
      expect(line).toMatch(/^\s+[A-Z_]+: \$\{\{ secrets\.[A-Z_]+ \}\}$/);
    }
  });
});
