import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  assertSafeVerificationCommand,
  type RunnerVerificationCommand,
  VERIFICATION_RUNNER_IMAGE,
} from "./contracts.ts";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

function dockerMountSource(value: string) {
  const absolute = path.resolve(value);
  return process.platform === "win32" ? absolute.replaceAll("\\", "/") : absolute;
}

async function inspectSource(root: string, current = root): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(current, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error("verification_snapshot_symlink_forbidden");
    if (info.isDirectory()) bytes += await inspectSource(root, full);
    else if (info.isFile()) bytes += info.size;
    else throw new Error("verification_snapshot_special_file_forbidden");
    if (bytes > MAX_SOURCE_BYTES) throw new Error("verification_snapshot_size_limit");
  }
  return bytes;
}

const COPY_AND_RUN_PREFIX = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const { spawnSync } = require('node:child_process');",
  "fs.cpSync('/source', '/workspace', { recursive: true, filter: (source) => !['.git', 'node_modules'].includes(path.basename(source).toLowerCase()) });",
  "",
].join("\n");

function copyAndRunScript(command: RunnerVerificationCommand, timeoutMs: number) {
  const commandLiteral = JSON.stringify(JSON.stringify(command));
  return [
    COPY_AND_RUN_PREFIX,
    `const command = JSON.parse(${commandLiteral});`,
    `const result = spawnSync(process.execPath, command.args, { cwd: '/workspace', encoding: 'utf8', timeout: ${timeoutMs}, maxBuffer: ${MAX_OUTPUT_BYTES}, env: { NODE_ENV: 'production', PATH: process.env.PATH ?? '' } });`,
    "if (result.stdout) process.stdout.write(result.stdout);",
    "if (result.stderr) process.stderr.write(result.stderr);",
    "if (result.error) { process.stderr.write('verification_command_failed'); process.exit(1); }",
    "process.exit(Number.isInteger(result.status) ? result.status : 1);",
  ].join("\n");
}

async function runOne(input: {
  checkoutPath: string;
  nodeModulesPath: string;
  command: RunnerVerificationCommand;
  timeoutMs: number;
}) {
  assertSafeVerificationCommand(input.command);
  const timeoutMs = Math.min(Math.max(input.timeoutMs, 1_000), MAX_COMMAND_TIMEOUT_MS);
  const started = Date.now();
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
        "--mount",
        `type=bind,source=${dockerMountSource(input.checkoutPath)},target=/source,readonly`,
        "--mount",
        `type=bind,source=${dockerMountSource(input.nodeModulesPath)},target=/workspace/node_modules,readonly`,
        "--workdir",
        "/workspace",
        "--entrypoint",
        "node",
        VERIFICATION_RUNNER_IMAGE,
        "-e",
        copyAndRunScript(input.command, timeoutMs),
      ],
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: {
          PATH: process.env.PATH ?? "",
          ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "" } : {}),
          NODE_ENV: "production",
        },
      },
    );
    const outputBytes = Buffer.byteLength(`${result.stdout}${result.stderr}`);
    return {
      commandClass: input.command.commandClass,
      status: "passed" as const,
      durationMs: Math.min(Date.now() - started, timeoutMs),
      outputBytes,
      diagnosticCategory: null,
    };
  } catch (error) {
    const fields =
      typeof error === "object" && error !== null
        ? (error as { code?: unknown; killed?: unknown; signal?: unknown })
        : {};
    const code = typeof fields.code === "string" ? fields.code : "";
    const timeout = Boolean(fields.killed) || /timeout|ETIMEDOUT/i.test(code);
    const outputExceeded = code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    return {
      commandClass: input.command.commandClass,
      status: "failed" as const,
      durationMs: Math.min(Date.now() - started, timeoutMs),
      outputBytes: 0,
      diagnosticCategory: timeout
        ? ("verification_timeout" as const)
        : outputExceeded
          ? ("verification_output_exceeded" as const)
          : ("verification_command_failed" as const),
    };
  }
}

/** Runs fixed-profile commands with no inherited provider credentials and no container network. */
export async function runDockerVerificationChecks(input: {
  checkoutPath: string;
  nodeModulesPath: string;
  commands: RunnerVerificationCommand[];
  timeoutMs?: number;
}) {
  await inspectSource(input.checkoutPath);
  const started = Date.now();
  const checks = [];
  for (const command of input.commands) {
    const result = await runOne({
      ...input,
      command,
      timeoutMs: input.timeoutMs ?? MAX_COMMAND_TIMEOUT_MS,
    });
    checks.push(result);
    if (result.status !== "passed") break;
  }
  return { checks, durationMs: Date.now() - started };
}
