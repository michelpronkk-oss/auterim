import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  sha256,
  VERIFICATION_RUNNER_IMAGE,
  VERIFICATION_RUNNER_PROTOCOL_VERSION,
  type VerificationJobRequest,
  type VerificationJobResult,
} from "../verification-runner/contracts";
import {
  createVerificationJobRequest,
  parseBoundedJsonResponse,
  RemoteVerificationRunnerClient,
} from "../src/lib/fix-engine/verification-runner-client";
import {
  assertNoSnapshotSecrets,
  createVerificationRunnerServer,
} from "../verification-runner/server";
import { extractSafeTarGzip, packSafeDirectory } from "../verification-runner/archive";
import { resolveVerificationProfile } from "../src/lib/fix-engine/verification-profile";

const AUTH_SECRET = "m1578r-test-auth-secret-01234567890123456789";
const WORKSPACE_ID = "e140d48e-9dc0-4552-a9a4-a81fe3872422";
const PRODUCT_ID = "de1f2a12-de3c-4644-8892-b6c2d458a300";
const REPOSITORY_ID = "3b4f4fe6-cbbd-4bbd-a340-71f7c268e2c4";
const BASE_SHA = "88634998e2aa823378da88cb209e4381595acf8c";
const SNAPSHOT_SHA = "1".repeat(64);
const PATCH_SHA = "2".repeat(64);
const TREE_SHA = "3".repeat(64);
const ARCHIVE_SHA = "4".repeat(64);
const MANIFEST_SHA = "5".repeat(64);
const LOCK_SHA = "6".repeat(64);
const snapshotPath = (fixRunId: string, fingerprint: string) =>
  `/storage/v1/object/sign/fix-engine-verification-artifacts/snapshots/${fixRunId}/${fingerprint}.tar.gz?token=local`;

function makeRequest(
  overrides: Partial<VerificationJobRequest> = {},
  fixRunId = "d0c2b9f6-75da-4cb7-b432-738fd9b4ec6a",
) {
  const patchId = "afe737c9-866f-4d8f-a8b3-0b5eaf89e001";
  const cacheIdentity = {
    repositoryId: REPOSITORY_ID,
    repositoryIdentity: "fixture.invalid/m1578-verification",
    commitSha: BASE_SHA,
    packageManager: "npm" as const,
    packageManifestSha256: MANIFEST_SHA,
    lockfileSha256: LOCK_SHA,
    runtimeProfile:
      "node24-linux-x64-alpine3.22-sha256-3e843c608bb5232f39ecb2b25e41214b958b0795914707374c8acc28487dea17",
  };
  const cacheIdentityKey = sha256(JSON.stringify(cacheIdentity));
  const cacheManifestPayload = {
    schemaVersion: 2 as const,
    buildStatus: "complete" as const,
    identity: cacheIdentity,
    identityKey: cacheIdentityKey,
    treeSha256: TREE_SHA,
    archiveSha256: ARCHIVE_SHA,
    artifactFingerprint: ARCHIVE_SHA,
    signatureAlgorithm: "ed25519" as const,
    createdAt: "2026-10-16T00:00:00.000Z",
    fileCount: 2,
    byteCount: 32,
    archiveByteCount: 128,
  };
  const cacheManifest = {
    ...cacheManifestPayload,
    manifestFingerprint: sha256(canonicalJson(cacheManifestPayload)),
  };
  const request = createVerificationJobRequest({
    identity: {
      workspaceId: WORKSPACE_ID,
      productId: PRODUCT_ID,
      fixRunId,
      planId: "24d241af-a451-40e2-9b45-a398982c9c07",
      planFingerprint: "7".repeat(64),
      evidenceFingerprint: "8".repeat(64),
      patchId,
      patchFingerprint: PATCH_SHA,
      allowedPaths: ["src/endpoint.ts"],
      repositoryId: REPOSITORY_ID,
      repositoryIdentity: "fixture.invalid/m1578-verification",
      baseCommitSha: BASE_SHA,
      packageManager: "npm",
      packageManifestSha256: MANIFEST_SHA,
      lockfileSha256: LOCK_SHA,
      runtimeProfile: cacheIdentity.runtimeProfile,
      profileId: "javascript-typescript-v1",
      profileVersion: "javascript-typescript-v1",
      cacheIdentityKey,
      cacheTreeSha256: TREE_SHA,
    },
    snapshot: {
      bucket: "fix-engine-verification-artifacts",
      path: `snapshots/${fixRunId}/${SNAPSHOT_SHA}.tar.gz`,
      sha256: SNAPSHOT_SHA,
      byteCount: 256,
      signedUrl: `http://127.0.0.1:54321${snapshotPath(fixRunId, SNAPSHOT_SHA)}`,
    },
    patch: {
      bucket: "fix-engine-artifacts",
      path: `${fixRunId}/${patchId}.diff`,
      sha256: PATCH_SHA,
      byteCount: 64,
      signedUrl: `http://127.0.0.1:54321/storage/v1/object/sign/fix-engine-artifacts/${fixRunId}/${patchId}.diff?token=local`,
    },
    cacheArchive: {
      bucket: "fix-engine-verification-artifacts",
      path: `caches/${REPOSITORY_ID}/${BASE_SHA}/${cacheIdentityKey}/dependencies.tar.gz`,
      sha256: ARCHIVE_SHA,
      byteCount: 128,
      signedUrl: `http://127.0.0.1:54321/storage/v1/object/sign/fix-engine-verification-artifacts/caches/${REPOSITORY_ID}/${BASE_SHA}/${cacheIdentityKey}/dependencies.tar.gz?token=local`,
    },
    cacheManifest,
    cacheSignature: Buffer.alloc(64, 9).toString("base64"),
    commands: [
      {
        commandClass: "typecheck",
        executable: "node",
        args: ["node_modules/typescript/bin/tsc", "--noEmit"],
      },
    ],
  });
  return { ...request, ...overrides } as VerificationJobRequest;
}

