import { createHmac, randomUUID, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash as makeHash } from "node:crypto";
import { extractSafeTarGzip, isSensitiveArtifactPath } from "./archive.ts";
import { runDockerVerificationChecks } from "./docker-executor.ts";
import {
  assertSafeVerificationCommand,
  DependencyCacheManifestSchema,
  MAX_ARCHIVE_EXPANDED_BYTES,
  MAX_ARCHIVE_FILES,
  MAX_CACHE_ARCHIVE_BYTES,
  MAX_PATCH_BYTES,
  MAX_SNAPSHOT_BYTES,
  VERIFICATION_RUNNER_PROTOCOL_VERSION,
  VERIFICATION_RUNNER_IMAGE,
  VerificationJobRequestSchema,
  VerificationJobResultSchema,
  canonicalJson,
  dependencyCacheManifestFingerprint,
  sha256,
  verificationJobIdentityFingerprint,
  verificationRequestFingerprint,
  verificationResultSignatureInput,
  type VerificationJobRequest,
  type VerificationJobResult,
} from "./contracts.ts";

const execFileAsync = promisify(execFile);
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_NONCES = 20_000;
const MAX_CONCURRENCY = 2;
const MAX_QUEUED_JOBS = 100;
const MAX_JOB_RECORDS = 50_000;
const MAX_JOB_RECORD_BYTES = 64 * 1024;
const MAX_JOB_DURATION_MS = 15 * 60_000;

type SafeFailure = { status: "failed"; category: string };
type JobStatus =
  | { status: "queued"; requestFingerprint: string }
  | { status: "running"; requestFingerprint: string }
  | { status: "completed"; requestFingerprint: string; result: VerificationJobResult }
  | { status: "failed"; requestFingerprint: string; failure: SafeFailure };

export type VerificationRunnerConfig = {
  authSecret: string;
  artifactOrigin: string;
  cachePublicKey: string;
  jobStorePath: string;
  workRoot?: string;
  maxConcurrency?: number;
  /** Test seam; production keeps bounded defaults and requires one runner replica. */
  maxQueuedJobs?: number;
  /** Test seam; completed records are retained for replay safety. */
  maxJobRecords?: number;
  /** Test seam; production uses the same Docker executor below. */
  execute?: (request: VerificationJobRequest) => Promise<VerificationJobResult>;
};

function publicError(response: ServerResponse, status: number, error: string) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ error }));
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function signedResult(response: ServerResponse, body: VerificationJobResult, secret: string) {
  const serialized = canonicalJson(body);
  const signature = createHmac("sha256", secret)
    .update(verificationResultSignatureInput(body.jobId, sha256(serialized)), "utf8")
    .digest("hex");
  response.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-auterim-result-signature": signature,
  });
  response.end(serialized);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_REQUEST_BYTES) throw new Error("runner_request_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function signatureInput(
  method: string,
  pathAndQuery: string,
  issuedAt: string,
  nonce: string,
  body: Buffer,
) {
  return `${method}\n${pathAndQuery}\n${issuedAt}\n${nonce}\n${sha256(body)}`;
}

function authenticate(
  request: IncomingMessage,
  pathAndQuery: string,
  body: Buffer,
  secret: string,
  seenNonces: Map<string, number>,
) {
  const issuedAt = request.headers["x-auterim-issued-at"];
  const nonce = request.headers["x-auterim-nonce"];
  const signature = request.headers["x-auterim-signature"];
  if (
    typeof issuedAt !== "string" ||
    typeof nonce !== "string" ||
    typeof signature !== "string" ||
    !/^\d{13}$/.test(issuedAt) ||
    !/^[a-f0-9]{32,64}$/.test(nonce) ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return false;
  const timestamp = Number(issuedAt);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > MAX_CLOCK_SKEW_MS)
    return false;
  for (const [key, expiry] of seenNonces) if (expiry < Date.now()) seenNonces.delete(key);
  if (seenNonces.has(nonce) || seenNonces.size >= MAX_NONCES) return false;
  const expected = createHmac("sha256", secret)
    .update(signatureInput(request.method ?? "", pathAndQuery, issuedAt, nonce, body), "utf8")
    .digest();
  const provided = Buffer.from(signature, "hex");
  if (provided.byteLength !== expected.byteLength || !timingSafeEqual(provided, expected))
    return false;
  seenNonces.set(nonce, Date.now() + MAX_CLOCK_SKEW_MS * 2);
  return true;
}

