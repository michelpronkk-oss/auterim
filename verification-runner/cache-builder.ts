import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import os from "node:os";
import {
  createDependencyCacheIdentity,
  dependencyCacheIdentityKey,
  FIX_VERIFICATION_RUNTIME_PROFILE,
} from "../src/lib/fix-engine/cache-identity.ts";
import { npmLockRequiresInstallScripts } from "../src/lib/fix-engine/verification-profile.ts";
import {
  canonicalJson,
  MAX_ARCHIVE_EXPANDED_BYTES,
  MAX_ARCHIVE_FILES,
  MAX_CACHE_ARCHIVE_BYTES,
  sha256,
  VERIFICATION_RUNNER_IMAGE,
  type DependencyCacheManifestV2,
} from "./contracts.ts";

const execFileAsync = promisify(execFile);
const MAX_BUILD_MS = 10 * 60_000;
const MAX_BUILD_OUTPUT = 64 * 1024;

function cacheFailure(code: string): never {
  throw new Error(/^[a-z0-9_]{1,100}$/.test(code) ? code : "dependency_cache_build_failed");
}

function safeDockerFailure(error: unknown) {
  const details =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; stderr?: unknown; message?: unknown })
      : {};
  const text =
    `${typeof details.stderr === "string" ? details.stderr : ""} ${typeof details.message === "string" ? details.message : ""}`.toLowerCase();
  if (/no such container|container .* not found/.test(text)) return "container_unavailable";
  if (/permission denied|operation not permitted/.test(text)) return "permission_denied";
  if (/read-only file system/.test(text)) return "read_only_filesystem";
  if (/no such file or directory/.test(text)) return "path_unavailable";
  if (typeof details.code === "string" && /^[a-z0-9_]{1,40}$/i.test(details.code))
    return details.code.toLowerCase();
  return "command_failed";
}

async function streamContainerArtifact(input: {
  container: string;
  name: "tree.json" | "dependencies.tar.gz";
  destination: string;
  maxBytes: number;
}) {
  const sourcePath = `/workspace/cache-output/${input.name}`;
  const script = `const fs=require("node:fs");const s=fs.createReadStream(${JSON.stringify(sourcePath)});s.on("error",()=>process.exitCode=1);s.pipe(process.stdout)`;
  const child = spawn("docker", ["exec", input.container, "node", "-e", script], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "" } : {}),
      NODE_ENV: "production",
    },
  });
  let byteCount = 0;
  let timedOut = false;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteCount += chunk.byteLength;
      if (byteCount > input.maxBytes) callback(new Error("artifact_size_limit"));
      else callback(null, chunk);
    },
  });
  child.stderr.on("data", () => undefined);
  const processExit = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error("artifact_stream_unavailable")));
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error("artifact_stream_failed")),
    );
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 60_000);
  const outputPipeline = pipeline(
    child.stdout,
    limiter,
    createWriteStream(input.destination, { flags: "wx", mode: 0o600 }),
  );
  try {
    await Promise.all([outputPipeline, processExit]);
    if (!byteCount) throw new Error("artifact_stream_empty");
  } catch (error) {
    child.kill();
    await outputPipeline.catch(() => undefined);
    await rm(input.destination, { force: true }).catch(() => undefined);
    if (timedOut) cacheFailure("dependency_cache_artifact_stream_timeout");
    if (error instanceof Error && error.message === "artifact_size_limit")
      cacheFailure("dependency_cache_artifact_stream_size_limit");
    cacheFailure("dependency_cache_artifact_stream_failed");
  } finally {
    clearTimeout(timeout);
  }
}

