import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertStructuredCommand,
  type VerificationCommand,
} from "@/lib/fix-engine/verification-profile";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_REPOSITORY_BYTES = 25 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;

function runWithInput(command: string, args: string[], input: string, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const consume = (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("sandbox_command_output_limit"));
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", (error) => finish(error));
    child.on("close", (code) =>
      finish(code === 0 ? undefined : new Error("sandbox_command_failed")),
    );
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("sandbox_command_timeout"));
    }, timeoutMs);
    child.stdin.end(input);
  });
}

async function inspectTree(root: string, current = root): Promise<number> {
  let total = 0;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name.toLowerCase())) continue;
    const target = path.join(current, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error("sandbox_symlink_forbidden");
    if (info.isDirectory()) total += await inspectTree(root, target);
    else if (info.isFile()) total += info.size;
    else throw new Error("sandbox_special_file_forbidden");
    if (total > MAX_REPOSITORY_BYTES) throw new Error("sandbox_repository_size_exceeded");
  }
  return total;
}

async function removeSensitiveFiles(root: string, current = root): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error("sandbox_symlink_forbidden");
    if (info.isDirectory()) {
      await removeSensitiveFiles(root, target);
      continue;
    }
    const relative = path.relative(root, target).replaceAll("\\", "/");
    if (
      /(^|\/)\.env(?:\..*)?$/i.test(relative) ||
      /(^|\/)(?:secrets?|credentials?)(?:\.[^/]*)?$/i.test(relative) ||
      /\.(?:pem|key|p12|pfx)$/i.test(relative)
    ) {
      await rm(target, { force: true });
    }
  }
}

export async function applyValidatedPatchInIsolatedCheckout(input: {
  checkoutPath: string;
  expectedBaseSha: string;
  /** Set only after a trusted provider materialized an immutable commit archive at this SHA. */
  verifiedSnapshotSha?: string;
  unifiedDiff: string;
}) {
  if (!/^[a-f0-9]{40,64}$/.test(input.expectedBaseSha)) throw new Error("invalid_sandbox_base_sha");
  await inspectTree(input.checkoutPath);
  const gitHead = await execFileAsync("git", ["-C", input.checkoutPath, "rev-parse", "HEAD"], {
    windowsHide: true,
    timeout: 10_000,
  });
  if (input.verifiedSnapshotSha) {
    if (input.verifiedSnapshotSha.toLowerCase() !== input.expectedBaseSha.toLowerCase())
      throw new Error("sandbox_snapshot_sha_mismatch");
  } else if (gitHead.stdout.trim().toLowerCase() !== input.expectedBaseSha.toLowerCase()) {
    throw new Error("sandbox_base_sha_mismatch");
  }
  const status = await execFileAsync("git", ["-C", input.checkoutPath, "status", "--porcelain"], {
    windowsHide: true,
    timeout: 10_000,
  });
  if (status.stdout.trim()) throw new Error("sandbox_initial_tree_not_clean");
  await runWithInput(
    "git",
    ["-C", input.checkoutPath, "apply", "--check", "--whitespace=error", "-"],
    input.unifiedDiff,
    15_000,
  );
  await runWithInput(
    "git",
    ["-C", input.checkoutPath, "apply", "--whitespace=error", "-"],
    input.unifiedDiff,
    15_000,
  );
  await inspectTree(input.checkoutPath);
  return { baseSha: input.expectedBaseSha.toLowerCase(), status: "applied" as const };
}

