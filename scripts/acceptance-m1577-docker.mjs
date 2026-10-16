import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const expectedRoot = path.resolve("C:/Users/miche/Desktop/Auterim");
const stackDirectory = path.join(root, "node_modules/.cache/auterim-m1577-local");
const container = "supabase_db_auterim-m1577-local";
const policyOnly = process.argv.includes("--policy-only");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

if (root.toLowerCase() !== expectedRoot.toLowerCase())
  throw new Error("m1577_repository_guard_failed");
if (!existsSync(path.join(stackDirectory, "supabase/config.toml")))
  throw new Error("m1577_isolated_stack_missing");
const config = readFileSync(path.join(stackDirectory, "supabase/config.toml"), "utf8");
if (!/project_id\s*=\s*"auterim-m1577-local"/.test(config))
  throw new Error("m1577_stack_identity_guard_failed");
const context = run("docker", ["context", "show"]).trim();
if (context !== "desktop-linux") throw new Error("m1577_docker_context_guard_failed");
if (run("docker", ["inspect", "--format", "{{.State.Status}}", container]).trim() !== "running")
  throw new Error("m1577_local_database_unavailable");

let status;
try {
  status = run("cmd.exe", [
    "/d",
    "/s",
    "/c",
    "npx supabase status --output env --workdir node_modules/.cache/auterim-m1577-local",
  ]);
} catch {
  throw new Error("m1577_local_supabase_status_unavailable");
}
const values = new Map();
for (const line of status.split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match) values.set(match[1], match[2].replace(/^['"]|['"]$/g, ""));
}
const url = values.get("API_URL");
const serviceKey = values.get("SERVICE_ROLE_KEY");
const anonKey = values.get("ANON_KEY") ?? values.get("PUBLISHABLE_KEY");
if (url !== "http://127.0.0.1:57521" || !serviceKey || !anonKey)
  throw new Error("m1577_local_persistence_guard_failed");

if (policyOnly) {
  const migration = run("docker", [
    "exec",
    container,
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-Atqc",
    "select count(*) from supabase_migrations.schema_migrations where version='20261208000000'",
  ]).trim();
  if (migration !== "1") throw new Error("m1577_policy_migration_not_applied");
} else {
  const isolatedMigrations = path.join(stackDirectory, "supabase/migrations");
  for (const name of readdirSync(path.join(root, "supabase/migrations")).filter((entry) =>
    entry.endsWith(".sql"),
  )) {
    const source = path.join(root, "supabase/migrations", name);
    const destination = path.join(isolatedMigrations, name);
    if (!existsSync(destination) || !readFileSync(source).equals(readFileSync(destination)))
      copyFileSync(source, destination);
  }
  try {
    run("cmd.exe", [
      "/d",
      "/s",
      "/c",
      "npx supabase db reset --local --workdir node_modules/.cache/auterim-m1577-local",
    ]);
  } catch {
    throw new Error("m1577_local_migration_parity_failed");
  }
}

const commitSha = run("git", ["rev-parse", "HEAD"]).trim();
const previousCommitSha = run("git", ["rev-parse", `${commitSha}^`]).trim();
run("git", ["cat-file", "-e", `${commitSha}^{commit}`]);
const safeHostEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !/(SUPABASE|TRIGGER|VERCEL|GITHUB|OPENAI|DODO|RESEND|DATABASE_URL|POSTGRES|PRIVATE_KEY|SECRET|TOKEN|API_KEY|NODE_OPTIONS)/i.test(
        name,
      ),
  ),
);
const env = {
  ...safeHostEnv,
  NODE_ENV: "test",
  AUTERIM_M1576_DOCKER_ACCEPTANCE: "1",
  AUTERIM_M1576_EXPECTED_URL: url,
  AUTERIM_M1576_SERVICE_KEY: serviceKey,
  AUTERIM_M1576_ANON_KEY: anonKey,
  AUTERIM_M1576_FIXTURE_COMMIT_SHA: commitSha,
  AUTERIM_M1576_PREVIOUS_COMMIT_SHA: previousCommitSha,
  AUTERIM_M15_LOCAL_INTEGRATION: "1",
  AUTERIM_M15_LOCAL_SUPABASE_URL: url,
  AUTERIM_M15_LOCAL_SUPABASE_SECRET_KEY: serviceKey,
  AUTERIM_M1577_POLICY_DOCKER_ACCEPTANCE: "1",
  NEXT_PUBLIC_SUPABASE_URL: url,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: anonKey,
};
const codeIntelligenceResult = policyOnly
  ? null
  : spawnSync(
      process.execPath,
      [
        path.join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "tests/code-intelligence.docker.integration.test.ts",
        "--testNamePattern",
        [
          "M15\\.77 builds an exact-commit graph",
          "persists canonical route handoffs and reusable exact-commit structural facts",
          "persists every fact for a synthetic analysis exceeding the PostgREST row cap",
          "fails closed when a selected relation references a missing entity",
          "rejects completion when a v2 relation lacks source provenance",
          "rejects v2 completion when a source reference lacks occurrence columns",
        ].join("|"),
      ],
      { cwd: root, env, stdio: "inherit" },
    );
if (codeIntelligenceResult && (codeIntelligenceResult.error || codeIntelligenceResult.status !== 0))
  process.exit(codeIntelligenceResult.status ?? 1);
const policyResult = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "tests/intelligence-active-policy.docker.integration.test.ts",
  ],
  { cwd: root, env, stdio: "inherit" },
);
if (policyResult.error || policyResult.status !== 0) process.exit(policyResult.status ?? 1);
if (!policyOnly) {
  const evidenceModeResult = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      "vitest.m1577-docker.config.mts",
      "scripts/m1577-evidence-only-source-mode.docker.integration.test.ts",
    ],
    { cwd: root, env, stdio: "inherit" },
  );
  if (evidenceModeResult.error || evidenceModeResult.status !== 0)
    process.exit(evidenceModeResult.status ?? 1);
}
console.log(
  policyOnly
    ? "M15.77 calibrated policy Docker acceptance: PASS"
    : "M15.76 persistence/provenance and M15.77 isolated Docker acceptance: PASS",
);