function validateNpmLock(lockText: string) {
  let lock: { lockfileVersion?: unknown; packages?: Record<string, unknown> };
  try {
    lock = JSON.parse(lockText) as typeof lock;
  } catch {
    cacheFailure("dependency_cache_lock_invalid");
  }
  if (
    ![2, 3].includes(Number(lock.lockfileVersion)) ||
    !lock.packages ||
    Object.keys(lock.packages).length > MAX_ARCHIVE_FILES
  )
    cacheFailure("dependency_cache_lock_unsupported");
  for (const [name, raw] of Object.entries(lock.packages)) {
    if (!raw || typeof raw !== "object") cacheFailure("dependency_cache_lock_invalid");
    const packageEntry = raw as {
      resolved?: unknown;
      integrity?: unknown;
      link?: unknown;
    };
    if (packageEntry.link === true) cacheFailure("dependency_cache_symlink_layout_unsupported");
    if (!name) continue;
    if (typeof packageEntry.resolved !== "string")
      cacheFailure("dependency_cache_source_unsupported");
    let resolved: URL;
    try {
      resolved = new URL(packageEntry.resolved);
    } catch {
      cacheFailure("dependency_cache_source_unsupported");
    }
    if (
      resolved.protocol !== "https:" ||
      resolved.hostname !== "registry.npmjs.org" ||
      (resolved.port && resolved.port !== "443") ||
      resolved.username ||
      resolved.password
    )
      cacheFailure("dependency_cache_source_unsupported");
    if (
      typeof packageEntry.integrity !== "string" ||
      !/^sha(?:1|256|384|512)-[A-Za-z0-9+/=]+(?:\s+sha(?:1|256|384|512)-[A-Za-z0-9+/=]+)*$/.test(
        packageEntry.integrity,
      )
    )
      cacheFailure("dependency_cache_integrity_missing");
  }
  if (npmLockRequiresInstallScripts(lockText)) cacheFailure("dependency_install_scripts_required");
}

async function assertCleanExactCommit(source: string, commitSha: string) {
  const git = async (args: string[]) =>
    execFileAsync("git", ["-C", source, ...args], {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 4096,
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "" } : {}),
        NODE_ENV: "production",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      },
    });
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim().toLowerCase();
  const status = (await git(["status", "--porcelain"])).stdout.trim();
  if (head !== commitSha.toLowerCase() || status)
    cacheFailure("dependency_cache_source_commit_mismatch");
}

/**
 * Build a signed immutable npm cache from a clean exact commit. npm lifecycle
 * scripts are disabled and the build container receives only package files.
 */