function validateArtifactUrl(
  urlText: string,
  role: "snapshot" | "patch" | "cache",
  origin: string,
  request: VerificationJobRequest,
) {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error("verification_artifact_url_invalid");
  }
  const expectedOrigin = new URL(origin);
  if (
    url.origin !== expectedOrigin.origin ||
    url.username ||
    url.password ||
    url.hash ||
    (expectedOrigin.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(expectedOrigin.hostname))
  )
    throw new Error("verification_artifact_origin_invalid");
  const pathname = decodeURIComponent(url.pathname);
  const valid =
    role === "snapshot"
      ? pathname ===
        `/storage/v1/object/sign/fix-engine-verification-artifacts/snapshots/${request.identity.fixRunId}/${request.snapshot.sha256}.tar.gz`
      : role === "patch"
        ? pathname ===
          `/storage/v1/object/sign/fix-engine-artifacts/${request.identity.patchArtifactPath}`
        : pathname ===
          `/storage/v1/object/sign/fix-engine-verification-artifacts/caches/${request.identity.repositoryId}/${request.identity.baseCommitSha}/${request.identity.cacheIdentityKey}/dependencies.tar.gz`;
  if (!valid) throw new Error(`verification_${role}_artifact_path_invalid`);
  return url;
}

async function downloadArtifact(input: {
  url: string;
  expectedSha256: string;
  expectedBytes: number;
  maxBytes: number;
  origin: string;
  role: "snapshot" | "patch" | "cache";
  request: VerificationJobRequest;
  destination: string;
}) {
  validateArtifactUrl(input.url, input.role, input.origin, input.request);
  if (input.expectedBytes > input.maxBytes) throw new Error("verification_artifact_size_limit");
  const response = await fetch(input.url, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body) throw new Error("verification_artifact_unavailable");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > input.maxBytes)
    throw new Error("verification_artifact_size_limit");
  const hasher = makeHash("sha256");
  let total = 0;
  const file = await import("node:fs/promises").then(({ open }) =>
    open(input.destination, "wx", 0o600),
  );
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.byteLength;
      if (total > input.maxBytes) throw new Error("verification_artifact_size_limit");
      hasher.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten < 1) throw new Error("verification_artifact_read_failed");
        offset += bytesWritten;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    await file.close();
  }
  if (total !== input.expectedBytes || hasher.digest("hex") !== input.expectedSha256)
    throw new Error("verification_artifact_fingerprint_mismatch");
  return total;
}

async function makeWritable(root: string, current = root): Promise<void> {
  await chmod(current, 0o700);
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error("verification_snapshot_symlink_forbidden");
    if (info.isDirectory()) await makeWritable(root, target);
    else if (info.isFile()) await chmod(target, 0o600);
    else throw new Error("verification_snapshot_special_file_forbidden");
  }
}

async function makeReadOnly(root: string, current = root): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error("verification_cache_symlink_forbidden");
    if (info.isDirectory()) await makeReadOnly(root, target);
    else if (info.isFile()) await chmod(target, info.mode & 0o111 ? 0o555 : 0o444);
    else throw new Error("verification_cache_special_file_forbidden");
  }
  await chmod(current, 0o555);
}

