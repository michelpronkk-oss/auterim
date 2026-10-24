import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CANDIDATE, loadPlan } from "../../scripts/supabase-bounded-migration.mjs";

const source = new URL("../../supabase/migrations/", import.meta.url);
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