function resultFor(request: VerificationJobRequest): VerificationJobResult {
  const checks = [
    {
      commandClass: "typecheck" as const,
      status: "passed" as const,
      durationMs: 8,
      outputBytes: 0,
      diagnosticCategory: null,
    },
  ];
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
    status: "passed" as const,
    checks,
    durationMs: 8,
    snapshotFingerprint: request.identity.snapshotFingerprint,
    patchFingerprint: request.identity.patchFingerprint,
    cacheIdentityKey: request.identity.cacheIdentityKey,
    cacheTreeSha256: request.identity.cacheTreeSha256,
    outputFingerprint: sha256(canonicalJson(checks)),
  } as const;
  return { ...resultBase, resultFingerprint: sha256(canonicalJson(resultBase)) };
}

function hmac(method: string, pathname: string, issuedAt: string, nonce: string, body: Buffer) {
  const digest = sha256(body);
  return createHmac("sha256", AUTH_SECRET)
    .update(`${method}\n${pathname}\n${issuedAt}\n${nonce}\n${digest}`)
    .digest("hex");
}

async function signedFetch(
  base: string,
  method: "POST" | "GET",
  pathname: string,
  body: Buffer,
  nonce = "a".repeat(48),
) {
  const issuedAt = String(Date.now());
  return fetch(new URL(pathname, base), {
    method,
    headers: {
      "x-auterim-issued-at": issuedAt,
      "x-auterim-nonce": nonce,
      "x-auterim-signature": hmac(method, pathname, issuedAt, nonce, body),
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: body.toString("utf8") } : {}),
  });
}