async function inspectDependencyTree(
  root: string,
  expectedFiles: Array<{ path: string; mode: number; sha256: string; bytes: number }>,
) {
  const actualFiles = new Map<string, { sha256: string; bytes: number }>();
  let byteCount = 0;
  const visit = async (current: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = path.join(current, entry.name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink() || stat.mode & 0o222)
        throw new Error("verification_cache_tree_invalid");
      if (stat.isDirectory()) await visit(full);
      else if (stat.isFile()) {
        const relative = path.relative(root, full).replaceAll("\\", "/");
        byteCount += stat.size;
        actualFiles.set(relative, { sha256: sha256(await readFile(full)), bytes: stat.size });
      } else throw new Error("verification_cache_tree_invalid");
      if (actualFiles.size > MAX_ARCHIVE_FILES || byteCount > MAX_ARCHIVE_EXPANDED_BYTES)
        throw new Error("verification_cache_tree_invalid");
    }
  };
  await visit(root);
  if (actualFiles.size !== expectedFiles.length) throw new Error("verification_cache_tree_invalid");
  const files = expectedFiles.map((expected) => {
    const actual = actualFiles.get(expected.path);
    if (!actual || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
      throw new Error("verification_cache_tree_invalid");
    return { ...expected, ...actual };
  });
  return { files, byteCount, treeSha256: sha256(canonicalJson(files)) };
}

function verifyCacheManifest(request: VerificationJobRequest, publicKey: string) {
  const manifest = DependencyCacheManifestSchema.parse(request.cacheManifest);
  if (
    manifest.buildStatus !== "complete" ||
    manifest.signatureAlgorithm !== "ed25519" ||
    manifest.manifestFingerprint !== dependencyCacheManifestFingerprint(manifest) ||
    manifest.artifactFingerprint !== manifest.archiveSha256 ||
    sha256(JSON.stringify(manifest.identity)) !== manifest.identityKey ||
    manifest.identityKey !== request.identity.cacheIdentityKey ||
    manifest.treeSha256 !== request.identity.cacheTreeSha256 ||
    manifest.identity.repositoryId !== request.identity.repositoryId ||
    manifest.identity.repositoryIdentity.toLowerCase() !==
      request.identity.repositoryIdentity.toLowerCase() ||
    manifest.identity.commitSha.toLowerCase() !== request.identity.baseCommitSha.toLowerCase() ||
    manifest.identity.packageManager !== request.identity.packageManager ||
    manifest.identity.packageManifestSha256 !== request.identity.packageManifestSha256 ||
    manifest.identity.lockfileSha256 !== request.identity.lockfileSha256 ||
    manifest.identity.runtimeProfile !== request.identity.runtimeProfile
  )
    throw new Error("verification_cache_identity_mismatch");
  let signature: Buffer;
  try {
    signature = Buffer.from(request.cacheSignature, "base64");
  } catch {
    throw new Error("verification_cache_signature_invalid");
  }
  if (!verifySignature(null, Buffer.from(canonicalJson(manifest)), publicKey, signature))
    throw new Error("verification_cache_signature_invalid");
}

