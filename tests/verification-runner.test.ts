import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  sha256,
  VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF,
  VERIFICATION_RUNNER_IDENTITY_ATTESTATION_PATH,
  VERIFICATION_RUNNER_IDENTITY_MAX_AGE_MS,
  VERIFICATION_RUNNER_IMAGE,
  VERIFICATION_RUNNER_PROTOCOL_VERSION,
  type VerificationJobRequest,
  type VerificationJobResult,
} from "../verification-runner/contracts";
import {
  type MaterializedVerificationJob,
  assertMaterializedArtifact,
  persistMaterializedJobManifest,
  toMaterializedVerificationJob,
} from "../verification-runner/spool";
import {
  createVerificationJobRequest,
  parseBoundedJsonResponse,
  RemoteVerificationRunnerClient,
} from "../src/lib/fix-engine/verification-runner-client";
import {
  assertNoSnapshotSecrets,
  createVerificationRunnerServer,
  parseHostIdentityFile,
  type VerificationRunnerConfig,
} from "../verification-runner/server";
import {
  AWS_EU_WEST_1_RSA_CERTIFICATE_SHA256,
  EXPECTED_VERIFIER_INSTANCE,
  EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS,
  verifyRsaSha256DocumentSignature,
  verifyRunnerIdentityAttestation,
} from "../src/lib/fix-engine/runner-identity-attestation";
import { extractSafeTarGzip, packSafeDirectory } from "../verification-runner/archive";
import { resolveVerificationProfile } from "../src/lib/fix-engine/verification-profile";
import {
  isVerificationRunnerRetryableFailure,
  retryableRunnerFailure,
  terminalRunnerFailure,
} from "../src/lib/fix-engine/verification-retry";

const AUTH_SECRET = "m1578r-test-auth-secret-01234567890123456789";
const CACHE_KEYS = generateKeyPairSync("ed25519");
const WORKSPACE_ID = "e140d48e-9dc0-4552-a9a4-a81fe3872422";
const PRODUCT_ID = "de1f2a12-de3c-4644-8892-b6c2d458a300";
const REPOSITORY_ID = "3b4f4fe6-cbbd-4bbd-a340-71f7c268e2c4";
const BASE_SHA = "88634998e2aa823378da88cb209e4381595acf8c";
const SNAPSHOT_BYTES = Buffer.alloc(256, 0x61);
const PATCH_BYTES = Buffer.alloc(64, 0x61);
const CACHE_BYTES = Buffer.alloc(128, 0x61);
const SNAPSHOT_SHA = sha256(SNAPSHOT_BYTES);
const PATCH_SHA = sha256(PATCH_BYTES);
const TREE_SHA = "3".repeat(64);
const ARCHIVE_SHA = sha256(CACHE_BYTES);
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
    cacheSignature: sign(
      null,
      Buffer.from(canonicalJson(cacheManifest)),
      CACHE_KEYS.privateKey,
    ).toString("base64"),
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

