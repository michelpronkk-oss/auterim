import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

const EXPECTED_ROOT = "C:\\Users\\miche\\Desktop\\Auterim";
const LOCAL_URL = "http://127.0.0.1:65431";
const LOCAL_DB_CONTAINER = "supabase_db_auterim-m15-acceptance";
const LOCAL_GATEWAY_CONTAINER = "supabase_kong_auterim-m15-acceptance";
const LOCAL_SUPABASE_WORKDIR = path.join("node_modules", ".cache", "m15-local");
const TEST_FILE = "tests/m157-protection-graph-local.integration.test.ts";

function fail(stage: string): never {
  process.stderr.write(`M157_LOCAL_GRAPH_DIAGNOSTIC_FAILED=${stage}\n`);
  throw new Error(`m157_local_graph_${stage}`);
}

function run(command: string, args: string[], maxBuffer = 128 * 1024) {
  const result = spawnSync(command, args, {
    cwd: EXPECTED_ROOT,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function captureLocalCredentialOutput() {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(
    command,
    ["supabase", "status", "--workdir", LOCAL_SUPABASE_WORKDIR, "--output", "env"],
    {
      cwd: EXPECTED_ROOT,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024,
      shell: process.platform === "win32",
    },
  );
  if (result.error || result.status !== 0) fail("local_supabase_status_unavailable");

  const values = new Map<string, string>();
  for (const line of (result.stdout ?? "").split(/\r?\n/)) {
    const match = /^(ANON_KEY|PUBLISHABLE_KEY|SECRET_KEY|SERVICE_ROLE_KEY)="([^"]+)"$/.exec(
      line.trim(),
    );
    if (match) values.set(match[1]!, match[2]!);
  }
  const publishableKey = values.get("PUBLISHABLE_KEY") ?? values.get("ANON_KEY");
  const secretKey = values.get("SECRET_KEY") ?? values.get("SERVICE_ROLE_KEY");
  if (!publishableKey || !secretKey || secretKey.length < 20)
    fail("local_supabase_credentials_unavailable");
  return { publishableKey, secretKey };
}

async function verifyLocalBinding(secretKey: string) {
  const client = createClient(LOCAL_URL, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.from("deployment_surfaces").select("id").limit(0);
  if (error) fail("local_supabase_schema_or_auth_unavailable");
}

function safeChildEnvironment(credentials: { publishableKey: string; secretKey: string }) {
  const result: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
  ] as const) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  result.AUTERIM_M15_LOCAL_INTEGRATION = "1";
  result.AUTERIM_M15_LOCAL_SUPABASE_URL = LOCAL_URL;
  result.AUTERIM_M15_LOCAL_SUPABASE_SECRET_KEY = credentials.secretKey;
  result.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL;
  result.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = credentials.publishableKey;
  result.SUPABASE_SECRET_KEY = credentials.secretKey;
  return result;
}

function runIntegrationTest(credentials: { publishableKey: string; secretKey: string }) {
  const vitestEntry = path.join(EXPECTED_ROOT, "node_modules", "vitest", "vitest.mjs");
  const result = spawnSync(
    process.execPath,
    [vitestEntry, "run", TEST_FILE, "--reporter=dot", "--no-file-parallelism"],
    {
      cwd: EXPECTED_ROOT,
      env: safeChildEnvironment(credentials),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 128 * 1024,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
    .replaceAll(credentials.secretKey, "[redacted]")
    .replaceAll(credentials.publishableKey, "[redacted]")
    .replace(/eyJ[A-Za-z0-9._-]{30,}/g, "[redacted]");
  process.stdout.write(output);
  if (result.error || result.status !== 0) fail("local_graph_integration_failed");
}

async function main() {
  if (process.cwd().toLowerCase() !== EXPECTED_ROOT.toLowerCase()) fail("auterim_workdir_required");
  if (run("docker", ["context", "show"]) !== "desktop-linux") fail("docker_context_mismatch");

  const configPath = path.join(EXPECTED_ROOT, LOCAL_SUPABASE_WORKDIR, "supabase", "config.toml");
  let localConfig: string;
  try {
    localConfig = readFileSync(configPath, "utf8");
  } catch {
    fail("local_auterim_supabase_config_missing");
  }
  if (!/^project_id\s*=\s*"auterim-m15-acceptance"/m.test(localConfig))
    fail("local_auterim_supabase_project_mismatch");

  const gatewayPorts = run("docker", ["port", LOCAL_GATEWAY_CONTAINER]);
  const databasePorts = run("docker", ["port", LOCAL_DB_CONTAINER]);
  if (!gatewayPorts?.includes("65431") || !databasePorts?.includes("65432"))
    fail("local_auterim_docker_port_mapping_mismatch");
  if (
    !run("docker", ["exec", LOCAL_DB_CONTAINER, "pg_isready", "-U", "postgres", "-d", "postgres"])
  )
    fail("local_auterim_database_unavailable");

  const migrationReady = run("docker", [
    "exec",
    LOCAL_DB_CONTAINER,
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-Atc",
    "select count(*) from supabase_migrations.schema_migrations where version='20261126000000'",
  ]);
  if (migrationReady !== "1") fail("local_migrations_not_current");

  const credentials = captureLocalCredentialOutput();
  await verifyLocalBinding(credentials.secretKey);
  process.stdout.write(
    "LOCAL_BINDING=PASS URL=127.0.0.1:65431 PROJECT=auterim-m15-acceptance DOCKER=desktop-linux\n",
  );
  runIntegrationTest(credentials);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    if (error instanceof Error && /^m157_local_graph_/.test(error.message)) process.exitCode = 1;
    else {
      process.stderr.write("M157_LOCAL_GRAPH_DIAGNOSTIC_FAILED=unexpected_local_failure\n");
      process.exitCode = 1;
    }
  });
}
