import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const stack = path.join(root, "node_modules/.cache/auterim-m1578-local");
const expectedRemote = "https://github.com/michelpronkk-oss/auterim.git";
const expectedBranch = "codex/m1578-fix-engine-v1";
const expectedApiUrl = "http://127.0.0.1:54970";
const container = "supabase_db_auterim-m1578-local";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function runSupabase(args) {
  if (process.platform !== "win32") return run("npx", ["supabase", ...args]);
  return run("cmd.exe", ["/d", "/s", "/c", `npx supabase ${args.join(" ")}`]);
}

function assert(value, category) {
  if (!value) throw new Error(category);
}

assert(path.basename(root).toLowerCase() === "auterim", "m1578_repository_identity_failed");
assert(
  run("git", ["remote", "get-url", "origin"]).trim() === expectedRemote,
  "m1578_remote_identity_failed",
);
assert(
  run("git", ["branch", "--show-current"]).trim() === expectedBranch,
  "m1578_branch_identity_failed",
);
assert(
  run("docker", ["context", "show"]).trim() === "desktop-linux",
  "m1578_docker_context_failed",
);
const projectIdentity = readFileSync(path.join(root, ".project-identity"), "utf8");
assert(
  projectIdentity.includes("PROJECT_NAME=Auterim") &&
    projectIdentity.includes("EXPECTED_TRIGGER_PROJECT=proj_hwqtxtyrvwykjirkrdoh"),
  "m1578_project_identity_failed",
);
const triggerConfig = readFileSync(path.join(root, "trigger.config.ts"), "utf8");
assert(
  /project:\s*["']proj_hwqtxtyrvwykjirkrdoh["']/.test(triggerConfig),
  "m1578_trigger_project_identity_failed",
);
assert(existsSync(path.join(stack, "supabase/config.toml")), "m1578_isolated_stack_missing");
const config = readFileSync(path.join(stack, "supabase/config.toml"), "utf8");
assert(/project_id\s*=\s*["']auterim-m1578-local["']/.test(config), "m1578_stack_identity_failed");
assert(
  /port\s*=\s*54970/.test(config) && /port\s*=\s*54971/.test(config),
  "m1578_stack_port_identity_failed",
);
assert(
  run("docker", ["inspect", "--format", "{{.State.Status}}", container]).trim() === "running",
  "m1578_local_database_unavailable",
);

for (const filename of readdirSync(path.join(root, "supabase/migrations")).filter((name) =>
  name.endsWith(".sql"),
)) {
  const source = path.join(root, "supabase/migrations", filename);
  const destination = path.join(stack, "supabase/migrations", filename);
  if (!existsSync(destination) || !readFileSync(source).equals(readFileSync(destination)))
    copyFileSync(source, destination);
}
runSupabase(["db", "reset", "--local", "--no-seed", "--workdir", path.relative(root, stack)]);

const catalogSql = `
select
  (select count(*)=11 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(array['fix_runs','fix_model_attempts','fix_stage_queue','fix_diagnoses','fix_plans','fix_patches','fix_verification_runs','fix_preflight_results','fix_risk_assessments','fix_external_operations','fix_pr_outcomes'])) as tables_present,
  (select count(*)=11 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(array['fix_runs','fix_model_attempts','fix_stage_queue','fix_diagnoses','fix_plans','fix_patches','fix_verification_runs','fix_preflight_results','fix_risk_assessments','fix_external_operations','fix_pr_outcomes']) and c.relrowsecurity) as rls_enabled,
  has_function_privilege('service_role','public.create_fix_run_from_graph(uuid)','EXECUTE') as service_rpc,
  not has_function_privilege('authenticated','public.create_fix_run_from_graph(uuid)','EXECUTE') as authenticated_rpc_denied,
  has_function_privilege('service_role','public.list_fix_stage_work(integer)','EXECUTE') as service_recovery_rpc,
  not has_function_privilege('authenticated','public.list_fix_stage_work(integer)','EXECUTE') as authenticated_recovery_denied,
  has_function_privilege('service_role','public.complete_fix_patch_artifact_purge(text[])','EXECUTE') as service_artifact_purge_rpc,
  not has_function_privilege('authenticated','public.complete_fix_patch_artifact_purge(text[])','EXECUTE') as authenticated_artifact_purge_denied,
  not has_table_privilege('authenticated','public.fix_runs','INSERT') as authenticated_dml_denied,
  not has_table_privilege('service_role','public.fix_runs','INSERT') as service_direct_dml_denied,
  (select not public from storage.buckets where id='fix-engine-artifacts') as private_artifact_bucket,
  position('delete from storage.objects' in lower(pg_get_functiondef('public.purge_expired_fix_patch_artifacts(integer)'::regprocedure)))=0 as storage_api_deletion_only,
  exists(select 1 from pg_constraint where conname='fix_run_provenance_pair' and contype='c') as provenance_check,
  exists(select 1 from pg_constraint where conname='fix_run_classification_source_fkey' and contype='f') as classification_source_scope,
  exists(select 1 from pg_trigger where tgname='fix_stage_scope_guard' and not tgisinternal) as stage_hard_block;
`;
const catalog = run("docker", [
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
  catalogSql,
]).trim();
assert(catalog === "t|t|t|t|t|t|t|t|t|t|t|t|t|t|t", "m1578_database_security_parity_failed");
const preflightApplicabilitySql = `
select
  private.fix_preflight_applicable('provider','deprecation',true,true,true),
  private.fix_preflight_applicable('provider','pricing_change',true,true,true),
  private.fix_preflight_applicable('provider','deprecation',false,true,true),
  private.fix_preflight_applicable('provider','deprecation',true,true,false),
  private.fix_preflight_applicable('internal_test','deprecation',true,true,true);
`;
const preflightApplicability = run("docker", [
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
  preflightApplicabilitySql,
]).trim();
assert(preflightApplicability === "t|f|f|f|f", "m1578_preflight_applicability_contract_failed");

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
  if (match) values.set(match[1], match[2].replace(/^['"]|['"]$/g, ""));
}
const apiUrl = values.get("API_URL");
const serviceKey = values.get("SERVICE_ROLE_KEY");
const anonKey = values.get("ANON_KEY") ?? values.get("PUBLISHABLE_KEY");
assert(
  apiUrl === expectedApiUrl && serviceKey?.length > 20 && anonKey?.length > 20,
  "m1578_local_service_configuration_unavailable",
);
const commitSha = run("git", ["rev-parse", "HEAD"]).trim();
const previousCommitSha = run("git", ["rev-parse", "HEAD^"]).trim();
assert(
  /^[a-f0-9]{40,64}$/.test(commitSha) && /^[a-f0-9]{40,64}$/.test(previousCommitSha),
  "m1578_fixture_commit_identity_failed",
);

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
  AUTERIM_M1576_FIXTURE_COMMIT_SHA: commitSha,
  AUTERIM_M1576_PREVIOUS_COMMIT_SHA: previousCommitSha,
  AUTERIM_M1577_POLICY_DOCKER_ACCEPTANCE: "1",
  AUTERIM_M1578_EXPECTED_URL: apiUrl,
  NEXT_PUBLIC_SUPABASE_URL: apiUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: anonKey,
};
function runVitest(args, label) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "node_modules/vitest/vitest.mjs"), "run", ...args],
    { cwd: root, env, stdio: "inherit" },
  );
  if (result.error || result.status !== 0) {
    console.error(`${label}: FAIL`);
    process.exit(result.status ?? 1);
  }
}
runVitest(
  ["tests/fix-engine.docker.integration.test.ts", "tests/fix-engine.test.ts"],
  "M15.78 Docker matrix",
);
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
  "M15.76 Docker regression",
);
runVitest(
  [
    "--config",
    "vitest.m1577-docker.config.mts",
    "scripts/m1577-evidence-only-source-mode.docker.integration.test.ts",
  ],
  "M15.77 Docker regression",
);
runVitest(
  ["tests/fix-engine.persistence.docker.integration.test.ts"],
  "M15.78 persistence Docker acceptance",
);
console.log("M15.78 isolated Docker/Supabase acceptance and M15.76/M15.77 regressions: PASS");