async function createBaseCommit(root: string) {
  const env = {
    PATH: process.env.PATH ?? "",
    ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "" } : {}),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    NODE_ENV: "production" as const,
  };
  const git = async (args: string[]) =>
    execFileAsync("git", ["-C", root, ...args], {
      windowsHide: true,
      timeout: 15_000,
      env,
    });
  await git(["init", "--quiet"]);
  await git(["add", "--all"]);
  await git([
    "-c",
    "user.name=Auterim Verification Snapshot",
    "-c",
    "user.email=verification@auterim.invalid",
    "-c",
    `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "Immutable verification snapshot",
  ]);
}

export async function assertNoSnapshotSecrets(root: string, current = root): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error("verification_snapshot_symlink_forbidden");
    if (info.isDirectory()) {
      await assertNoSnapshotSecrets(root, target);
      continue;
    }
    if (!info.isFile()) throw new Error("verification_snapshot_special_file_forbidden");
    // The extracted snapshot has a strict aggregate byte limit, so scanning the
    // full file is bounded and prevents credentials after an arbitrary prefix.
    const content = await readFile(target);
    const text = content.toString("utf8");
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16})\b|\bsk-(?:proj|live|test|ant)-[A-Za-z0-9_-]{24,}/.test(
        text,
      )
    )
      throw new Error("verification_snapshot_secret_detected");
  }
}

function assertPatchPaths(diff: string, allowedPaths: string[]) {
  if (Buffer.byteLength(diff) > MAX_PATCH_BYTES || /^GIT binary patch|^Binary files /m.test(diff))
    throw new Error("verification_patch_unsafe");
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16})\b|\bsk-(?:proj|live|test|ant)-[A-Za-z0-9_-]{24,}/.test(
      diff,
    )
  )
    throw new Error("verification_patch_secret_detected");
  if (/^(?:old mode|new mode|new file mode|deleted file mode|rename from|rename to) /m.test(diff))
    throw new Error("verification_patch_unsafe");
  const paths = [...diff.matchAll(/^diff --git a\/([^\r\n]+) b\/([^\r\n]+)$/gm)].map((match) => {
    if (match[1] !== match[2]) throw new Error("verification_patch_unsafe");
    const value = match[1] ?? "";
    if (
      !value ||
      value.startsWith("/") ||
      value.includes("\\") ||
      value.split("/").includes("..") ||
      isSensitiveArtifactPath(value)
    )
      throw new Error("verification_patch_unsafe");
    return value;
  });
  if (
    !paths.length ||
    new Set(paths).size !== paths.length ||
    paths.some((file) => !allowedPaths.includes(file))
  )
    throw new Error("verification_patch_outside_plan");
  return paths;
}

async function applyPatch(root: string, patchPath: string) {
  const git = async (args: string[]) =>
    execFileAsync("git", ["-C", root, ...args], {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: MAX_PATCH_BYTES,
    });
  await git(["apply", "--check", "--whitespace=error", patchPath]).catch(() => {
    throw new Error("verification_patch_conflict");
  });
  await git(["apply", "--whitespace=error", patchPath]).catch(() => {
    throw new Error("verification_patch_conflict");
  });
}

export async function executeVerificationJob(
  request: VerificationJobRequest,
  config: {
    artifactOrigin: string;
    cachePublicKey: string;
    workRoot?: string;
  },
) {
  const workRoot = path.resolve(config.workRoot ?? tmpdir());
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  await chmod(workRoot, 0o700);
  const root = await mkdtemp(path.join(workRoot, "auterim-verification-job-"));
  const snapshotArchive = path.join(root, "snapshot.tar.gz");
  const patchPath = path.join(root, "patch.diff");
  const cacheArchive = path.join(root, "cache.tar.gz");
  const snapshotPath = path.join(root, "snapshot");
  const cachePath = path.join(root, "cache", "node_modules");
  try {
    verifyCacheManifest(request, config.cachePublicKey);
    await Promise.all([
      downloadArtifact({
        url: request.snapshot.url,
        expectedSha256: request.snapshot.sha256,
        expectedBytes: request.snapshot.byteCount,
        maxBytes: MAX_SNAPSHOT_BYTES,
        origin: config.artifactOrigin,
        role: "snapshot",
        request,
        destination: snapshotArchive,
      }),
      downloadArtifact({
        url: request.patch.url,
        expectedSha256: request.patch.sha256,
        expectedBytes: request.patch.byteCount,
        maxBytes: MAX_PATCH_BYTES,
        origin: config.artifactOrigin,
        role: "patch",
        request,
        destination: patchPath,
      }),
      downloadArtifact({
        url: request.cacheArchive.url,
        expectedSha256: request.cacheArchive.sha256,
        expectedBytes: request.cacheArchive.byteCount,
        maxBytes: MAX_CACHE_ARCHIVE_BYTES,
        origin: config.artifactOrigin,
        role: "cache",
        request,
        destination: cacheArchive,
      }),
    ]);
    await mkdir(snapshotPath, { recursive: true, mode: 0o700 });
    const snapshot = await extractSafeTarGzip(snapshotArchive, snapshotPath, {
      maxFiles: MAX_ARCHIVE_FILES,
      maxBytes: MAX_SNAPSHOT_BYTES,
      forbidSensitiveFiles: true,
    });
    if (!snapshot.fileCount) throw new Error("verification_snapshot_empty");
    await makeWritable(snapshotPath);
    await assertNoSnapshotSecrets(snapshotPath);
    await createBaseCommit(snapshotPath);
    const diff = await readFile(patchPath, "utf8");
    assertPatchPaths(diff, request.identity.allowedPaths);
    await applyPatch(snapshotPath, patchPath);
    const cacheTree = await extractSafeTarGzip(cacheArchive, cachePath, {
      maxFiles: MAX_ARCHIVE_FILES,
      maxBytes: MAX_ARCHIVE_EXPANDED_BYTES,
    });
    await makeReadOnly(cachePath);
    const tree = await inspectDependencyTree(cachePath, cacheTree.treeFiles);
    if (tree.treeSha256 !== request.cacheManifest.treeSha256)
      throw new Error("verification_cache_tree_fingerprint_mismatch");
    if (tree.files.length !== request.cacheManifest.fileCount)
      throw new Error("verification_cache_tree_file_count_mismatch");
    if (tree.byteCount !== request.cacheManifest.byteCount)
      throw new Error("verification_cache_tree_byte_count_mismatch");
    const results = await runDockerVerificationChecks({
      checkoutPath: snapshotPath,
      nodeModulesPath: cachePath,
      commands: request.commands,
    });
    const resultBase = {
      protocolVersion: VERIFICATION_RUNNER_PROTOCOL_VERSION,
      runnerVersion: "m1578-runner-v1" as const,
      runtimeImage: VERIFICATION_RUNNER_IMAGE,
      profileId: request.identity.profileId,
      profileVersion: request.identity.profileVersion,
      jobId: request.jobId,
      requestFingerprint: request.requestFingerprint,
      workspaceId: request.identity.workspaceId,
      productId: request.identity.productId,
      repositoryId: request.identity.repositoryId,
      repositoryIdentity: request.identity.repositoryIdentity,
      baseCommitSha: request.identity.baseCommitSha,
      patchId: request.identity.patchId,
      status: results.checks.every((check) => check.status === "passed")
        ? ("passed" as const)
        : ("failed" as const),
      checks: results.checks,
      durationMs: Math.min(results.durationMs, MAX_JOB_DURATION_MS),
      snapshotFingerprint: request.identity.snapshotFingerprint,
      patchFingerprint: request.identity.patchFingerprint,
      cacheIdentityKey: request.identity.cacheIdentityKey,
      cacheTreeSha256: tree.treeSha256,
      outputFingerprint: sha256(canonicalJson(results.checks)),
    };
    return VerificationJobResultSchema.parse({
      ...resultBase,
      resultFingerprint: sha256(canonicalJson(resultBase)),
    });
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {
      throw new Error("verification_runner_cleanup_failed");
    });
  }
}

function stateMac(jobId: string, state: JobStatus, secret: string) {
  return createHmac("sha256", secret)
    .update(`${jobId}\n${canonicalJson(state)}`, "utf8")
    .digest("hex");
}

async function readJob(store: string, jobId: string, secret: string): Promise<JobStatus | null> {
  let text: string;
  try {
    const filePath = path.join(store, `${jobId}.json`);
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JOB_RECORD_BYTES)
      throw new Error("verification_runner_state_corrupt");
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return null;
    throw new Error("verification_runner_state_unavailable");
  }
  try {
    const envelope = JSON.parse(text) as { version?: unknown; state?: unknown; mac?: unknown };
    if (
      envelope.version !== 1 ||
      typeof envelope.mac !== "string" ||
      !/^[a-f0-9]{64}$/.test(envelope.mac)
    )
      throw new Error("invalid_envelope");
    const state = envelope.state as JobStatus;
    if (
      !state ||
      typeof state !== "object" ||
      !["queued", "running", "completed", "failed"].includes(state.status)
    )
      throw new Error("invalid_state");
    if (state.status === "completed") {
      VerificationJobResultSchema.parse(state.result);
      const { resultFingerprint, ...resultBase } = state.result;
      if (
        state.result.jobId !== jobId ||
        state.result.requestFingerprint !== state.requestFingerprint ||
        sha256(canonicalJson(resultBase)) !== resultFingerprint
      )
        throw new Error("invalid_result");
    } else if (
      state.status === "failed" &&
      (state.failure.status !== "failed" || !/^[a-z0-9_]{1,100}$/.test(state.failure.category))
    ) {
      throw new Error("invalid_failure");
    } else if (!/^[a-f0-9]{64}$/.test(state.requestFingerprint)) {
      throw new Error("invalid_fingerprint");
    }
    const expected = Buffer.from(stateMac(jobId, state, secret), "hex");
    const provided = Buffer.from(envelope.mac, "hex");
    if (!timingSafeEqual(expected, provided)) throw new Error("invalid_mac");
    return state;
  } catch {
    throw new Error("verification_runner_state_corrupt");
  }
}

async function writeJob(store: string, jobId: string, state: JobStatus, secret: string) {
  const final = path.join(store, `${jobId}.json`);
  const body = Buffer.from(
    canonicalJson({ version: 1, state, mac: stateMac(jobId, state, secret) }),
    "utf8",
  );
  let persisted = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const temp = path.join(store, `${jobId}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(body);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temp, final);
      persisted = true;
      break;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
      const code =
        typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (!new Set(["EPERM", "EACCES", "EBUSY"]).has(code) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  if (!persisted) throw new Error("verification_runner_state_write_failed");
  const directory = await open(store, "r").catch(() => null);
  if (directory) {
    try {
      await directory.sync();
    } catch {
      /* directory fsync is not supported on every host */
    } finally {
      await directory.close();
    }
  }
}

export function createVerificationRunnerServer(config: VerificationRunnerConfig) {
  if (config.authSecret.length < 32) throw new Error("verification_runner_auth_not_configured");
  const origin = new URL(config.artifactOrigin);
  if (origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname))
    throw new Error("verification_runner_artifact_origin_invalid");
  const store = path.resolve(config.jobStorePath);
  const execute =
    config.execute ??
    ((request: VerificationJobRequest) => executeVerificationJob(request, config));
  const concurrency = Math.min(
    Math.max(config.maxConcurrency ?? MAX_CONCURRENCY, 1),
    MAX_CONCURRENCY,
  );
  const maxQueuedJobs = Number.isSafeInteger(config.maxQueuedJobs)
    ? Math.min(Math.max(config.maxQueuedJobs!, 0), 1_000)
    : MAX_QUEUED_JOBS;
  const maxJobRecords = Number.isSafeInteger(config.maxJobRecords)
    ? Math.min(Math.max(config.maxJobRecords!, 1), 100_000)
    : MAX_JOB_RECORDS;
  const queue: Array<{ request: VerificationJobRequest; jobId: string }> = [];
  const active = new Map<string, Promise<void>>();
  const reserved = new Map<string, string>();
  const retainReservation = new Set<string>();
  const submitting = new Set<string>();
  const recordReservations = new Set<string>();
  const seenNonces = new Map<string, number>();
  let activeCount = 0;
  let persistedJobCount = 0;

  const schedule = () => {
    while (activeCount < concurrency && queue.length) {
      const item = queue.shift()!;
      activeCount += 1;
      const work = (async () => {
        let stage: "mark_running" | "execute" | "mark_completed" = "mark_running";
        try {
          await writeJob(
            store,
            item.jobId,
            { status: "running", requestFingerprint: item.request.requestFingerprint },
            config.authSecret,
          );
          stage = "execute";
          const result = VerificationJobResultSchema.parse(await execute(item.request));
          if (
            result.jobId !== item.jobId ||
            result.requestFingerprint !== item.request.requestFingerprint
          )
            throw new Error("verification_runner_result_identity_mismatch");
          stage = "mark_completed";
          await writeJob(
            store,
            item.jobId,
            { status: "completed", requestFingerprint: item.request.requestFingerprint, result },
            config.authSecret,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          const code =
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "string"
              ? error.code.toLowerCase()
              : "";
          const category = /^[a-z0-9_]{1,100}$/.test(message)
            ? message
            : /^[a-z0-9_]{2,40}$/.test(code)
              ? `verification_runner_failed_${code}`
              : "verification_runner_failed";
          const safeCategory =
            (stage === "mark_running" || stage === "mark_completed") &&
            /^[a-z0-9_]{2,40}$/.test(code)
              ? `verification_runner_${stage}_${code}`
              : category;
          await writeJob(
            store,
            item.jobId,
            {
              status: "failed",
              requestFingerprint: item.request.requestFingerprint,
              failure: { status: "failed", category: safeCategory },
            },
            config.authSecret,
          ).catch(() => retainReservation.add(item.jobId));
        }
      })().finally(() => {
        active.delete(item.jobId);
        if (!retainReservation.has(item.jobId)) reserved.delete(item.jobId);
        activeCount -= 1;
        schedule();
      });
      active.set(item.jobId, work);
    }
  };

  const server = createServer(async (request, response) => {
    let body: Buffer;
    let url: URL;
    try {
      body = await readBody(request);
      url = new URL(request.url ?? "/", "http://runner.invalid");
    } catch {
      publicError(response, 400, "runner_request_invalid");
      return;
    }
    if (request.method === "GET" && url.pathname === "/healthz" && body.byteLength === 0) {
      json(response, 200, { status: "ok", protocolVersion: VERIFICATION_RUNNER_PROTOCOL_VERSION });
      return;
    }
    const requestPath = `${url.pathname}${url.search}`;
    if (!authenticate(request, requestPath, body, config.authSecret, seenNonces)) {
      publicError(response, 401, "runner_authentication_failed");
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/verification-jobs") {
      let parsed: VerificationJobRequest;
      try {
        parsed = VerificationJobRequestSchema.parse(JSON.parse(body.toString("utf8")));
      } catch {
        publicError(response, 400, "verification_job_invalid");
        return;
      }
      try {
        if (verificationJobIdentityFingerprint(parsed.identity) !== parsed.jobId)
          throw new Error("verification_job_identity_mismatch");
        if (
          verificationRequestFingerprint({
            identity: parsed.identity,
            commands: parsed.commands,
            snapshot: { sha256: parsed.snapshot.sha256, byteCount: parsed.snapshot.byteCount },
            patch: { sha256: parsed.patch.sha256, byteCount: parsed.patch.byteCount },
            cacheArchive: {
              sha256: parsed.cacheArchive.sha256,
              byteCount: parsed.cacheArchive.byteCount,
            },
            cacheManifest: parsed.cacheManifest,
            cacheSignature: parsed.cacheSignature,
          }) !== parsed.requestFingerprint
        )
          throw new Error("verification_request_fingerprint_mismatch");
        if (
          parsed.expiresAt <= Date.now() ||
          parsed.issuedAt > Date.now() + MAX_CLOCK_SKEW_MS ||
          parsed.expiresAt > parsed.issuedAt + 10 * 60_000
        )
          throw new Error("verification_runner_capability_expired");
        if (parsed.identity.image !== VERIFICATION_RUNNER_IMAGE)
          throw new Error("verification_runner_image_mismatch");
        if (
          parsed.identity.commandClasses.join("|") !==
          parsed.commands.map((command) => command.commandClass).join("|")
        )
          throw new Error("verification_command_identity_mismatch");
        if (parsed.patch.sha256 !== parsed.identity.patchFingerprint)
          throw new Error("verification_patch_identity_mismatch");
        if (
          parsed.cacheArchive.sha256 !== parsed.cacheManifest.archiveSha256 ||
          parsed.cacheArchive.byteCount !== parsed.cacheManifest.archiveByteCount
        )
          throw new Error("verification_cache_artifact_mismatch");
        if (parsed.cacheManifest.identityKey !== parsed.identity.cacheIdentityKey)
          throw new Error("verification_cache_identity_mismatch");
        for (const command of parsed.commands) assertSafeVerificationCommand(command);
        validateArtifactUrl(parsed.snapshot.url, "snapshot", config.artifactOrigin, parsed);
        validateArtifactUrl(parsed.patch.url, "patch", config.artifactOrigin, parsed);
        validateArtifactUrl(parsed.cacheArchive.url, "cache", config.artifactOrigin, parsed);
      } catch (error) {
        const category =
          error instanceof Error && /^[a-z0-9_]{1,100}$/.test(error.message)
            ? error.message
            : "verification_job_identity_invalid";
        publicError(response, 400, category);
        return;
      }
      let prior: JobStatus | null;
      try {
        prior = await readJob(store, parsed.jobId, config.authSecret);
      } catch {
        publicError(response, 503, "verification_runner_state_corrupt");
        return;
      }
      if (prior && prior.requestFingerprint !== parsed.requestFingerprint) {
        publicError(response, 409, "verification_job_id_conflict");
        return;
      }
      if (prior?.status === "completed") {
        signedResult(response, prior.result, config.authSecret);
        return;
      }
      const canResumeInterrupted =
        prior?.status === "failed" && prior.failure.category === "verification_runner_interrupted";
      if (prior?.status === "failed" && !canResumeInterrupted) {
        json(response, 200, prior.failure);
        return;
      }
      const reservedFingerprint = reserved.get(parsed.jobId);
      if (reservedFingerprint && reservedFingerprint !== parsed.requestFingerprint) {
        publicError(response, 409, "verification_job_id_conflict");
        return;
      }
      if (
        !active.has(parsed.jobId) &&
        !queue.some((item) => item.jobId === parsed.jobId) &&
        !reservedFingerprint
      ) {
        if (activeCount + queue.length + submitting.size >= concurrency + maxQueuedJobs) {
          publicError(response, 503, "verification_runner_queue_full");
          return;
        }
        if (!prior && persistedJobCount + recordReservations.size >= maxJobRecords) {
          publicError(response, 503, "verification_runner_job_store_full");
          return;
        }
        reserved.set(parsed.jobId, parsed.requestFingerprint);
        submitting.add(parsed.jobId);
        if (!prior) recordReservations.add(parsed.jobId);
        try {
          await writeJob(
            store,
            parsed.jobId,
            { status: "queued", requestFingerprint: parsed.requestFingerprint },
            config.authSecret,
          );
          if (!prior) persistedJobCount += 1;
          submitting.delete(parsed.jobId);
          recordReservations.delete(parsed.jobId);
          queue.push({ request: parsed, jobId: parsed.jobId });
          schedule();
        } catch {
          submitting.delete(parsed.jobId);
          recordReservations.delete(parsed.jobId);
          reserved.delete(parsed.jobId);
          publicError(response, 503, "verification_runner_state_unavailable");
          return;
        }
      }
      json(response, 202, {
        status: "accepted",
        jobId: parsed.jobId,
        requestFingerprint: parsed.requestFingerprint,
      });
      return;
    }
    const match = /^\/v1\/verification-jobs\/([a-f0-9]{64})$/.exec(url.pathname);
    if (request.method === "GET" && match && body.byteLength === 0) {
      const jobId = match[1]!;
      let status: JobStatus | null;
      try {
        status = await readJob(store, jobId, config.authSecret);
      } catch {
        publicError(response, 503, "verification_runner_state_corrupt");
        return;
      }
      if (!status) {
        publicError(response, 404, "verification_job_not_found");
        return;
      }
      if (status.status === "completed") {
        signedResult(response, status.result, config.authSecret);
        return;
      }
      if (status.status === "failed") {
        json(response, 200, status.failure);
        return;
      }
      json(response, 202, {
        status: status.status,
        jobId,
        requestFingerprint: status.requestFingerprint,
      });
      return;
    }
    publicError(response, 404, "runner_route_not_found");
  });

  return {
    server,
    async listen(port = 0, host = "127.0.0.1") {
      await mkdir(store, { recursive: true, mode: 0o700 });
      const entries = await readdir(store, { withFileTypes: true });
      persistedJobCount = entries.filter(
        (entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name),
      ).length;
      for (const entry of entries) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        const jobId = entry.name.slice(0, 64);
        const prior = await readJob(store, jobId, config.authSecret);
        if (prior?.status === "running" || prior?.status === "queued") {
          await writeJob(
            store,
            jobId,
            {
              status: "failed",
              requestFingerprint: prior.requestFingerprint,
              failure: { status: "failed", category: "verification_runner_interrupted" },
            },
            config.authSecret,
          );
        }
      }
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("verification_runner_listen_failed");
      return { host, port: address.port };
    },
    async close() {
      for (const work of active.values()) await work.catch(() => undefined);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
