import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const M157_FIXED_TARGET = Object.freeze({
  workspaceId: "e140d48e-9dc0-4552-a9a4-a81fe3872422",
  productId: "de1f2a12-de3c-4644-8892-b6c2d458a300",
  installationId: "43dfb9e9-787e-4818-b72e-d9616704f6b5",
  resourceId: "348b9342-b779-4668-9ab0-f42245cdcd49",
  externalProjectId: "prj_fENIbPMtNzudgAnLv4xsjqSOw8PK",
  teamId: "team_tM3JXep1ZWAuR2rAcvuTtXAf",
  supabaseProjectRef: "lnljaacbptrubppoypaz",
  repositoryOwner: "michelpronkk-oss",
  repositoryName: "auterim",
  initialReleaseSha: "b08510b852fe89a1df5438be9fd245d48c9a8dbd",
  initialBaselineEvidenceId: "598af30d-c1ab-4081-a67b-0b0980f92dfa",
  initialBaselineRunId: "ad81490d-1a6e-4d5f-8f78-9a9b3f633c4c",
});

const CHILD_ENVIRONMENT_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS",
  "CONNECTOR_CREDENTIAL_ACTIVE_KEY_VERSION",
] as const;

export function rejectM157TargetOverrides(args: readonly string[]) {
  if (args.length > 0) throw new Error("m157_cli_target_overrides_not_supported");
}

export function m157ChildEnvironment(
  source: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const child: Record<string, string | undefined> = {
    NODE_ENV: "test",
    AUTERIM_M157_DEPLOYMENT_ACCEPTANCE: "1",
  };
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) child[key] = value;
  }
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"] as const) {
    const value = source[key];
    if (value !== undefined) child[key] = value;
  }
  return child as NodeJS.ProcessEnv;
}

function fail(stage: string): never {
  throw new Error(`m157_runner_${stage}`);
}

function verifyLinkedProject(root: string) {
  let linked: { projectId?: unknown; orgId?: unknown };
  try {
    linked = JSON.parse(readFileSync(path.join(root, ".vercel", "project.json"), "utf8")) as {
      projectId?: unknown;
      orgId?: unknown;
    };
  } catch {
    fail("vercel_project_link_unavailable");
  }
  if (
    linked.projectId !== "prj_fENIbPMtNzudgAnLv4xsjqSOw8PK" ||
    linked.orgId !== "team_tM3JXep1ZWAuR2rAcvuTtXAf"
  )
    fail("vercel_project_identity_mismatch");
}

function verifyEnvironment(source: NodeJS.ProcessEnv) {
  let url: URL;
  try {
    url = new URL(source.NEXT_PUBLIC_SUPABASE_URL ?? "");
  } catch {
    fail("supabase_url_unavailable");
  }
  if (url.hostname !== `${M157_FIXED_TARGET.supabaseProjectRef}.supabase.co`)
    fail("supabase_project_mismatch");
  if (!source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) fail("supabase_public_key_unavailable");
  if (!(source.SUPABASE_SECRET_KEY || source.SUPABASE_SERVICE_ROLE_KEY))
    fail("supabase_server_credential_unavailable");
  if (!source.GITHUB_APP_ID || !source.GITHUB_APP_PRIVATE_KEY)
    fail("github_app_configuration_unavailable");
  if (!source.CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS) fail("connector_keyring_unavailable");
  if (source.CONNECTOR_CREDENTIAL_ACTIVE_KEY_VERSION !== "1")
    fail("connector_active_key_version_mismatch");
  let keyring: Record<string, unknown>;
  try {
    keyring = JSON.parse(source.CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS) as Record<string, unknown>;
  } catch {
    fail("connector_keyring_invalid");
  }
  if (typeof keyring["1"] !== "string") fail("connector_key_version_1_unavailable");
}

function main() {
  rejectM157TargetOverrides(process.argv.slice(2));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  verifyLinkedProject(root);
  verifyEnvironment(process.env);

  const vitestEntry = path.join(root, "node_modules", "vitest", "vitest.mjs");
  const child = spawnSync(
    process.execPath,
    [vitestEntry, "run", "tests/m157-deployment-acceptance.live.test.ts", "--reporter=basic"],
    { cwd: root, env: m157ChildEnvironment(process.env), stdio: "inherit" },
  );
  if (child.error) fail("vitest_start_failed");
  if (child.status !== 0) process.exitCode = child.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main();
