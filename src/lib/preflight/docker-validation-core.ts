import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";

export const M15_VALIDATOR_IMAGE = "auterim/m15-validator:1";
const MAX_REPOSITORY_BYTES = 25 * 1024 * 1024;
const MAX_VALIDATION_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

function inside(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

async function measureSafeTree(root: string, current = root): Promise<number> {
  let total = 0;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (
      entry.name === ".git" ||
      entry.name === "node_modules" ||
      entry.name === ".env" ||
      entry.name.startsWith(".env.")
    )
      continue;
    const target = path.join(current, entry.name);
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error("validation_symlink_forbidden");
    if (entry.isDirectory()) total += await measureSafeTree(root, target);
    else if (entry.isFile()) total += stat.size;
    else throw new Error("validation_special_file_forbidden");
    if (total > MAX_REPOSITORY_BYTES) throw new Error("validation_repository_too_large");
  }
  return total;
}

function boundedOutput(value: string) {
  return Buffer.from(value, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
}

export async function validatePatchInDocker(input: {
  repositoryDirectory: string;
  patch: string;
  timeoutMs?: number;
}) {
  const startedAt = Date.now();
  const timeoutMs = Math.min(
    Math.max(input.timeoutMs ?? MAX_VALIDATION_MS, 1_000),
    MAX_VALIDATION_MS,
  );
  const scratchRoot = path.resolve("node_modules/.cache/m15-validation");
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(path.join(scratchRoot, "run-"));
  const repo = path.join(scratch, "repo");
  try {
    const source = path.resolve(input.repositoryDirectory);
    if (!inside(path.resolve("."), source)) throw new Error("validation_source_outside_workspace");
    await measureSafeTree(source);
    await cp(source, repo, {
      recursive: true,
      filter: (candidate) => {
        const name = path.basename(candidate);
        return (
          name !== ".git" && name !== "node_modules" && name !== ".env" && !name.startsWith(".env.")
        );
      },
    });
    const git = process.platform === "win32" ? "git.exe" : "git";
    const checked = spawnSync(git, ["apply", "--check", "--whitespace=error", "-"], {
      cwd: repo,
      input: input.patch,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    if (checked.error || checked.status !== 0) {
      return {
        state: "VALIDATION_FAILED" as const,
        category: "patch_not_applicable",
        commands: ["git apply --check"],
        output: boundedOutput(checked.stderr || checked.stdout || "Patch did not apply cleanly."),
        durationMs: Date.now() - startedAt,
      };
    }
    const applied = spawnSync(git, ["apply", "--whitespace=error", "-"], {
      cwd: repo,
      input: input.patch,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    if (applied.error || applied.status !== 0) throw new Error("patch_apply_failed");

    const result = spawnSync(
      process.platform === "win32" ? "docker.exe" : "docker",
      [
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--memory=512m",
        "--cpus=1",
        "--pids-limit=64",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=32m",
        "--mount",
        `type=bind,source=${repo},target=/work,readonly`,
        "--workdir=/work",
        M15_VALIDATOR_IMAGE,
      ],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: {
          NODE_ENV: "production",
          PATH: process.env.PATH ?? "",
          SYSTEMROOT: process.env.SYSTEMROOT ?? "",
        },
      },
    );
    const output = boundedOutput(`${result.stdout}${result.stderr}`);
    if (result.error?.name === "TimeoutError" || result.error?.message.includes("ETIMEDOUT")) {
      return {
        state: "VALIDATION_FAILED" as const,
        category: "validation_timeout",
        commands: ["node --test test/*.mjs", "tsc --noEmit -p tsconfig.json"],
        output,
        durationMs: Date.now() - startedAt,
      };
    }
    if (result.error || result.status !== 0) {
      return {
        state: "VALIDATION_FAILED" as const,
        category: "validation_command_failed",
        commands: ["node --test test/*.mjs", "tsc --noEmit -p tsconfig.json"],
        output,
        durationMs: Date.now() - startedAt,
      };
    }
    return {
      state: "VALIDATED" as const,
      commands: ["node --test test/*.mjs", "tsc --noEmit -p tsconfig.json"],
      output,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!inside(scratchRoot, scratch)) throw new Error("validation_scratch_path_invalid");
    await rm(scratch, { recursive: true, force: true });
  }
}