function resultFor(request: MaterializedVerificationJob): VerificationJobResult {
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

async function persistJobState(jobStorePath: string, jobId: string, state: unknown) {
  await mkdir(jobStorePath, { recursive: true });
  const mac = createHmac("sha256", AUTH_SECRET)
    .update(`${jobId}\n${canonicalJson(state)}`)
    .digest("hex");
  await writeFile(
    path.join(jobStorePath, `${jobId}.json`),
    canonicalJson({ version: 1, state, mac }),
  );
}

async function persistTestSpool(
  spoolRoot: string,
  request: VerificationJobRequest,
): Promise<MaterializedVerificationJob> {
  const job = toMaterializedVerificationJob(request);
  const directory = path.join(spoolRoot, job.jobId);
  await mkdir(directory, { recursive: true });
  for (const artifact of [job.snapshot, job.patch, job.cacheArchive]) {
    const content =
      artifact.fileName === "snapshot.tar.gz"
        ? SNAPSHOT_BYTES
        : artifact.fileName === "patch.diff"
          ? PATCH_BYTES
          : CACHE_BYTES;
    await writeFile(path.join(directory, artifact.fileName), content, { flag: "wx", mode: 0o600 });
  }
  await persistMaterializedJobManifest(directory, job, AUTH_SECRET);
  return job;
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
    vi.unstubAllGlobals();
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

  it("rejects npm dependencies that require install preparation and preserves the retry taxonomy", () => {
    const base = {
      packageJson: {
        packageManager: "npm@10.8.2",
        devDependencies: { vitest: "5.0.3", typescript: "5.9.3" },
      },
      files: ["package.json", "package-lock.json", "test/basic.test.ts"],
      targetedTestPaths: ["test/basic.test.ts"],
      dependencyCacheAvailable: true,
    };
    expect(resolveVerificationProfile(base).state).toBe("supported");
    expect(
      resolveVerificationProfile({
        ...base,
        packageLock: {
          lockfileVersion: 3,
          packages: {
            "": {},
            "node_modules/native-helper": { hasInstallScript: true },
          },
        },
      }),
    ).toMatchObject({
      state: "verification_unsupported",
      reason: "dependency_install_scripts_required",
    });
    expect(
      resolveVerificationProfile({
        ...base,
        packageLock: {
          lockfileVersion: 3,
          packages: {
            "": {},
            "node_modules/fsevents": {
              hasInstallScript: true,
              optional: true,
              os: ["darwin"],
            },
          },
        },
      }).state,
    ).toBe("supported");
    expect(
      resolveVerificationProfile({
        ...base,
        packageLock: { lockfileVersion: 3, packages: [] },
      }),
    ).toMatchObject({ state: "verification_unsupported", reason: "package_lock_invalid" });

    for (const category of [
      "runner_unavailable",
      "runner_queue_full",
      "runner_state_temporarily_unavailable",
      "runner_transport_ambiguous",
      "runner_poll_timeout",
      "runner_timeout_when_execution_may_continue",
    ] as const)
      expect(isVerificationRunnerRetryableFailure(retryableRunnerFailure(category))).toBe(true);
    for (const category of [
      "runner_request_invalid",
      "runner_auth_failed",
      "runner_protocol_unsupported",
      "runner_result_invalid",
      "snapshot_identity_mismatch",
      "patch_identity_mismatch",
      "cache_identity_mismatch",
      "cache_signature_invalid",
      "cache_tree_invalid",
      "verification_unsupported",
      "verification_failed",
    ] as const)
      expect(isVerificationRunnerRetryableFailure(terminalRunnerFailure(category))).toBe(false);
  });

  async function startRunner(
    execute?: (request: MaterializedVerificationJob) => Promise<VerificationJobResult>,
    limits: {
      maxConcurrency?: number;
      maxQueuedJobs?: number;
      maxJobRecords?: number;
      maxSpoolBytes?: number;
      cachePublicKey?: string;
      attestIdentity?: VerificationRunnerConfig["attestIdentity"];
    } = {},
  ) {
    const root = await mkdtemp(path.join(os.tmpdir(), "m1578r-runner-test-"));
    const { cachePublicKey, ...runnerLimits } = limits;
    const runner = createVerificationRunnerServer({
      authSecret: AUTH_SECRET,
      artifactOrigin: "http://127.0.0.1:54321",
      cachePublicKey:
        cachePublicKey ?? CACHE_KEYS.publicKey.export({ type: "spki", format: "pem" }).toString(),
      jobStorePath: path.join(root, "jobs"),
      workRoot: path.join(root, "work"),
      materialize: async (request, spoolRoot, secret) => {
        const job = toMaterializedVerificationJob(request);
        const directory = path.join(spoolRoot, job.jobId);
        await mkdir(directory, { recursive: true });
        for (const artifact of [job.snapshot, job.patch, job.cacheArchive]) {
          const content =
            artifact.fileName === "snapshot.tar.gz"
              ? SNAPSHOT_BYTES
              : artifact.fileName === "patch.diff"
                ? PATCH_BYTES
                : CACHE_BYTES;
          await writeFile(path.join(directory, artifact.fileName), content, {
            flag: "wx",
            mode: 0o600,
          });
        }
        await persistMaterializedJobManifest(directory, job, secret);
        return job;
      },
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
    expect(first).toMatchObject({
      jobId: request.jobId,
      requestFingerprint: request.requestFingerprint,
      protocolVersion: VERIFICATION_RUNNER_PROTOCOL_VERSION,
      runnerVersion: "m1578-runner-v1",
      runtimeImage: VERIFICATION_RUNNER_IMAGE,
      status: "passed",
    });
    expect(replay.jobId).toBe(first.jobId);
    expect(executions).toBe(1);
  });

  it("authenticates a nonce-bound read-only runner identity attestation without admitting a job", async () => {
    const fakeIdentity = {
      instanceIdentityDocument: JSON.stringify({
        accountId: EXPECTED_VERIFIER_INSTANCE.accountId,
        region: EXPECTED_VERIFIER_INSTANCE.region,
        instanceId: EXPECTED_VERIFIER_INSTANCE.instanceId,
        imageId: "ami-0123456789abcdef0",
      }),
      instanceIdentitySignature: Buffer.alloc(128).toString("base64"),
      identityFetchedAt: Date.now(),
      containerImageId: EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS[0],
      containerImageRef: VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF,
    };
    let attestCalls = 0;
    let executeCalls = 0;
    const { base, root } = await startRunner(
      async () => {
        executeCalls += 1;
        throw new Error("verification_job_must_not_execute");
      },
      {
        attestIdentity: async () => {
          attestCalls += 1;
          return fakeIdentity;
        },
      },
    );
    const challenge = "b".repeat(64);
    const body = Buffer.from(JSON.stringify({ nonce: challenge }));
    const response = await signedFetch(
      base,
      "POST",
      VERIFICATION_RUNNER_IDENTITY_ATTESTATION_PATH,
      body,
    );
    const value = (await response.json()) as Record<string, unknown>;
    const signature = response.headers.get("x-auterim-identity-signature") ?? "";
    const expected = createHmac("sha256", AUTH_SECRET)
      .update(canonicalJson(value), "utf8")
      .digest("hex");

    expect(response.status).toBe(200);
    expect(signature).toBe(expected);
    expect(value).toMatchObject({ nonce: challenge, ...fakeIdentity });
    expect(attestCalls).toBe(1);
    expect(executeCalls).toBe(0);
    const replay = await signedFetch(
      base,
      "POST",
      VERIFICATION_RUNNER_IDENTITY_ATTESTATION_PATH,
      body,
    );
    expect(replay.status).toBe(401);
    expect(attestCalls).toBe(1);
    const persisted = await readdir(path.join(root, "jobs"), { withFileTypes: true }).catch(
      () => [],
    );
    expect(persisted.some((entry) => entry.isFile() && entry.name.endsWith(".json"))).toBe(false);
    const spool = await readdir(path.join(root, "jobs", "artifacts")).catch(() => []);
    expect(spool).toHaveLength(0);
  });

  it("fails closed for unauthenticated or malformed runner identity attestation requests", async () => {
    let attestCalls = 0;
    const { base } = await startRunner(undefined, {
      attestIdentity: async () => {
        attestCalls += 1;
        throw new Error("should_not_be_called");
      },
    });
    const pathName = VERIFICATION_RUNNER_IDENTITY_ATTESTATION_PATH;
    const unauthenticated = await fetch(new URL(pathName, base), {
      method: "POST",
      body: JSON.stringify({ nonce: "c".repeat(64) }),
    });
    expect(unauthenticated.status).toBe(401);

    const malformed = await signedFetch(
      base,
      "POST",
      pathName,
      Buffer.from(JSON.stringify({ nonce: "wrong" })),
      "d".repeat(48),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "runner_identity_attestation_invalid" });
    expect(attestCalls).toBe(0);
  });

  it("accepts only a strict, fresh host-delivered identity file", () => {
    const now = 1_800_000_000_000;
    const identityRecord = {
      document: JSON.stringify({
        accountId: EXPECTED_VERIFIER_INSTANCE.accountId,
        region: EXPECTED_VERIFIER_INSTANCE.region,
        instanceId: EXPECTED_VERIFIER_INSTANCE.instanceId,
        imageId: "ami-0123456789abcdef0",
      }),
      signature: Buffer.alloc(128, 7).toString("base64"),
      fetchedAt: now,
    };
    expect(parseHostIdentityFile(JSON.stringify(identityRecord), now)).toMatchObject({
      instanceIdentityDocument: identityRecord.document,
      instanceIdentitySignature: identityRecord.signature,
      identityFetchedAt: now,
    });
    expect(() =>
      parseHostIdentityFile(
        JSON.stringify({
          ...identityRecord,
          fetchedAt: now - VERIFICATION_RUNNER_IDENTITY_MAX_AGE_MS - 1,
        }),
        now,
      ),
    ).toThrow("runner_identity_metadata_unavailable");
    for (const byteCount of [127, 129]) {
      expect(() =>
        parseHostIdentityFile(
          JSON.stringify({
            ...identityRecord,
            signature: Buffer.alloc(byteCount).toString("base64"),
          }),
          now,
        ),
      ).toThrow("runner_identity_metadata_unavailable");
    }
    expect(() =>
      parseHostIdentityFile(JSON.stringify({ ...identityRecord, fetchedAt: now + 5_001 }), now),
    ).toThrow("runner_identity_metadata_unavailable");
    expect(() =>
      parseHostIdentityFile(JSON.stringify({ ...identityRecord, unexpected: true }), now),
    ).toThrow("runner_identity_metadata_unavailable");
    expect(() =>
      parseHostIdentityFile(JSON.stringify({ ...identityRecord, signature: "not-base64" }), now),
    ).toThrow("runner_identity_metadata_unavailable");
    expect(() =>
      parseHostIdentityFile(
        JSON.stringify({
          ...identityRecord,
          signature: `${identityRecord.signature.slice(0, 64)}\n${identityRecord.signature.slice(64)}`,
        }),
        now,
      ),
    ).toThrow("runner_identity_metadata_unavailable");
  });

  it("verifies the AWS RSA identity signature and rejects nonce, host, and signature mismatches", () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const identityDocument = JSON.stringify({
      accountId: EXPECTED_VERIFIER_INSTANCE.accountId,
      region: EXPECTED_VERIFIER_INSTANCE.region,
      instanceId: EXPECTED_VERIFIER_INSTANCE.instanceId,
      imageId: "ami-0123456789abcdef0",
    });
    const identitySignature = sign(
      "sha256",
      Buffer.from(identityDocument),
      keys.privateKey,
    ).toString("base64");
    expect(
      verifyRsaSha256DocumentSignature(identityDocument, identitySignature, keys.publicKey),
    ).toBe(true);
    const wrappedSignature = `${identitySignature.slice(0, 64)}\r\n \t${identitySignature.slice(64)}`;
    expect(
      verifyRsaSha256DocumentSignature(identityDocument, wrappedSignature, keys.publicKey),
    ).toBe(true);
    expect(
      verifyRsaSha256DocumentSignature(`${identityDocument} `, identitySignature, keys.publicKey),
    ).toBe(false);
    for (const malformed of [
      `${identitySignature}\u0000`,
      `${identitySignature}\u00a0`,
      `${identitySignature}\v`,
      `${identitySignature}\f`,
      Buffer.alloc(127).toString("base64"),
      Buffer.alloc(129).toString("base64"),
    ]) {
      expect(verifyRsaSha256DocumentSignature(identityDocument, malformed, keys.publicKey)).toBe(
        false,
      );
    }
    const wrongCertificateKey = generateKeyPairSync("rsa", { modulusLength: 1024 });
    expect(
      verifyRsaSha256DocumentSignature(
        identityDocument,
        identitySignature,
        wrongCertificateKey.publicKey,
      ),
    ).toBe(false);

    const nonce = "e".repeat(64);
    const body = {
      nonce,
      issuedAt: Date.now(),
      identityFetchedAt: Date.now(),
      instanceIdentityDocument: identityDocument,
      instanceIdentitySignature: wrappedSignature,
      containerImageId: EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS[0],
      containerImageRef: VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF,
    };
    const responseSignature = createHmac("sha256", AUTH_SECRET)
      .update(canonicalJson(body), "utf8")
      .digest("hex");
    expect(AWS_EU_WEST_1_RSA_CERTIFICATE_SHA256).toBe(
      "7092993efe38800eedd69def9cf34b734ac828cce30ef94342388bc7a548827d",
    );
    expect(
      verifyRunnerIdentityAttestation({
        body,
        responseSignature,
        requestNonce: nonce,
        authSecret: AUTH_SECRET,
        signaturePublicKey: keys.publicKey,
      }),
    ).toEqual({
      accountId: EXPECTED_VERIFIER_INSTANCE.accountId,
      region: EXPECTED_VERIFIER_INSTANCE.region,
      instanceId: EXPECTED_VERIFIER_INSTANCE.instanceId,
      instanceImageId: "ami-0123456789abcdef0",
      runnerContainerImageId: EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS[0],
      runnerContainerImageRef: VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF,
    });
    const now = body.issuedAt;
    const staleIdentity = {
      ...body,
      identityFetchedAt: now - VERIFICATION_RUNNER_IDENTITY_MAX_AGE_MS - 1,
    };
    const staleSignature = createHmac("sha256", AUTH_SECRET)
      .update(canonicalJson(staleIdentity), "utf8")
      .digest("hex");
    expect(() =>
      verifyRunnerIdentityAttestation({
        body: staleIdentity,
        responseSignature: staleSignature,
        requestNonce: nonce,
        authSecret: AUTH_SECRET,
        now,
        signaturePublicKey: keys.publicKey,
      }),
    ).toThrow("runner_identity_document_stale");
    for (const unapprovedImageId of [
      "sha256:c8bfd835ad08ed3516f0a5c2315d519317b4b71b18e4fe1c7735cad89bc3e90a",
      `sha256:${"d".repeat(64)}`,
    ]) {
      const otherImage = { ...body, containerImageId: unapprovedImageId };
      const otherImageSignature = createHmac("sha256", AUTH_SECRET)
        .update(canonicalJson(otherImage), "utf8")
        .digest("hex");
      expect(() =>
        verifyRunnerIdentityAttestation({
          body: otherImage,
          responseSignature: otherImageSignature,
          requestNonce: nonce,
          authSecret: AUTH_SECRET,
          now,
          signaturePublicKey: keys.publicKey,
        }),
      ).toThrow("runner_container_image_mismatch");
    }
    expect(() =>
      verifyRunnerIdentityAttestation({
        body,
        responseSignature,
        requestNonce: "f".repeat(64),
        authSecret: AUTH_SECRET,
        signaturePublicKey: keys.publicKey,
      }),
    ).toThrow("runner_identity_attestation_signature_invalid");
    const wrongHost = {
      ...body,
      instanceIdentityDocument: JSON.stringify({
        accountId: EXPECTED_VERIFIER_INSTANCE.accountId,
        region: EXPECTED_VERIFIER_INSTANCE.region,
        instanceId: "i-00000000000000000",
        imageId: "ami-0123456789abcdef0",
      }),
    };
    const wrongHostSignature = createHmac("sha256", AUTH_SECRET)
      .update(canonicalJson(wrongHost), "utf8")
      .digest("hex");
    expect(() =>
      verifyRunnerIdentityAttestation({
        body: wrongHost,
        responseSignature: wrongHostSignature,
        requestNonce: nonce,
        authSecret: AUTH_SECRET,
        signaturePublicKey: keys.publicKey,
      }),
    ).toThrow("runner_identity_claim_mismatch");
    const wrongDocumentSignature = {
      ...body,
      instanceIdentitySignature: Buffer.alloc(128, 1).toString("base64"),
    };
    const wrongSignatureHmac = createHmac("sha256", AUTH_SECRET)
      .update(canonicalJson(wrongDocumentSignature), "utf8")
      .digest("hex");
    expect(() =>
      verifyRunnerIdentityAttestation({
        body: wrongDocumentSignature,
        responseSignature: wrongSignatureHmac,
        requestNonce: nonce,
        authSecret: AUTH_SECRET,
        signaturePublicKey: keys.publicKey,
      }),
    ).toThrow("runner_identity_signature_invalid");
  });

  it("executes admitted artifacts after their signed URLs expire and reconciles a long-running job once", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstStartedSignal = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const executions = new Map<string, number>();
    const { base, root } = await startRunner(
      async (job) => {
        executions.set(job.jobId, (executions.get(job.jobId) ?? 0) + 1);
        if (job.jobId === firstRequest.jobId) {
          firstStarted();
          await firstGate;
        }
        const directory = path.join(root, "jobs", "artifacts", job.jobId);
        await Promise.all([
          assertMaterializedArtifact(directory, job.snapshot),
          assertMaterializedArtifact(directory, job.patch),
          assertMaterializedArtifact(directory, job.cacheArchive),
        ]);
        return resultFor(job);
      },
      { maxConcurrency: 1, maxQueuedJobs: 2 },
    );
    const firstRequest = makeRequest();
    const queuedRequest = makeRequest({}, "e0c4a13d-5c28-47e5-865b-2e9d4ae7d2cd");
    queuedRequest.snapshot.url = queuedRequest.snapshot.url.replace("token=local", "token=expired");
    queuedRequest.patch.url = queuedRequest.patch.url.replace("token=local", "token=expired");
    queuedRequest.cacheArchive.url = queuedRequest.cacheArchive.url.replace(
      "token=local",
      "token=expired",
    );
    const firstClient = new RemoteVerificationRunnerClient({
      url: base,
      authSecret: AUTH_SECRET,
      maxWaitMs: 15_000,
    });
    const firstCompletion = firstClient.execute(firstRequest);
    await firstStartedSignal;

    const shortClient = new RemoteVerificationRunnerClient({
      url: base,
      authSecret: AUTH_SECRET,
      maxWaitMs: 1_000,
    });
    await expect(shortClient.execute(queuedRequest)).rejects.toMatchObject({
      category: "runner_poll_timeout",
      retryable: true,
    });
    const spoolDirectory = path.join(root, "jobs", "artifacts", queuedRequest.jobId);
    const manifestText = await readFile(path.join(spoolDirectory, "admission.json"), "utf8");
    expect(manifestText).not.toContain("token=expired");
    expect(manifestText).not.toContain('"url"');
    const admitted = JSON.parse(manifestText).job as MaterializedVerificationJob;
    expect(admitted.jobId).toBe(queuedRequest.jobId);
    expect(admitted.requestFingerprint).toBe(queuedRequest.requestFingerprint);
    await Promise.all([
      assertMaterializedArtifact(spoolDirectory, admitted.snapshot),
      assertMaterializedArtifact(spoolDirectory, admitted.patch),
      assertMaterializedArtifact(spoolDirectory, admitted.cacheArchive),
    ]);

    releaseFirst();
    await firstCompletion;
    for (let attempt = 0; attempt < 100 && !executions.has(queuedRequest.jobId); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const replay = await new RemoteVerificationRunnerClient({
      url: base,
      authSecret: AUTH_SECRET,
      maxWaitMs: 5_000,
    }).execute(queuedRequest);
    expect(replay.jobId).toBe(queuedRequest.jobId);
    expect(executions.get(firstRequest.jobId)).toBe(1);
    expect(executions.get(queuedRequest.jobId)).toBe(1);
  });

  it("rejects unauthenticated and replayed request capabilities", async () => {
    const { base } = await startRunner(async (request) => resultFor(request));
    const request = makeRequest();
    const body = Buffer.from(canonicalJson(request));
    const first = await signedFetch(base, "POST", "/v1/verification-jobs", body, "b".repeat(48));
    expect(first.status).toBe(202);
    const replay = await signedFetch(base, "POST", "/v1/verification-jobs", body, "b".repeat(48));
    expect(replay.status).toBe(401);
    await expect(
      new RemoteVerificationRunnerClient({
        url: base,
        authSecret: "wrong-auth-secret-012345678901234567890123",
        maxWaitMs: 1_000,
      }).execute(request),
    ).rejects.toMatchObject({ category: "runner_auth_failed", retryable: false });
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

  it("reports an identity-fingerprint rejection at admission without accepting the job", async () => {
    const { base, root } = await startRunner(async (request) => resultFor(request));
    const request = makeRequest({ requestFingerprint: "f".repeat(64) });
    const client = new RemoteVerificationRunnerClient({
      url: base,
      authSecret: AUTH_SECRET,
      maxWaitMs: 5_000,
    });
    await expect(client.execute(request)).rejects.toMatchObject({
      category: "runner_result_invalid",
      diagnostics: [
        {
          phase: "admission",
          httpStatus: 400,
          responseCategory: "verification_request_fingerprint_mismatch",
          reason: "http_error",
        },
      ],
    });
    expect(await readdir(path.join(root, "jobs"))).toEqual(["artifacts"]);
    expect(await readdir(path.join(root, "jobs", "artifacts"))).toEqual([]);
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

    const clientRequest = makeRequest({}, "eb02bb5c-f8f8-4f52-8c74-8d11e13ed37f");
    clientRequest.patch.url = `http://127.0.0.1:54321/storage/v1/object/sign/fix-engine-artifacts/${clientRequest.identity.fixRunId}/../other.diff?token=local`;
    await expect(
      new RemoteVerificationRunnerClient({
        url: base,
        authSecret: AUTH_SECRET,
        maxWaitMs: 5_000,
      }).execute(clientRequest),
    ).rejects.toMatchObject({
      category: "patch_identity_mismatch",
      diagnostics: [
        {
          phase: "admission",
          httpStatus: 400,
          responseCategory: "verification_patch_artifact_path_invalid",
          reason: "http_error",
        },
      ],
    });
  });

  it("preserves an artifact-download admission failure and writes no durable job record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "m1578r-runner-admission-test-"));
    const jobStorePath = path.join(root, "jobs");
    const runner = createVerificationRunnerServer({
      authSecret: AUTH_SECRET,
      artifactOrigin: "http://127.0.0.1:54321",
      cachePublicKey: CACHE_KEYS.publicKey.export({ type: "spki", format: "pem" }).toString(),
      jobStorePath,
      workRoot: path.join(root, "work"),
      execute: async (request) => resultFor(request),
    });
    const address = await runner.listen(0, "127.0.0.1");
    cleanups.push(async () => {
      await runner.close();
      await rm(root, { recursive: true, force: true });
    });
    const originalFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (target.port === "54321") return new Response("denied", { status: 403 });
      return originalFetch(input, init);
    });
    await expect(
      new RemoteVerificationRunnerClient({
        url: `http://127.0.0.1:${address.port}`,
        authSecret: AUTH_SECRET,
        maxWaitMs: 5_000,
      }).execute(makeRequest()),
    ).rejects.toMatchObject({
      category: "runner_unavailable",
      retryable: true,
      diagnostics: [
        {
          phase: "admission",
          httpStatus: 503,
          responseCategory: "verification_artifact_unavailable",
          reason: "http_error",
        },
      ],
    });
    expect(await readdir(jobStorePath)).toEqual(["artifacts"]);
    expect(await readdir(path.join(jobStorePath, "artifacts"))).toEqual([]);
  });

  it("preserves sanitized admission status/category and proves cache rejection precedes job persistence", async () => {
    const keys = generateKeyPairSync("ed25519");
    const { base, root } = await startRunner(undefined, {
      cachePublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
    const client = new RemoteVerificationRunnerClient({
      url: base,
      authSecret: AUTH_SECRET,
      maxWaitMs: 5_000,
    });
    await expect(client.execute(makeRequest())).rejects.toMatchObject({
      category: "cache_signature_invalid",
      retryable: false,
      diagnostics: [
        {
          phase: "admission",
          httpStatus: 400,
          responseCategory: "verification_cache_signature_invalid",
          reason: "http_error",
        },
      ],
    });
    const jobs = path.join(root, "jobs");
    const jobEntries = await readdir(jobs);
    expect(jobEntries).toEqual(["artifacts"]);
    const spoolEntries = await readdir(path.join(jobs, "artifacts"));
    expect(spoolEntries).toEqual([]);
  });

  it("preserves an approved protocol response category in bounded diagnostics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "runner_protocol_unsupported" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const client = new RemoteVerificationRunnerClient({
      url: "https://runner.invalid",
      authSecret: AUTH_SECRET,
      maxWaitMs: 1_000,
    });
    let caught: unknown;
    try {
      await client.execute(makeRequest());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      category: "runner_protocol_unsupported",
      retryable: false,
      diagnostics: [
        {
          phase: "admission",
          httpStatus: 400,
          responseCategory: "runner_protocol_unsupported",
          reason: "http_error",
        },
      ],
    });
  });

  it("maps an unknown admission response without persisting arbitrary response categories", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "provider_returned_untrusted_detail" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const client = new RemoteVerificationRunnerClient({
      url: "https://runner.invalid",
      authSecret: AUTH_SECRET,
      maxWaitMs: 1_000,
    });
    let caught: unknown;
    try {
      await client.execute(makeRequest());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      category: "runner_result_invalid",
      diagnostics: [
        {
          phase: "admission",
          httpStatus: 400,
          responseCategory: "unrecognized",
          reason: "http_error",
        },
      ],
    });
    expect(JSON.stringify(caught)).not.toContain("provider_returned_untrusted_detail");
  });

  it("reports only the safe field name for an accepted-job identity mismatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              jobId: "untrusted-job-id",
              requestFingerprint: "untrusted-request-fingerprint",
            }),
            { status: 202, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const client = new RemoteVerificationRunnerClient({
      url: "https://runner.invalid",
      authSecret: AUTH_SECRET,
      maxWaitMs: 1_000,
    });
    let caught: unknown;
    try {
      await client.execute(makeRequest());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      category: "runner_result_invalid",
      retryable: false,
      diagnostics: [
        {
          phase: "admission",
          httpStatus: 202,
          responseCategory: null,
          reason: "accepted_identity_mismatch",
          identityField: "jobId",
        },
      ],
      correlation: {
        jobId: expect.any(String),
        requestFingerprint: expect.any(String),
        admissionState: "unconfirmed",
      },
    });
    expect(JSON.stringify(caught)).not.toContain("untrusted-job-id");
    expect(JSON.stringify(caught)).not.toContain("untrusted-request-fingerprint");
  });

  it("records schema-invalid requests as not sent without making a network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = makeRequest();
    const malformed = { ...request, requestFingerprint: "not-a-fingerprint" };
    let caught: unknown;
    try {
      await new RemoteVerificationRunnerClient({
        url: "https://runner.invalid",
        authSecret: AUTH_SECRET,
        maxWaitMs: 1_000,
      }).execute(malformed);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      category: "runner_request_invalid",
      retryable: false,
      diagnostics: [
        {
          phase: "admission",
          httpStatus: null,
          reason: "request_schema_invalid",
        },
      ],
      correlation: {
        jobId: request.jobId,
        requestFingerprint: null,
        admissionState: "not_sent",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(caught)).not.toContain("not-a-fingerprint");
  });

  it("records an expired capability as not sent with a sanitized reason", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const issuedAt = Date.now() - 60_000;
    const request = makeRequest({ issuedAt, expiresAt: issuedAt + 1 });
    let caught: unknown;
    try {
      await new RemoteVerificationRunnerClient({
        url: "https://runner.invalid",
        authSecret: AUTH_SECRET,
        maxWaitMs: 1_000,
      }).execute(request);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      category: "runner_request_invalid",
      diagnostics: [{ phase: "admission", httpStatus: null, reason: "request_capability_expired" }],
      correlation: {
        jobId: request.jobId,
        requestFingerprint: request.requestFingerprint,
        admissionState: "not_sent",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records transport ambiguity as unconfirmed rather than not sent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("transport detail must not escape");
      }),
    );
    let caught: unknown;
    try {
      await new RemoteVerificationRunnerClient({
        url: "https://runner.invalid",
        authSecret: AUTH_SECRET,
        maxWaitMs: 1_000,
      }).execute(makeRequest());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      category: "runner_transport_ambiguous",
      retryable: true,
      correlation: {
        jobId: expect.any(String),
        requestFingerprint: expect.any(String),
        admissionState: "unconfirmed",
      },
    });
    expect(JSON.stringify(caught)).not.toContain("transport detail must not escape");
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
    ).rejects.toMatchObject({
      category: "runner_result_invalid",
      diagnostics: [
        {
          phase: "result_validation",
          httpStatus: 200,
          responseCategory: null,
          reason: "result_identity_mismatch",
          identityField: "baseCommitSha",
        },
      ],
    });
  });

  it("reports result-signature failure without exposing signature material", async () => {
    const { base } = await startRunner(async (request) => resultFor(request));
    const originalFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await originalFetch(input, init);
      if (response.status !== 200) return response;
      const body = await response.arrayBuffer();
      const headers = new Headers(response.headers);
      headers.set("x-auterim-result-signature", "0".repeat(64));
      return new Response(body, { status: 200, headers });
    });
    let caught: unknown;
    try {
      await new RemoteVerificationRunnerClient({
        url: base,
        authSecret: AUTH_SECRET,
        maxWaitMs: 5_000,
      }).execute(makeRequest());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      category: "runner_result_invalid",
      diagnostics: [
        {
          phase: "result_signature",
          httpStatus: 200,
          responseCategory: null,
          reason: "result_signature_mismatch",
        },
      ],
      correlation: {
        jobId: expect.any(String),
        requestFingerprint: expect.any(String),
        admissionState: "accepted",
      },
    });
    expect(JSON.stringify(caught)).not.toContain("0".repeat(64));
  });

  it("keeps direct terminal responses unconfirmed until signed result validation", async () => {
    const request = makeRequest();
    const materializedRequest = toMaterializedVerificationJob(request);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(resultFor(materializedRequest)), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    let caught: unknown;
    try {
      await new RemoteVerificationRunnerClient({
        url: "https://runner.invalid",
        authSecret: AUTH_SECRET,
        maxWaitMs: 1_000,
      }).execute(request);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      category: "runner_result_invalid",
      diagnostics: [
        {
          phase: "result_signature",
          httpStatus: 200,
          reason: "result_signature_missing",
        },
      ],
      correlation: {
        jobId: request.jobId,
        requestFingerprint: request.requestFingerprint,
        admissionState: "unconfirmed",
      },
    });
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
    await expect(client.execute(request)).rejects.toThrow("runner_result_invalid");
    expect(executions).toBe(0);
  });

  it("recovers a queued materialized job after restart without its expired signed URLs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "m1578r-runner-queued-restart-test-"));
    const jobStorePath = path.join(root, "jobs");
    const request = makeRequest();
    request.snapshot.url = request.snapshot.url.replace("token=local", "token=expired");
    request.patch.url = request.patch.url.replace("token=local", "token=expired");
    request.cacheArchive.url = request.cacheArchive.url.replace("token=local", "token=expired");
    const job = await persistTestSpool(path.join(jobStorePath, "artifacts"), request);
    await persistJobState(jobStorePath, request.jobId, {
      status: "queued",
      requestFingerprint: request.requestFingerprint,
    });
    let executions = 0;
    const runner = createVerificationRunnerServer({
      authSecret: AUTH_SECRET,
      artifactOrigin: "http://127.0.0.1:54321",
      cachePublicKey: CACHE_KEYS.publicKey.export({ type: "spki", format: "pem" }).toString(),
      jobStorePath,
      execute: async (admitted) => {
        executions += 1;
        expect(admitted.jobId).toBe(job.jobId);
        return resultFor(admitted);
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
      maxWaitMs: 5_000,
    });
    const first = await client.execute(request);
    const replay = await client.execute(request);
    expect(first.status).toBe("passed");
    expect(replay.jobId).toBe(job.jobId);
    expect(executions).toBe(1);
  });

  it("returns the same authenticated completed result after runner restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "m1578r-runner-completed-restart-test-"));
    const jobStorePath = path.join(root, "jobs");
    const request = makeRequest();
    let executions = 0;
    const cachePublicKey = CACHE_KEYS.publicKey.export({ type: "spki", format: "pem" }).toString();
    const firstRunner = createVerificationRunnerServer({
      authSecret: AUTH_SECRET,
      artifactOrigin: "http://127.0.0.1:54321",
      cachePublicKey,
      jobStorePath,
      materialize: async (admission, spoolRoot) => persistTestSpool(spoolRoot, admission),
      execute: async (admitted) => {
        executions += 1;
        return resultFor(admitted);
      },
    });
    const firstAddress = await firstRunner.listen(0, "127.0.0.1");
    let activeRunner = firstRunner;
    cleanups.push(async () => {
      await activeRunner.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    });
    const firstClient = new RemoteVerificationRunnerClient({
      url: `http://127.0.0.1:${firstAddress.port}`,
      authSecret: AUTH_SECRET,
      maxWaitMs: 5_000,
    });
    const result = await firstClient.execute(request);
    expect(executions).toBe(1);
    await firstRunner.close();

    const replayRunner = createVerificationRunnerServer({
      authSecret: AUTH_SECRET,
      artifactOrigin: "http://127.0.0.1:54321",
      cachePublicKey,
      jobStorePath,
      execute: async (admitted) => {
        executions += 1;
        return resultFor(admitted);
      },
    });
    const replayAddress = await replayRunner.listen(0, "127.0.0.1");
    activeRunner = replayRunner;
    const replay = await new RemoteVerificationRunnerClient({
      url: `http://127.0.0.1:${replayAddress.port}`,
      authSecret: AUTH_SECRET,
      maxWaitMs: 5_000,
    }).execute(request);
    expect(replay).toEqual(result);
    expect(executions).toBe(1);
  });

  it("removes only an incomplete admission directory after a runner crash", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "m1578r-runner-admission-restart-test-"));
    const jobStorePath = path.join(root, "jobs");
    const spoolRoot = path.join(jobStorePath, "artifacts");
    const staleAdmission = path.join(
      spoolRoot,
      `.${"a".repeat(64)}.12345678-1234-4123-8123-123456789abc.admitting`,
    );
    await mkdir(staleAdmission, { recursive: true });
    await writeFile(path.join(staleAdmission, "snapshot.tar.gz"), "incomplete");
    const runner = createVerificationRunnerServer({
      authSecret: AUTH_SECRET,
      artifactOrigin: "http://127.0.0.1:54321",
      cachePublicKey: "ed25519 test-only public key",
      jobStorePath,
      execute: async (job) => resultFor(job),
    });
    await runner.listen(0, "127.0.0.1");
    cleanups.push(async () => {
      await runner.close();
      await rm(root, { recursive: true, force: true });
    });
    await expect(lstat(staleAdmission)).rejects.toMatchObject({ code: "ENOENT" });
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
    ).rejects.toMatchObject({
      category: "runner_transport_ambiguous",
      retryable: true,
    });
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
    await expect(
      new RemoteVerificationRunnerClient({
        url: base,
        authSecret: AUTH_SECRET,
        maxWaitMs: 1_000,
      }).execute(third),
    ).rejects.toMatchObject({ category: "runner_queue_full", retryable: true });
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
