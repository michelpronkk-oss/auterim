import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CANDIDATE, loadPlan } from "../../scripts/supabase-bounded-migration.mjs";

const source = new URL("../../supabase/migrations/", import.meta.url);
export function disposableDatabaseUrl(value: string | undefined) {
  const url = new URL(value ?? "http://invalid");
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "55579" ||
    url.username !== "postgres" ||
    url.password !== "local-migration-tests" ||
    url.pathname !== "/postgres" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw Error("disposable_local_migration_database_required");
  return url;
}

export function fixturePlan() {
  const dir = mkdtempSync(path.join(tmpdir(), "auterim-lock-plan-"));
  for (const name of readdirSync(source)) {
    if (name.endsWith(".sql"))
      writeFileSync(
        path.join(dir, name),
        readFileSync(new URL(name, source), "utf8").replace(/\r\n/g, "\n"),
      );
  }
  return { dir, plan: loadPlan(dir, CANDIDATE.file) };
}