export async function buildSignedNpmDependencyCache(input: {
  sourceRepositoryPath: string;
  identity: {
    repositoryId: string;
    repositoryIdentity: string;
    commitSha: string;
  };
  signingPrivateKey: string | Buffer;
  outputDirectory?: string;
}) {
  await assertCleanExactCommit(input.sourceRepositoryPath, input.identity.commitSha);
  const packageJsonText = await readFile(
    path.join(input.sourceRepositoryPath, "package.json"),
    "utf8",
  ).catch(() => cacheFailure("dependency_cache_package_manifest_missing"));
  const packageJson = JSON.parse(packageJsonText) as {
    packageManager?: string;
    workspaces?: unknown;
  };
  if (packageJson.workspaces) cacheFailure("dependency_cache_monorepo_unsupported");
  if (packageJson.packageManager && !/^npm@[^\s]+$/.test(packageJson.packageManager))
    cacheFailure("dependency_cache_package_manager_unsupported");
  const lockNames = ["package-lock.json", "npm-shrinkwrap.json"].filter((name) =>
    existsSync(path.join(input.sourceRepositoryPath, name)),
  );
  if (lockNames.length !== 1 || existsSync(path.join(input.sourceRepositoryPath, ".npmrc")))
    cacheFailure("dependency_cache_lockfile_unsupported");
  const lockName = lockNames[0]!;
  const lockText = await readFile(path.join(input.sourceRepositoryPath, lockName), "utf8");
  validateNpmLock(lockText);
  const identity = createDependencyCacheIdentity({
    ...input.identity,
    packageJson: packageJsonText,
    lockfiles: { [lockName]: lockText },
  });
  if (!identity || identity.packageManager !== "npm")
    cacheFailure("dependency_cache_identity_invalid");
  const npmIdentity = { ...identity, packageManager: "npm" as const };
  const work = await mkdtemp(path.join(os.tmpdir(), "auterim-cache-build-"));
  const mount = path.resolve(work);
  const builderContainer = `auterim-cache-build-${randomUUID().slice(0, 12)}`;
  const outputDirectory = input.outputDirectory
    ? path.resolve(input.outputDirectory)
    : await mkdtemp(path.join(os.tmpdir(), "auterim-cache-artifact-"));
  const runnerSource = path.resolve("verification-runner");
  await mkdir(outputDirectory, { recursive: true });
  try {
    await writeFile(path.join(mount, "package.json"), packageJsonText, { flag: "wx", mode: 0o400 });
    await writeFile(path.join(mount, lockName), lockText, { flag: "wx", mode: 0o400 });
    await execFileAsync(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        builderContainer,
        "--network=bridge",
        "--pull=never",
        "--memory=3g",
        "--cpus=2",
        "--pids-limit=128",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--read-only",
        "--user",
        "1000:1000",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=512m,uid=1000,gid=1000,mode=0700",
        "--tmpfs",
        "/workspace:rw,noexec,nosuid,size=1100m,uid=1000,gid=1000,mode=0700",
        "--volume",
        `${mount}:/inputs:ro`,
        "--volume",
        `${runnerSource}:/opt/cache:ro`,
        "--workdir",
        "/workspace",
        "--entrypoint",
        "node",
        VERIFICATION_RUNNER_IMAGE,
        "-e",
        "setInterval(() => {}, 2147483647)",
      ],
      {
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 4096,
        env: {
          PATH: process.env.PATH ?? "",
          ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "" } : {}),
          NODE_ENV: "production",
        },
      },
    ).catch(() => cacheFailure("dependency_cache_builder_unavailable"));
    const copyInputs = `const fs=require("node:fs");for(const name of ["package.json",${JSON.stringify(lockName)}]){fs.copyFileSync("/inputs/"+name,"/workspace/"+name);fs.chmodSync("/workspace/"+name,0o400)}`;
    await execFileAsync(
      "docker",
      ["exec", "--workdir", "/workspace", builderContainer, "node", "-e", copyInputs],
      {
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 4096,
        env: {
          PATH: process.env.PATH ?? "",
          ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "" } : {}),
          NODE_ENV: "production",
        },
      },
    ).catch((error: unknown) => cacheFailure(`dependency_cache_input_${safeDockerFailure(error)}`));
    await execFileAsync(
      "docker",
      [
        "exec",
        "--workdir",
        "/workspace",
        "--env",
        "HOME=/tmp",
        "--env",
        "npm_config_cache=/tmp/npm-cache",
        "--env",
        "npm_config_ignore_scripts=true",
        "--env",
        "npm_config_userconfig=/dev/null",
        "--env",
        "npm_config_audit=false",
        "--env",
        "npm_config_fund=false",
        builderContainer,
        "npm",
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org",
        "--include=dev",
      ],
      {
        windowsHide: true,
        timeout: MAX_BUILD_MS,
        maxBuffer: MAX_BUILD_OUTPUT,
        env: {
          PATH: process.env.PATH ?? "",
          ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "" } : {}),
          NODE_ENV: "production",
        },
      },
    ).catch(() => cacheFailure("dependency_cache_install_failed"));
    await execFileAsync("docker", ["network", "disconnect", "bridge", builderContainer], {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 4096,
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "" } : {}),
        NODE_ENV: "production",
      },
    }).catch(() => cacheFailure("dependency_cache_network_isolation_failed"));
    await execFileAsync(
      "docker",
      [
        "exec",
        "--workdir",
        "/workspace",
        builderContainer,
        "node",
        "--experimental-strip-types",
        "/opt/cache/cache-finalizer.ts",
        "/workspace/node_modules",
        "/workspace/cache-output",
      ],
      {
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: MAX_BUILD_OUTPUT,
        env: {
          PATH: process.env.PATH ?? "",
          ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "" } : {}),
          NODE_ENV: "production",
        },
      },
    ).catch(() => cacheFailure("dependency_cache_finalize_failed"));
    const networkState = await execFileAsync(
      "docker",
      ["inspect", "--format", "{{json .NetworkSettings.Networks}}", builderContainer],
      { windowsHide: true, timeout: 15_000, maxBuffer: 4096 },
    ).catch(() => cacheFailure("dependency_cache_network_state_unavailable"));
    let remainingNetworks: unknown;
    try {
      remainingNetworks = JSON.parse(networkState.stdout.trim()) as unknown;
    } catch {
      cacheFailure("dependency_cache_network_state_invalid");
    }
    if (
      !remainingNetworks ||
      typeof remainingNetworks !== "object" ||
      Array.isArray(remainingNetworks) ||
      Object.keys(remainingNetworks).length !== 0
    )
      cacheFailure("dependency_cache_finalizer_network_enabled");
    const cacheOutput = path.join(work, "cache-output");
    await mkdir(cacheOutput, { recursive: true });
    await streamContainerArtifact({
      container: builderContainer,
      name: "tree.json",
      destination: path.join(cacheOutput, "tree.json"),
      maxBytes: 4096,
    });
    await streamContainerArtifact({
      container: builderContainer,
      name: "dependencies.tar.gz",
      destination: path.join(cacheOutput, "dependencies.tar.gz"),
      maxBytes: MAX_CACHE_ARCHIVE_BYTES,
    });
    const finalized = JSON.parse(await readFile(path.join(cacheOutput, "tree.json"), "utf8")) as {
      treeSha256: string;
      fileCount: number;
      byteCount: number;
      archiveSha256: string;
      archiveByteCount: number;
    };
    const archive = await readFile(path.join(cacheOutput, "dependencies.tar.gz"));
    if (
      archive.byteLength > MAX_CACHE_ARCHIVE_BYTES ||
      archive.byteLength !== finalized.archiveByteCount ||
      sha256(archive) !== finalized.archiveSha256
    )
      cacheFailure("dependency_cache_archive_invalid");
    const manifestPayload = {
      schemaVersion: 2 as const,
      buildStatus: "complete" as const,
      identity: npmIdentity,
      identityKey: dependencyCacheIdentityKey(npmIdentity),
      treeSha256: finalized.treeSha256,
      archiveSha256: finalized.archiveSha256,
      artifactFingerprint: finalized.archiveSha256,
      signatureAlgorithm: "ed25519" as const,
      createdAt: new Date().toISOString(),
      fileCount: finalized.fileCount,
      byteCount: finalized.byteCount,
      archiveByteCount: archive.byteLength,
    };
    const manifest: DependencyCacheManifestV2 = {
      ...manifestPayload,
      manifestFingerprint: sha256(canonicalJson(manifestPayload)),
    };
    await writeFile(path.join(outputDirectory, "dependencies.tar.gz"), archive, {
      flag: "wx",
      mode: 0o400,
    });
    const manifestText = canonicalJson(manifest);
    const privateKey = createPrivateKey(input.signingPrivateKey);
    if (privateKey.asymmetricKeyType !== "ed25519")
      cacheFailure("dependency_cache_signing_key_invalid");
    const signature = sign(null, Buffer.from(manifestText, "utf8"), privateKey);
    await writeFile(path.join(outputDirectory, "manifest.json"), manifestText, {
      flag: "wx",
      mode: 0o400,
    });
    await writeFile(path.join(outputDirectory, "manifest.sig"), signature.toString("base64"), {
      flag: "wx",
      mode: 0o400,
    });
    return { identity: npmIdentity, manifest, signature, archive, outputDirectory };
  } finally {
    await execFileAsync("docker", ["rm", "--force", builderContainer], {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 4096,
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "" } : {}),
        NODE_ENV: "production",
      },
    }).catch(() => undefined);
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const FIX_DEPENDENCY_CACHE_BUILD_LIMITS = {
  maxBuildMs: MAX_BUILD_MS,
  maxFiles: MAX_ARCHIVE_FILES,
  maxExpandedBytes: MAX_ARCHIVE_EXPANDED_BYTES,
  maxArchiveBytes: MAX_CACHE_ARCHIVE_BYTES,
  network: "trusted-cache-builder-only" as const,
  lifecycleScripts: "disabled" as const,
  packageManagers: ["npm"] as const,
  runtimeProfile: FIX_VERIFICATION_RUNTIME_PROFILE,
};