/** Applies a patch only to a provider-fetched immutable commit snapshot in a disposable checkout. */
export async function withExactBaseGitHubSnapshot<T>(input: {
  expectedBaseSha: string;
  materialize: (destination: string, commitSha: string) => Promise<{ skippedLinks: number }>;
  unifiedDiff: string;
  run: (checkoutPath: string) => Promise<T>;
}) {
  if (!/^[a-f0-9]{40,64}$/.test(input.expectedBaseSha)) throw new Error("invalid_sandbox_base_sha");
  const parent = await mkdtemp(path.join(tmpdir(), "auterim-fix-snapshot-"));
  const checkoutPath = path.join(parent, "checkout");
  await mkdir(checkoutPath, { recursive: true });
  const gitEnv = {
    PATH: process.env.PATH ?? "",
    SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    NODE_ENV: "production" as const,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  };
  try {
    const snapshot = await input.materialize(checkoutPath, input.expectedBaseSha);
    if (snapshot.skippedLinks !== 0) throw new Error("sandbox_symlink_snapshot_unsupported");
    await removeSensitiveFiles(checkoutPath);
    await inspectTree(checkoutPath);
    await execFileAsync("git", ["-C", checkoutPath, "init", "--quiet"], {
      windowsHide: true,
      timeout: 10_000,
      env: gitEnv,
    });
    await execFileAsync("git", ["-C", checkoutPath, "add", "--force", "--all"], {
      windowsHide: true,
      timeout: 15_000,
      env: gitEnv,
    });
    await execFileAsync(
      "git",
      [
        "-C",
        checkoutPath,
        "-c",
        "user.name=Auterim Snapshot",
        "-c",
        "user.email=fix-snapshot@auterim.invalid",
        "-c",
        `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "Auterim isolated immutable snapshot",
      ],
      { windowsHide: true, timeout: 15_000, env: gitEnv },
    );
    await applyValidatedPatchInIsolatedCheckout({
      checkoutPath,
      expectedBaseSha: input.expectedBaseSha,
      verifiedSnapshotSha: input.expectedBaseSha,
      unifiedDiff: input.unifiedDiff,
    });
    return await input.run(checkoutPath);
  } catch (error) {
    const category =
      error instanceof Error && /^[a-z0-9_]{1,100}$/.test(error.message)
        ? error.message
        : "sandbox_setup_failed";
    throw new Error(category);
  } finally {
    await rm(parent, { recursive: true, force: true }).catch(() => {
      throw new Error("sandbox_cleanup_failed");
    });
  }
}

/** Makes a disposable clone at an exact commit; the source checkout is never patched. */
export async function withExactBaseFixCheckout<T>(input: {
  sourceRepositoryPath: string;
  expectedBaseSha: string;
  unifiedDiff: string;
  run: (checkoutPath: string) => Promise<T>;
}): Promise<T> {
  if (!/^[a-f0-9]{40,64}$/.test(input.expectedBaseSha)) throw new Error("invalid_sandbox_base_sha");
  if (!path.isAbsolute(input.sourceRepositoryPath) || input.sourceRepositoryPath.includes("://"))
    throw new Error("sandbox_source_must_be_local");
  const parent = await mkdtemp(path.join(tmpdir(), "auterim-fix-"));
  const checkoutPath = path.join(parent, "checkout");
  const gitEnv = {
    PATH: process.env.PATH ?? "",
    SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    NODE_ENV: "production" as const,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  };
  try {
    await execFileAsync(
      "git",
      ["clone", "--no-hardlinks", "--no-checkout", input.sourceRepositoryPath, checkoutPath],
      {
        windowsHide: true,
        timeout: 60_000,
        env: gitEnv,
      },
    );
    await execFileAsync(
      "git",
      ["-C", checkoutPath, "checkout", "--detach", input.expectedBaseSha],
      {
        windowsHide: true,
        timeout: 30_000,
        env: gitEnv,
      },
    );
    await applyValidatedPatchInIsolatedCheckout({
      checkoutPath,
      expectedBaseSha: input.expectedBaseSha,
      unifiedDiff: input.unifiedDiff,
    });
    return await input.run(checkoutPath);
  } catch (error) {
    const category =
      error instanceof Error && /^[a-z0-9_]{1,100}$/.test(error.message)
        ? error.message
        : "sandbox_setup_failed";
    throw new Error(category);
  } finally {
    await rm(parent, { recursive: true, force: true }).catch(() => {
      throw new Error("sandbox_cleanup_failed");
    });
  }
}

export async function runVerificationInDocker(input: {
  checkoutPath: string;
  image: string;
  command: VerificationCommand;
  timeoutMs?: number;
}) {
  assertStructuredCommand(input.command);
  if (!/^sha256:[a-f0-9]{64}$/.test(input.image)) throw new Error("validator_image_not_pinned");
  await inspectTree(input.checkoutPath);
  const started = Date.now();
  const bootstrap = [
    "const fs = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    "fs.cpSync('/source', '/workspace', { recursive: true, filter: (source) => !['.git', 'node_modules'].includes(require('node:path').basename(source).toLowerCase()) });",
    `const result = spawnSync(process.execPath, ${JSON.stringify(input.command.args)}, { cwd: '/workspace', encoding: 'utf8', timeout: ${Math.min(Math.max(input.timeoutMs ?? MAX_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS)}, maxBuffer: ${MAX_OUTPUT_BYTES}, env: { NODE_ENV: 'production', PATH: process.env.PATH ?? '' } });`,
    "if (result.stdout) process.stdout.write(result.stdout);",
    "if (result.stderr) process.stderr.write(result.stderr);",
    "if (result.error) { process.stderr.write('verification_command_failed'); process.exit(1); }",
    "process.exit(Number.isInteger(result.status) ? result.status : 1);",
  ].join("\n");
  try {
    const result = await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "--network=none",
        "--pull=never",
        "--memory=512m",
        "--cpus=1",
        "--pids-limit=64",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700",
        "--tmpfs",
        "/workspace:rw,nosuid,size=128m,uid=1000,gid=1000,mode=0700",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--user",
        "1000:1000",
        "--volume",
        `${input.checkoutPath}:/source:ro`,
        "--workdir",
        "/workspace",
        "--entrypoint",
        "node",
        input.image,
        "-e",
        bootstrap,
      ],
      {
        windowsHide: true,
        timeout: Math.min(Math.max(input.timeoutMs ?? MAX_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS),
        maxBuffer: MAX_OUTPUT_BYTES,
        env: {
          PATH: process.env.PATH ?? "",
          SYSTEMROOT: process.env.SYSTEMROOT ?? "",
          NODE_ENV: "production",
        },
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    return {
      status: "passed" as const,
      durationMs: Date.now() - started,
      outputBytes: Buffer.byteLength(output),
      diagnosticCategory: null,
    };
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? String(error.code)
        : "verification_failed";
    const timeout = /timeout|ETIMEDOUT/i.test(code);
    return {
      status: "failed" as const,
      durationMs: Date.now() - started,
      outputBytes: 0,
      diagnosticCategory: timeout ? "verification_timeout" : "verification_command_failed",
    };
  }
}

export const FIX_SANDBOX_LIMITS = {
  maxRepositoryBytes: MAX_REPOSITORY_BYTES,
  maxTimeoutMs: MAX_TIMEOUT_MS,
  maxOutputBytes: MAX_OUTPUT_BYTES,
} as const;
