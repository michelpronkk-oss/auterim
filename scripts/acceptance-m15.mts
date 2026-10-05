import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { validatePatchInDocker } from "../src/lib/preflight/docker-validation-core.ts";

type Stage = { name: string; status: "PASS" | "FAIL"; detail: string };
const stages: Stage[] = [];
const root = process.cwd();
const localWorkdir = path.join(root, "node_modules", ".cache", "m15-local");
const localSupabase = path.join(localWorkdir, "supabase");
const maxOutput = 128 * 1024;

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

function run(command: string, args: string[], timeout = 180_000) {
  const executable =
    process.platform === "win32" && ["supabase", "docker", "git"].includes(command)
      ? `${command}.exe`
      : command;
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    timeout,
    maxBuffer: maxOutput,
    windowsHide: true,
    shell: process.platform === "win32" && ["npm", "npx"].includes(command),
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    ok: !result.error && result.status === 0,
    failureCode: errorCode(result.error) ?? String(result.status ?? "unknown"),
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

function record(name: string, ok: boolean, detail: string) {
  stages.push({ name, status: ok ? "PASS" : "FAIL", detail });
  return ok;
}

function safeFailure(result: ReturnType<typeof run>) {
  return result.ok ? "ok" : result.failureCode;
}

async function prepareIsolatedSupabase() {
  const config = await readFile(path.join(root, "supabase", "config.toml"), "utf8");
  const versions = (await readdir(path.join(root, "supabase", "migrations")))
    .filter((name) => /^\d{14}_.+\.sql$/.test(name))
    .map((name) => name.slice(0, 14))
    .sort();
  await mkdir(path.join(localSupabase, "migrations"), { recursive: true });
  const localConfig = config
    .replace('project_id = "auterim"', 'project_id = "auterim-m15-acceptance"')
    .replace(/^port = 54321$/m, "port = 65431")
    .replace(/^port = 54322$/m, "port = 65432")
    .replace(/^shadow_port = 54320$/m, "shadow_port = 65430")
    .replace(/^port = 54329$/m, "port = 65429")
    .replace(/^port = 54323$/m, "port = 65433")
    .replace(/^port = 54324$/m, "port = 65434")
    .replace(/^port = 54327$/m, "port = 65437")
    .replace(/^inspector_port = 8083$/m, "inspector_port = 68083")
    .replace(/^openai_api_key = .*$/m, 'openai_api_key = ""');
  await writeFile(path.join(localSupabase, "config.toml"), localConfig, "utf8");
  await cp(path.join(root, "supabase", "migrations"), path.join(localSupabase, "migrations"), {
    recursive: true,
    filter: (source) => !source.endsWith(".DS_Store"),
  });
  return versions;
}

async function dockerFixtureProof(): Promise<{ ok: boolean; failureCode?: string }> {
  const fixture = path.join(root, "tests", "fixtures", "m15-money-path");
  const patch = [
    "diff --git a/src/client.ts b/src/client.ts",
    "--- a/src/client.ts",
    "+++ b/src/client.ts",
    "@@ -14,1 +14,1 @@",
    "-  return legacyClient.send();",
    "+  return modernClient.send();",
    "",
  ].join("\n");
  const imageBuild = spawnSync(
    process.platform === "win32" ? "docker.exe" : "docker",
    [
      "build",
      "--file",
      "scripts/m15-validation/Dockerfile",
      "--tag",
      "auterim/m15-validator:1",
      ".",
    ],
    { cwd: root, encoding: "utf8", timeout: 600_000, maxBuffer: maxOutput, windowsHide: true },
  );
  if (imageBuild.error || imageBuild.status !== 0) {
    return { ok: false, failureCode: errorCode(imageBuild.error) ?? String(imageBuild.status) };
  }
  const validation = await validatePatchInDocker({
    repositoryDirectory: fixture,
    patch,
    timeoutMs: 120_000,
  });
  return {
    ok: validation.state === "VALIDATED",
    failureCode: validation.state === "VALIDATED" ? undefined : validation.category,
  };
}

const project = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
  name?: string;
};
if (
  project.name !== "auterim" ||
  !(await readFile(path.join(root, "AGENTS.md"), "utf8")).includes("Auterim Supabase project")
) {
  process.stdout.write(
    JSON.stringify({
      acceptance: "FAIL",
      stages: [
        { name: "PROJECT_ISOLATION", status: "FAIL", detail: "Auterim repository root required" },
      ],
    }),
  );
  process.exit(1);
}

