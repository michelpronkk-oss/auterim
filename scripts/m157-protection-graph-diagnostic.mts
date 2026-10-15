import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { loadEnvConfig } = createRequire(import.meta.url)("@next/env") as typeof import("@next/env");

const PROJECT_REF = "lnljaacbptrubppoypaz";
const CHILD_ENVIRONMENT_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

function fail(stage: string): never {
  throw new Error(`m157_graph_diagnostic_${stage}`);
}

function run() {
  const root = process.cwd();
  loadEnvConfig(root);

  let projectRef: string;
  try {
    projectRef = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname.split(".")[0] ?? "";
  } catch {
    fail("supabase_url_unavailable");
  }
  if (projectRef !== PROJECT_REF) fail("supabase_project_mismatch");
  if (!process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) fail("supabase_public_key_unavailable");
  if (!(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY))
    fail("supabase_server_credential_unavailable");

  const childEnvironment: Record<string, string | undefined> = {
    NODE_ENV: "test",
    AUTERIM_M157_GRAPH_DIAGNOSTIC: "1",
  };
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) childEnvironment[key] = value;
  }
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"] as const) {
    const value = process.env[key];
    if (value !== undefined) childEnvironment[key] = value;
  }

  const vitestEntry = path.join(root, "node_modules", "vitest", "vitest.mjs");
  const child = spawnSync(
    process.execPath,
    [vitestEntry, "run", "tests/m157-protection-graph-live-diagnostic.test.ts", "--reporter=dot"],
    { cwd: root, env: childEnvironment as NodeJS.ProcessEnv, stdio: "inherit" },
  );
  if (child.error) fail("vitest_start_failed");
  if (child.status !== 0) process.exitCode = child.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) run();
