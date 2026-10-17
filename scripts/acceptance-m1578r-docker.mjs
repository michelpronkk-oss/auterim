import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const root = path.resolve(process.cwd());
const stack = path.join(root, "node_modules/.cache/auterim-m1578r-diagnosis-local");
const expectedRemote = "https://github.com/michelpronkk-oss/auterim.git";
const expectedBranch = "codex/m1578r-patch-contract-recovery";
const expectedBaseSha = "34c88a0e742a575e85bcb9bd6429fc79f562e2ce";
const expectedApiUrl = "http://127.0.0.1:62970";
const container = "supabase_db_auterim-m1578r-diagnosis-local";
const verificationImage =
  "node:24.8.0-alpine3.22@sha256:3e843c608bb5232f39ecb2b25e41214b958b0795914707374c8acc28487dea17";
const smokeName = `auterim-m1578r-runner-${randomUUID().slice(0, 8)}`;
const smokeVolume = `auterim-m1578r-data-${randomUUID().slice(0, 8)}`;
const smokeImage = `auterim-m1578r-runner:${randomUUID().slice(0, 8)}`;

function run(command, args, options = {}) {
  const windowsNpm = process.platform === "win32" && command === "npm";
  const executable = windowsNpm ? "cmd.exe" : command;
  const executableArgs = windowsNpm ? ["/d", "/s", "/c", `npm ${args.join(" ")}`] : args;
  return execFileSync(executable, executableArgs, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function runSupabase(args) {
  if (process.platform !== "win32") return run("npx", ["supabase", ...args]);
  assert(
    args.every((value) => /^[A-Za-z0-9_./\\-]+$/.test(String(value))),
    "m1578r_supabase_argument_invalid",
  );
  return run("cmd.exe", ["/d", "/s", "/c", `npx supabase ${args.join(" ")}`]);
}

function waitForVerificationRunnerHealth(containerName) {
  const deadline = Date.now() + 30_000;
  const probe =
    "fetch('http://127.0.0.1:8080/healthz').then(async r => { const b=await r.json(); if(!r.ok || b.protocolVersion!=='m1578-verification-runner-v1') process.exit(1); }).catch(()=>process.exit(1))";
  while (Date.now() < deadline) {
    try {
      run("docker", ["exec", containerName, "node", "-e", probe], {
        timeout: 5_000,
        maxBuffer: 4096,
      });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  throw new Error("m1578r_runner_health_failed");
}

function assert(value, category) {
  if (!value) throw new Error(category);
}

assert(path.basename(root).toLowerCase() === "auterim", "m1578r_repository_identity_failed");
assert(
  run("git", ["remote", "get-url", "origin"]).trim() === expectedRemote,
  "m1578r_remote_identity_failed",
);
assert(
  run("git", ["branch", "--show-current"]).trim() === expectedBranch,
  "m1578r_branch_identity_failed",
);
assert(
  run("git", ["merge-base", "HEAD", "origin/main"]).trim() === expectedBaseSha,
  "m1578r_base_sha_changed",
);
assert(
  run("docker", ["context", "show"]).trim() === "desktop-linux",
  "m1578r_docker_context_failed",
);
assert(
  run("git", ["ls-remote", "origin", "refs/heads/main"]).trim().split(/\s+/)[0] === expectedBaseSha,
  "m1578r_origin_main_changed",
);
const identity = readFileSync(path.join(root, ".project-identity"), "utf8");
assert(
  identity.includes("PROJECT_NAME=Auterim") &&
    identity.includes("EXPECTED_TRIGGER_PROJECT=proj_hwqtxtyrvwykjirkrdoh"),
  "m1578r_project_identity_failed",
);
const triggerConfig = readFileSync(path.join(root, "trigger.config.ts"), "utf8");
assert(
  /project:\s*["']proj_hwqtxtyrvwykjirkrdoh["']/.test(triggerConfig),
  "m1578r_trigger_project_identity_failed",
);
assert(existsSync(path.join(stack, "supabase/config.toml")), "m1578r_isolated_stack_missing");
const stackConfig = readFileSync(path.join(stack, "supabase/config.toml"), "utf8");
assert(
  /project_id\s*=\s*["']auterim-m1578r-diagnosis-local["']/.test(stackConfig),
  "m1578r_stack_identity_failed",
);
assert(
  /port\s*=\s*62970/.test(stackConfig) && /port\s*=\s*62971/.test(stackConfig),
  "m1578r_stack_ports_failed",
);
assert(
  run("docker", ["inspect", "--format", "{{.State.Status}}", container]).trim() === "running",
  "m1578r_local_database_unavailable",
);

mkdirSync(path.join(stack, "supabase/migrations"), { recursive: true });
for (const filename of readdirSync(path.join(root, "supabase/migrations")).filter((name) =>
  name.endsWith(".sql"),
)) {
  const source = path.join(root, "supabase/migrations", filename);
  const destination = path.join(stack, "supabase/migrations", filename);
  if (!existsSync(destination) || !readFileSync(source).equals(readFileSync(destination)))
    copyFileSync(source, destination);
}
runSupabase(["db", "reset", "--local", "--no-seed", "--workdir", path.relative(root, stack)]);

const databaseChecks = `
select
  (select not public from storage.buckets where id='fix-engine-verification-artifacts') as private_bucket,
  not exists (
    select 1 from pg_policies p
    where p.schemaname='storage' and p.tablename='objects'
      and (
        coalesce(p.qual,'') ilike '%fix-engine-verification-artifacts%'
        or coalesce(p.with_check,'') ilike '%fix-engine-verification-artifacts%'
        or (coalesce(p.qual,'') !~* 'bucket_id' and coalesce(p.with_check,'') !~* 'bucket_id')
      )
  ) as no_authenticated_storage_policy,
  has_table_privilege('service_role','storage.objects','SELECT') as service_role_storage_read,
  has_table_privilege('service_role','storage.objects','INSERT') as service_role_storage_write,
  (select relrowsecurity from pg_class where oid='public.fix_verification_snapshots'::regclass) as snapshot_rls,
  not exists (select 1 from pg_policies where schemaname='public' and tablename='fix_verification_snapshots') as no_snapshot_policy,
  not has_table_privilege('authenticated','public.fix_verification_snapshots','SELECT') as no_authenticated_snapshot_read,
  has_table_privilege('service_role','public.fix_verification_snapshots','SELECT') as service_role_snapshot_metadata_read,
  has_function_privilege('service_role','public.register_fix_verification_snapshot(uuid,uuid,text)','EXECUTE') as service_can_register_snapshot,
  not has_function_privilege('authenticated','public.register_fix_verification_snapshot(uuid,uuid,text)','EXECUTE') as authenticated_cannot_register_snapshot;
`;
const dbResult = run("docker", [
  "exec",
  container,
  "psql",
  "-U",
  "postgres",
  "-d",
  "postgres",
  "-At",
  "-F",
  "|",
  "-c",
  databaseChecks,
]).trim();
assert(dbResult === "t|t|t|t|t|t|t|t|t|t", "m1578r_storage_rls_or_private_bucket_failed");

const planRecoveryChecks = `
select
  (select relrowsecurity from pg_class where oid='public.fix_plan_recovery_authorizations'::regclass),
  not exists (select 1 from pg_policies where schemaname='public' and tablename='fix_plan_recovery_authorizations'),
  not has_table_privilege('authenticated','public.fix_plan_recovery_authorizations','SELECT'),
  has_table_privilege('service_role','public.fix_plan_recovery_authorizations','SELECT'),
  not has_table_privilege('service_role','public.fix_plan_recovery_authorizations','INSERT'),
  has_function_privilege('service_role','public.authorize_internal_fix_plan_contract_recovery(uuid,text,text)','EXECUTE'),
  not has_function_privilege('authenticated','public.authorize_internal_fix_plan_contract_recovery(uuid,text,text)','EXECUTE'),
  exists (select 1 from pg_trigger where tgname='fix_plan_recovery_authorizations_immutable' and not tgisinternal);
`;
const planRecoveryResult = run("docker", [
  "exec",
  container,
  "psql",
  "-U",
  "postgres",
  "-d",
  "postgres",
  "-At",
  "-F",
  "|",
  "-c",
  planRecoveryChecks,
]).trim();
assert(
  planRecoveryResult === "t|t|t|t|t|t|t|t",
  "m1578r_plan_recovery_rls_or_service_boundary_failed",
);

const patchRecoveryChecks = `
select
  (select relrowsecurity from pg_class where oid='public.fix_patch_recovery_authorizations'::regclass),
  not exists (select 1 from pg_policies where schemaname='public' and tablename='fix_patch_recovery_authorizations'),
  not has_table_privilege('authenticated','public.fix_patch_recovery_authorizations','SELECT'),
  has_table_privilege('service_role','public.fix_patch_recovery_authorizations','SELECT'),
  not has_table_privilege('service_role','public.fix_patch_recovery_authorizations','INSERT'),
  has_function_privilege('service_role','public.authorize_internal_fix_patch_contract_recovery(uuid,text,text)','EXECUTE'),
  not has_function_privilege('authenticated','public.authorize_internal_fix_patch_contract_recovery(uuid,text,text)','EXECUTE'),
  exists (select 1 from pg_trigger where tgname='fix_patch_recovery_authorizations_immutable' and not tgisinternal);
`;
const patchRecoveryResult = run("docker", [
  "exec",
  container,
  "psql",
  "-U",
  "postgres",
  "-d",
  "postgres",
  "-At",
  "-F",
  "|",
  "-c",
  patchRecoveryChecks,
]).trim();
assert(
  patchRecoveryResult === "t|t|t|t|t|t|t|t",
  "m1578r_patch_recovery_rls_or_service_boundary_failed",
);

const statusOutput = runSupabase([
  "status",
  "--output",
  "env",
  "--workdir",
  path.relative(root, stack),
]);
const values = new Map();
for (const line of statusOutput.split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match) values.set(match[1], match[2].replace(/^["']|["']$/g, ""));
}
const apiUrl = values.get("API_URL");
const serviceKey = values.get("SERVICE_ROLE_KEY");
const anonKey = values.get("ANON_KEY") ?? values.get("PUBLISHABLE_KEY");
assert(
  apiUrl === expectedApiUrl && serviceKey?.length > 20 && anonKey?.length > 20,
  "m1578r_local_service_configuration_unavailable",
);

let imageExists = true;
try {
  run("docker", ["image", "inspect", verificationImage]);
} catch {
  imageExists = false;
}
if (!imageExists)
  run("docker", ["pull", verificationImage], { timeout: 180_000, maxBuffer: 1_000_000 });
run(
  "docker",
  [
    "build",
    "--pull=false",
    "-t",
    smokeImage,
    "-f",
    "verification-runner/Dockerfile",
    "verification-runner",
  ],
  { timeout: 300_000, maxBuffer: 1_000_000 },
);
run("docker", ["volume", "create", smokeVolume]);
const dummyAuth = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
const dummyPublicKey =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n-----END PUBLIC KEY-----";
let smokeStarted = false;
try {
  run("docker", [
    "run",
    "-d",
    "--name",
    smokeName,
    "--mount",
    `type=volume,source=${smokeVolume},target=/srv/auterim-runner`,
    "-e",
    `FIX_VERIFICATION_RUNNER_AUTH_SECRET=${dummyAuth}`,
    "-e",
    `NEXT_PUBLIC_SUPABASE_URL=${apiUrl}`,
    "-e",
    `FIX_DEPENDENCY_CACHE_PUBLIC_KEY=${dummyPublicKey}`,
    smokeImage,
  ]);
  smokeStarted = true;
  waitForVerificationRunnerHealth(smokeName);
} finally {
  if (smokeStarted) run("docker", ["rm", "-f", smokeName]);
  run("docker", ["volume", "rm", smokeVolume]);
}

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
  AUTERIM_M1578_DOCKER_ACCEPTANCE: "1",
  AUTERIM_M1578R_DOCKER_ACCEPTANCE: "1",
  AUTERIM_M1578_EXPECTED_URL: apiUrl,
  AUTERIM_M1578_SERVICE_KEY: serviceKey,
  AUTERIM_M1578_ANON_KEY: anonKey,
  AUTERIM_M15_LOCAL_INTEGRATION: "1",
  AUTERIM_M15_LOCAL_SUPABASE_URL: apiUrl,
  AUTERIM_M15_LOCAL_SUPABASE_SECRET_KEY: serviceKey,
  AUTERIM_M1576_DOCKER_ACCEPTANCE: "1",
  AUTERIM_M1576_EXPECTED_URL: apiUrl,
  AUTERIM_M1576_SERVICE_KEY: serviceKey,
  AUTERIM_M1576_ANON_KEY: anonKey,
  AUTERIM_M1576_FIXTURE_COMMIT_SHA: expectedBaseSha,
  AUTERIM_M1576_PREVIOUS_COMMIT_SHA: run("git", ["rev-parse", `${expectedBaseSha}^`]).trim(),
  AUTERIM_M1577_POLICY_DOCKER_ACCEPTANCE: "1",
  NEXT_PUBLIC_SUPABASE_URL: apiUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: anonKey,
};

function runVitest(args, label) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "node_modules/vitest/vitest.mjs"), "run", ...args],
    {
      cwd: root,
      env,
      stdio: "inherit",
    },
  );
  if (result.error || result.status !== 0) {
    console.error(`${label}: FAIL`);
    process.exit(result.status ?? 1);
  }
}

runVitest(["tests/verification-runner.test.ts"], "M15.78R protocol/auth/idempotency tests");
runVitest(
  ["tests/fix-engine.docker.integration.test.ts", "tests/fix-engine.test.ts"],
  "M15.78 regression Docker matrix",
);
// Keep the exact-commit Code Intelligence fixture independent from the Fix
// Engine persistence fixture that may have reused the same repository/commit.
runSupabase(["db", "reset", "--local", "--no-seed", "--workdir", path.relative(root, stack)]);
runVitest(
  [
    "tests/code-intelligence.docker.integration.test.ts",
    "--testNamePattern",
    [
      "M15\\.77 builds an exact-commit graph",
      "persists canonical route handoffs and reusable exact-commit structural facts",
      "persists every fact for a synthetic analysis exceeding the PostgREST row cap",
      "fails closed when a selected relation references a missing entity",
      "rejects completion when a v3 relation lacks source provenance",
      "rejects v3 completion when a source reference lacks occurrence columns",
    ].join("|"),
  ],
  "M15.76 Code Intelligence regression",
);
// The M15.76 and M15.77 fixtures both use canonical Test IDs; reset only this
// isolated stack between suites so their mutable acceptance fixtures cannot
// affect each other's graph replay assertions.
runSupabase(["db", "reset", "--local", "--no-seed", "--workdir", path.relative(root, stack)]);
runVitest(
  [
    "--config",
    "vitest.m1577-docker.config.mts",
    "scripts/m1577-evidence-only-source-mode.docker.integration.test.ts",
  ],
  "M15.77 evidence-only regression",
);
runVitest(
  ["tests/fix-engine.persistence.docker.integration.test.ts"],
  "M15.78 canonical persisted remote-executor acceptance",
);
runVitest(
  ["tests/verification-runner.docker.integration.test.ts"],
  "M15.78R real cache-builder and remote-runner acceptance",
);

console.log("M15.78R isolated Docker/Supabase acceptance: PASS");