describe("M15.78R remote verification runner", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("supports npm and fails closed for pnpm and Yarn cache layouts", () => {
    const npm = resolveVerificationProfile({
      packageJson: {
        packageManager: "npm@10.8.2",
        devDependencies: { vitest: "5.0.3", typescript: "5.9.3" },
      },
      files: ["package.json", "package-lock.json", "test/basic.test.ts"],
      targetedTestPaths: ["test/basic.test.ts"],
      dependencyCacheAvailable: true,
    });
    expect(npm).toMatchObject({ packageManager: "npm", state: "supported" });
    for (const [packageManager, lockfile] of [
      ["pnpm@10.0.0", "pnpm-lock.yaml"],
      ["yarn@4.0.0", "yarn.lock"],
    ]) {
      const unsupported = resolveVerificationProfile({
        packageJson: { packageManager, devDependencies: { vitest: "5.0.3", typescript: "5.9.3" } },
        files: ["package.json", lockfile, "test/basic.test.ts"],
        dependencyCacheAvailable: true,
      });
      expect(unsupported.state).toBe("verification_unsupported");
      expect(unsupported.reason).toBe("package_manager_layout_unsupported");
    }
  });

  async function startRunner(
    execute?: (request: VerificationJobRequest) => Promise<VerificationJobResult>,
    limits: {
      maxConcurrency?: number;
      maxQueuedJobs?: number;
      maxJobRecords?: number;
      cachePublicKey?: string;
    } = {},
  ) {
    const root = await mkdtemp(path.join(os.tmpdir(), "m1578r-runner-test-"));
    const { cachePublicKey, ...runnerLimits } = limits;
    const runner = createVerificationRunnerServer({
      authSecret: AUTH_SECRET,
      artifactOrigin: "http://127.0.0.1:54321",
      cachePublicKey: cachePublicKey ?? "ed25519 test-only public key",
      jobStorePath: path.join(root, "jobs"),
      workRoot: path.join(root, "work"),
      ...runnerLimits,
      execute,
    });
    const address = await runner.listen(0, "127.0.0.1");
    cleanups.push(async () => {
      await runner.close();
      await rm(root, { recursive: true, force: true });
    });
    return { runner, base: `http://127.0.0.1:${address.port}`, root };
  }

  it("authenticates, executes once, persists, signs, and reconciles the same job", async () => {
    let executions = 0;
    const { base } = await startRunner(async (request) => {
      executions += 1;
      return resultFor(request);
    });
    const request = makeRequest();
    const client = new RemoteVerificationRunnerClient({
      url: base,
      authSecret: AUTH_SECRET,
      maxWaitMs: 15_000,
    });
    const first = await client.execute(request);
    const replay = await client.execute(request);
    expect(first.status).toBe("passed");
    expect(replay.jobId).toBe(first.jobId);
    expect(executions).toBe(1);
  });

  it("rejects unauthenticated and replayed request capabilities", async () => {
    const { base } = await startRunner(async (request) => resultFor(request));
    const request = makeRequest();
    const body = Buffer.from(canonicalJson(request));
    const first = await signedFetch(base, "POST", "/v1/verification-jobs", body, "b".repeat(48));
    expect(first.status).toBe(202);
    const replay = await signedFetch(base, "POST", "/v1/verification-jobs", body, "b".repeat(48));
    expect(replay.status).toBe(401);
    const unauthenticated = await fetch(new URL("/v1/verification-jobs", base), {
      method: "POST",
      body: body.toString("utf8"),
    });
    expect(unauthenticated.status).toBe(401);
  });

  it.each([
    [
      "wrong request fingerprint",
      (request: VerificationJobRequest) => ({ ...request, requestFingerprint: "f".repeat(64) }),
    ],
    ["wrong job ID", (request: VerificationJobRequest) => ({ ...request, jobId: "e".repeat(64) })],
    [
      "wrong protocol",
      (request: VerificationJobRequest) => ({
        ...request,
        identity: { ...request.identity, protocolVersion: "remote-verification-v0" },
      }),
    ],
  ] as const)("rejects %s", async (_name, mutate) => {
    const { base } = await startRunner(async (request) => resultFor(request));
    const malformed = mutate(makeRequest());
    const body = Buffer.from(canonicalJson(malformed));
    const response = await signedFetch(base, "POST", "/v1/verification-jobs", body, "c".repeat(48));
    expect(response.status).toBe(400);
  });

  it("rejects expired job capabilities before enqueue", async () => {
    const { base } = await startRunner(async (request) => resultFor(request));
    const request = makeRequest({ issuedAt: Date.now() - 600_000, expiresAt: Date.now() - 1 });
    const response = await signedFetch(
      base,
      "POST",
      "/v1/verification-jobs",
      Buffer.from(canonicalJson(request)),
      "d".repeat(48),
    );
    expect(response.status).toBe(400);
  });

  it("rejects artifact path substitution before enqueue", async () => {
    const { base } = await startRunner(async (request) => resultFor(request));
    const request = makeRequest();
    request.patch.url = `http://127.0.0.1:54321/storage/v1/object/sign/fix-engine-artifacts/${request.identity.fixRunId}/../other.diff?token=local`;
    const response = await signedFetch(
      base,
      "POST",
      "/v1/verification-jobs",
      Buffer.from(canonicalJson(request)),
      "5".repeat(48),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "verification_patch_artifact_path_invalid" });
  });

  it("rejects an invalid signed cache before downloading artifacts", async () => {
    const keys = generateKeyPairSync("ed25519");
    const { base } = await startRunner(undefined, {
      cachePublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
    const client = new RemoteVerificationRunnerClient({
      url: base,
      authSecret: AUTH_SECRET,
      maxWaitMs: 5_000,
    });
    await expect(client.execute(makeRequest())).rejects.toThrow(
      "verification_cache_signature_invalid",
    );
  });

  it("rejects a signed result bound to a different commit", async () => {
    const { base } = await startRunner(async (request) => {
      const stale = { ...resultFor(request), baseCommitSha: "a".repeat(40) };
      const baseResult = { ...stale };
      delete (baseResult as { resultFingerprint?: string }).resultFingerprint;
      return {
        ...baseResult,
        resultFingerprint: sha256(canonicalJson(baseResult)),
      };
    });
    await expect(
      new RemoteVerificationRunnerClient({
        url: base,
        authSecret: AUTH_SECRET,
        maxWaitMs: 5_000,
      }).execute(makeRequest()),
    ).rejects.toThrow("verification_runner_result_identity_mismatch");
  });

  it("recovers an interrupted immutable job record after runner restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "m1578r-runner-restart-test-"));
    const jobStorePath = path.join(root, "jobs");
    await mkdir(jobStorePath, { recursive: true });
    const request = makeRequest();
    const state = { status: "running", requestFingerprint: request.requestFingerprint };
    const mac = createHmac("sha256", AUTH_SECRET)
      .update(`${request.jobId}\n${canonicalJson(state)}`)
      .digest("hex");
    await writeFile(
      path.join(jobStorePath, `${request.jobId}.json`),
      canonicalJson({ version: 1, state, mac }),
    );
    let executions = 0;
    const runner = createVerificationRunnerServer({
      authSecret: AUTH_SECRET,
      artifactOrigin: "http://127.0.0.1:54321",
      cachePublicKey: "ed25519 test-only public key",
      jobStorePath,
      execute: async (job) => {
        executions += 1;
        return resultFor(job);
      },
    });
    const address = await runner.listen(0, "127.0.0.1");
    cleanups.push(async () => {
      await runner.close();
      await rm(root, { recursive: true, force: true });
    });
    const client = new RemoteVerificationRunnerClient({
      url: `http://127.0.0.1:${address.port}`,
      authSecret: AUTH_SECRET,
      maxWaitMs: 15_000,
    });
    expect((await client.execute(request)).status).toBe("passed");
    expect((await client.execute(request)).jobId).toBe(request.jobId);
    expect(executions).toBe(1);
  });

  it("fails closed when the remote runner is unavailable", async () => {
    const unused = await startRunner(async (request) => resultFor(request));
    const { port } = new URL(unused.base);
    await unused.runner.close();
    cleanups.pop();
    await rm(unused.root, { recursive: true, force: true });
    await expect(
      new RemoteVerificationRunnerClient({
        url: `http://127.0.0.1:${port}`,
        authSecret: AUTH_SECRET,
        maxWaitMs: 1_000,
      }).execute(makeRequest()),
    ).rejects.toThrow("verification_runner_timeout");
  });

  it("fails closed if the durable result record has been tampered with", async () => {
    const { base, root } = await startRunner(async (request) => resultFor(request));
    const request = makeRequest();
    const client = new RemoteVerificationRunnerClient({
      url: base,
      authSecret: AUTH_SECRET,
      maxWaitMs: 15_000,
    });
    await client.execute(request);
    const pathToJob = path.join(root, "jobs", `${request.jobId}.json`);
    const envelope = JSON.parse(await readFile(pathToJob, "utf8")) as { state: { status: string } };
    envelope.state.status = "failed";
    await writeFile(pathToJob, JSON.stringify(envelope));
    const status = await signedFetch(
      base,
      "GET",
      `/v1/verification-jobs/${request.jobId}`,
      Buffer.alloc(0),
      "e".repeat(48),
    );
    expect(status.status).toBe(503);
  });

  it("rejects an oversized persisted job record before reading its contents", async () => {
    const { base, root } = await startRunner(async (request) => resultFor(request));
    await writeFile(path.join(root, "jobs", `${"a".repeat(64)}.json`), "x".repeat(70 * 1024));
    const response = await signedFetch(
      base,
      "GET",
      `/v1/verification-jobs/${"a".repeat(64)}`,
      Buffer.alloc(0),
      "4".repeat(48),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "verification_runner_state_corrupt" });
  });

  it("bounds runner responses while streaming and rejects oversized JSON", async () => {
    const parsed = await parseBoundedJsonResponse(new Response(JSON.stringify({ status: "ok" })));
    expect(parsed.value).toEqual({ status: "ok" });

    const oversized = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(64 * 1024 + 1));
          controller.close();
        },
      }),
    );
    await expect(parseBoundedJsonResponse(oversized)).rejects.toThrow(
      "verification_runner_response_too_large",
    );
  });

  it("scans the complete bounded snapshot for secret-like values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "m1578r-snapshot-secret-test-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "source.ts"), `${"x".repeat(5000)}\nghp_${"A".repeat(40)}`);
    await expect(assertNoSnapshotSecrets(root)).rejects.toThrow(
      "verification_snapshot_secret_detected",
    );
  });

  it("rejects Git metadata in an incoming snapshot archive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "m1578r-git-metadata-test-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const archive = path.join(root, "snapshot.tar.gz");
    const maliciousArchive = path.join(root, "malicious.tar.gz");
    await mkdir(source);
    await writeFile(path.join(source, "source.ts"), "export const safe = true;\n");
    await packSafeDirectory(source, archive, { maxFiles: 10, maxBytes: 1024 });
    const tar = gunzipSync(await readFile(archive));
    const header = tar.subarray(0, 512);
    header.fill(0, 0, 100);
    Buffer.from(".git/config").copy(header, 0);
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    Buffer.from(checksum.toString(8).padStart(6, "0") + "\0 ", "ascii").copy(header, 148);
    await writeFile(maliciousArchive, gzipSync(tar));
    await expect(
      extractSafeTarGzip(maliciousArchive, destination, { maxFiles: 10, maxBytes: 1024 }),
    ).rejects.toThrow("verification_archive_git_metadata_forbidden");
  });

  it("bounds queued work and refuses new jobs when the retained job ledger is full", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { base } = await startRunner(
      async (request) => {
        await gate;
        return resultFor(request);
      },
      { maxConcurrency: 1, maxQueuedJobs: 1, maxJobRecords: 2 },
    );
    const first = makeRequest();
    const second = makeRequest({}, "e0c4a13d-5c28-47e5-865b-2e9d4ae7d2cd");
    const third = makeRequest({}, "c756468c-abcf-48da-9f97-b6ba613e56c5");
    const submit = (request: VerificationJobRequest, nonce: string) =>
      signedFetch(
        base,
        "POST",
        "/v1/verification-jobs",
        Buffer.from(canonicalJson(request)),
        nonce,
      );
    const firstResponse = await submit(first, "f".repeat(48));
    const secondResponse = await submit(second, "1".repeat(48));
    const thirdResponse = await submit(third, "2".repeat(48));
    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);
    expect(thirdResponse.status).toBe(503);
    expect(await thirdResponse.json()).toEqual({ error: "verification_runner_queue_full" });
    release();

    const client = new RemoteVerificationRunnerClient({
      url: base,
      authSecret: AUTH_SECRET,
      maxWaitMs: 15_000,
    });
    // Both accepted records are retained; a distinct third identity is rejected
    // rather than growing the durable replay ledger without bound.
    await client.execute(first);
    await client.execute(second);
    const fullResponse = await submit(third, "3".repeat(48));
    expect(fullResponse.status).toBe(503);
    expect(await fullResponse.json()).toEqual({ error: "verification_runner_job_store_full" });
  });
});