const projectCheck = run("npm", ["run", "project:check"]);
record(
  "ENVIRONMENT",
  projectCheck.ok,
  projectCheck.ok ? "Auterim identity checks passed" : "project:check failed; output withheld",
);
const envCheck = run("npm", ["run", "env:check"]);
record(
  "ENV_CONFIGURATION",
  envCheck.ok,
  envCheck.ok ? "environment presence check passed" : "env:check failed; output withheld",
);

let expectedMigrations: string[] = [];
try {
  expectedMigrations = await prepareIsolatedSupabase();
  const started = run("supabase", [
    "start",
    "--workdir",
    localWorkdir,
    "--exclude",
    "studio,mailpit,storage-api,imgproxy,edge-runtime,logflare,vector,supavisor",
  ]);
  const reset = started.ok
    ? run("supabase", ["db", "reset", "--local", "--no-seed", "--workdir", localWorkdir])
    : started;
  const history = reset.ok
    ? run("supabase", ["migration", "list", "--local", "--workdir", localWorkdir])
    : reset;
  const localVersions = [...history.output.matchAll(/^\s*(\d{14})\s*\|/gm)].map(
    (match) => match[1]!,
  );
  const dbOk =
    started.ok &&
    reset.ok &&
    expectedMigrations.every((version) => localVersions.includes(version));
  record(
    "DATABASE",
    dbOk,
    dbOk
      ? `${expectedMigrations.length} migrations applied and present in local history`
      : `local stack=${safeFailure(started)}, reset=${safeFailure(reset)}, history=${safeFailure(history)}, migrations=${localVersions.length}/${expectedMigrations.length}`,
  );
} catch {
  record("DATABASE", false, "could not prepare isolated local Postgres");
}

const fixTests = run("npx", [
  "vitest",
  "run",
  "tests/preflight.test.ts",
  "-t",
  "exact replacement grounded in the verified pinned file",
]);
record(
  "FIX_PREPARATION",
  fixTests.ok,
  fixTests.ok
    ? "exact pinned-file replacement tests passed"
    : "patch preparation test failed; output withheld",
);
const entitlementTests = run("npx", [
  "vitest",
  "run",
  "tests/billing.test.ts",
  "-t",
  "explicit Business policy",
]);
record(
  "ENTITLEMENT_POLICY",
  entitlementTests.ok,
  entitlementTests.ok
    ? "canonical entitlement and policy tests passed"
    : "entitlement/policy test failed; output withheld",
);
let dockerProof: { ok: boolean; failureCode?: string } = {
  ok: false,
  failureCode: "exception",
};
try {
  dockerProof = await dockerFixtureProof();
} catch {
  dockerProof = { ok: false, failureCode: "exception" };
}
record(
  "PATCH_VALIDATION",
  dockerProof.ok,
  dockerProof.ok
    ? "fixture patch tests and typecheck passed in bounded no-network container"
    : `container validation process ${dockerProof.failureCode}`,
);

for (const [name, detail] of [
  [
    "TENANT_ISOLATION",
    "real local Supabase adversarial membership/RLS execution is not wired into this harness",
  ],
  [
    "PROTECTED_PRODUCT_DEPENDENCY",
    "synthetic change is not yet ingested through the persisted product-scoped pipeline",
  ],
  [
    "TRIGGER_PIPELINE",
    "Trigger.dev dev dispatch, claim, retry, and completion are not yet exercised by this harness",
  ],
  [
    "PREFLIGHT_PERSISTENCE",
    "fixture Preflight is not yet persisted through the real queue and database path",
  ],
  [
    "PATCH_PERSISTENCE",
    "patch generation is tested, but automatic proposal persistence and validation-state history are not wired",
  ],
  [
    "LIFECYCLE_IDEMPOTENCY",
    "archive, downgrade, replay, and concurrent remediation acceptance remains unwired",
  ],
]) {
  record(name, false, detail);
}

const passed = stages.filter((stage) => stage.status === "PASS").length;
const failed = stages.length - passed;
process.stdout.write(
  `${JSON.stringify({ acceptance: failed === 0 ? "PASS" : "FAIL", passed, failed, stages }, null, 2)}\n`,
);
if (failed > 0) process.exitCode = 1;
