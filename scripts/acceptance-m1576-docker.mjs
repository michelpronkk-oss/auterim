import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(process.cwd());
const expectedRoot = path.resolve("C:/Users/miche/Desktop/Auterim");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

if (repositoryRoot.toLowerCase() !== expectedRoot.toLowerCase()) {
  throw new Error("m1576_acceptance_repository_guard_failed");
}

const context = run("docker", ["context", "show"]).trim();
if (context !== "desktop-linux") throw new Error("m1576_acceptance_docker_context_guard_failed");
const databaseContainer = "supabase_db_auterim-m1576-local";
const databaseState = run("docker", [
  "inspect",
  "--format",
  "{{.State.Status}}",
  databaseContainer,
]).trim();
if (databaseState !== "running") throw new Error("m1576_acceptance_local_database_unavailable");

let statusOutput;
try {
  statusOutput = run("cmd.exe", [
    "/d",
    "/s",
    "/c",
    "npx supabase status --output env --workdir node_modules/.cache/auterim-m1576-local",
  ]);
} catch {
  throw new Error("m1576_acceptance_local_supabase_status_unavailable");
}
const localConfig = new Map();
for (const line of statusOutput.split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match) localConfig.set(match[1], match[2].replace(/^['"]|['"]$/g, ""));
}
const localUrl = localConfig.get("API_URL");
const localServiceKey = localConfig.get("SERVICE_ROLE_KEY");
const localAnonKey = localConfig.get("ANON_KEY") ?? localConfig.get("PUBLISHABLE_KEY");
if (localUrl !== "http://127.0.0.1:57421" || !localServiceKey || !localAnonKey) {
  throw new Error("m1576_acceptance_local_supabase_binding_guard_failed");
}

const isolatedSupabaseProject = path.join(
  repositoryRoot,
  "node_modules/.cache/auterim-m1576-local",
);
const canonicalMigrationDirectory = path.join(repositoryRoot, "supabase/migrations");
const isolatedMigrationDirectory = path.join(isolatedSupabaseProject, "supabase/migrations");
for (const filename of readdirSync(canonicalMigrationDirectory).filter((name) =>
  name.endsWith(".sql"),
)) {
  const source = path.join(canonicalMigrationDirectory, filename);
  const destination = path.join(isolatedMigrationDirectory, filename);
  if (existsSync(destination)) {
    if (!readFileSync(source).equals(readFileSync(destination))) {
      throw new Error("m1576_acceptance_isolated_migration_drift");
    }
  } else {
    copyFileSync(source, destination);
  }
}
run("cmd.exe", [
  "/d",
  "/s",
  "/c",
  `npx supabase migration up --local --workdir ${path.relative(repositoryRoot, isolatedSupabaseProject)}`,
]);

const exactHead = run("git", ["rev-parse", "HEAD"]).trim();
const priorHead = run("git", ["rev-parse", "HEAD^"]).trim();
for (const sha of [exactHead, priorHead]) {
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error("m1576_acceptance_exact_commit_guard_failed");
}

const env = {
  ...process.env,
  AUTERIM_M1576_DOCKER_ACCEPTANCE: "1",
  AUTERIM_M1576_EXPECTED_URL: localUrl,
  AUTERIM_M1576_SERVICE_KEY: localServiceKey,
  AUTERIM_M1576_ANON_KEY: localAnonKey,
  AUTERIM_M1576_FIXTURE_COMMIT_SHA: exactHead,
  AUTERIM_M1576_PREVIOUS_COMMIT_SHA: priorHead,
};
const result = spawnSync(
  "npm.cmd",
  ["exec", "vitest", "run", "tests/code-intelligence.docker.integration.test.ts"],
  {
    cwd: repositoryRoot,
    env,
    stdio: "inherit",
    shell: true,
  },
);
if (result.error || result.status !== 0) process.exit(result.status ?? 1);
console.log("M15.76 Docker acceptance: PASS (isolated local Supabase only)");
