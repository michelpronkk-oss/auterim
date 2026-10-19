import { createHash } from "node:crypto";
import { z } from "zod";

export const VERIFICATION_RUNNER_PROTOCOL_VERSION = "m1578-verification-runner-v1";
export const VERIFICATION_RUNNER_IDENTITY_ATTESTATION_PATH = "/v1/identity-attestation";
export const VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF =
  "auterim-verification-runner:m1578r-self-id-20261019-03";
export const VERIFICATION_RUNNER_IDENTITY_MOUNT_PATH = "/run/auterim-verifier-identity";
export const VERIFICATION_RUNNER_IDENTITY_FILE = "identity.json";
export const VERIFICATION_RUNNER_IDENTITY_GROUP_GID = 62000;
export const VERIFICATION_RUNNER_IDENTITY_MAX_AGE_MS = 5 * 60_000;
export const VERIFICATION_RUNNER_IMAGE =
  "node:24.8.0-alpine3.22@sha256:3e843c608bb5232f39ecb2b25e41214b958b0795914707374c8acc28487dea17";
export const MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024;
export const MAX_PATCH_BYTES = 128 * 1024;
export const MAX_CACHE_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_ARCHIVE_FILES = 50_000;
export const MAX_ARCHIVE_EXPANDED_BYTES = 512 * 1024 * 1024;

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const commitSha = z.string().regex(/^[a-f0-9]{40,64}$/i);
const uuid = z.string().uuid();

export const VerificationRunnerIdentityAttestationRequestSchema = z
  .object({ nonce: fingerprint })
  .strict();
export type VerificationRunnerIdentityAttestationRequest = z.infer<
  typeof VerificationRunnerIdentityAttestationRequestSchema
>;

export const VerificationRunnerIdentityAttestationBodySchema = z
  .object({
    nonce: fingerprint,
    issuedAt: z.number().int().positive(),
    identityFetchedAt: z.number().int().positive(),
    instanceIdentityDocument: z.string().min(1).max(8_192),
    instanceIdentitySignature: z.string().min(128).max(2_048),
    containerImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    containerImageRef: z.literal(VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF),
  })
  .strict();
export type VerificationRunnerIdentityAttestationBody = z.infer<
  typeof VerificationRunnerIdentityAttestationBodySchema
>;

export const VerificationRunnerHostIdentityFileSchema = z
  .object({
    document: z.string().min(1).max(8_192),
    signature: z.string().min(128).max(2_048),
    fetchedAt: z.number().int().positive(),
  })
  .strict();
const artifact = z
  .object({
    url: z.string().url().max(4096),
    sha256: fingerprint,
    byteCount: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
  })
  .strict();

export const VerificationCommandSchema = z
  .object({
    commandClass: z.enum(["targeted_test", "test", "typecheck", "lint", "build"]),
    executable: z.literal("node"),
    args: z.array(z.string().min(1).max(512)).min(2).max(24),
  })
  .strict();
export type RunnerVerificationCommand = z.infer<typeof VerificationCommandSchema>;

export const DependencyCacheManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    buildStatus: z.literal("complete"),
    identity: z
      .object({
        repositoryId: uuid,
        repositoryIdentity: z.string().min(3).max(511),
        commitSha,
        packageManager: z.literal("npm"),
        packageManifestSha256: fingerprint,
        lockfileSha256: fingerprint,
        runtimeProfile: z.string().min(1).max(256),
      })
      .strict(),
    identityKey: fingerprint,
    treeSha256: fingerprint,
    archiveSha256: fingerprint,
    artifactFingerprint: fingerprint,
    manifestFingerprint: fingerprint,
    signatureAlgorithm: z.literal("ed25519"),
    createdAt: z.string().datetime(),
    fileCount: z.number().int().min(1).max(MAX_ARCHIVE_FILES),
    byteCount: z.number().int().min(1).max(MAX_ARCHIVE_EXPANDED_BYTES),
    archiveByteCount: z.number().int().min(1).max(MAX_CACHE_ARCHIVE_BYTES),
  })
  .strict();
export type DependencyCacheManifestV2 = z.infer<typeof DependencyCacheManifestSchema>;

export const VerificationJobIdentitySchema = z
  .object({
    protocolVersion: z.literal(VERIFICATION_RUNNER_PROTOCOL_VERSION),
    workspaceId: uuid,
    productId: uuid.nullable(),
    fixRunId: uuid,
    planId: uuid,
    planFingerprint: fingerprint,
    evidenceFingerprint: fingerprint,
    patchId: uuid,
    patchFingerprint: fingerprint,
    patchArtifactPath: z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.diff$/i),
    allowedPaths: z.array(z.string().min(1).max(1024)).min(1).max(25),
    repositoryId: uuid,
    repositoryIdentity: z.string().min(3).max(511),
    baseCommitSha: commitSha,
    packageManager: z.literal("npm"),
    packageManifestSha256: fingerprint,
    lockfileSha256: fingerprint,
    runtimeProfile: z.string().min(1).max(256),
    profileId: z.literal("javascript-typescript-v1"),
    profileVersion: z.literal("javascript-typescript-v1"),
    commandClasses: z.array(VerificationCommandSchema.shape.commandClass).min(1).max(5),
    image: z.literal(VERIFICATION_RUNNER_IMAGE),
    cacheIdentityKey: fingerprint,
    cacheTreeSha256: fingerprint,
    snapshotFingerprint: fingerprint,
  })
  .strict()
  .refine((identity) => identity.patchArtifactPath.startsWith(`${identity.fixRunId}/`));
export type VerificationJobIdentity = z.infer<typeof VerificationJobIdentitySchema>;

export const VerificationJobRequestSchema = z
  .object({
    jobId: fingerprint,
    requestFingerprint: fingerprint,
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    identity: VerificationJobIdentitySchema,
    commands: z.array(VerificationCommandSchema).min(1).max(5),
    snapshot: artifact,
    patch: artifact,
    cacheArchive: artifact,
    cacheManifest: DependencyCacheManifestSchema,
    cacheSignature: z.string().min(80).max(256),
  })
  .strict();
export type VerificationJobRequest = z.infer<typeof VerificationJobRequestSchema>;

export const VerificationCommandResultSchema = z
  .object({
    commandClass: VerificationCommandSchema.shape.commandClass,
    status: z.enum(["passed", "failed"]),
    durationMs: z.number().int().min(0).max(120_000),
    outputBytes: z
      .number()
      .int()
      .min(0)
      .max(64 * 1024),
    diagnosticCategory: z
      .enum([
        "verification_command_failed",
        "verification_timeout",
        "verification_output_exceeded",
        "verification_runtime_failed",
      ])
      .nullable(),
  })
  .strict();

export const VerificationJobResultSchema = z
  .object({
    protocolVersion: z.literal(VERIFICATION_RUNNER_PROTOCOL_VERSION),
    runnerVersion: z.literal("m1578-runner-v1"),
    runtimeImage: z.literal(VERIFICATION_RUNNER_IMAGE),
    profileId: z.literal("javascript-typescript-v1"),
    profileVersion: z.literal("javascript-typescript-v1"),
    jobId: fingerprint,
    requestFingerprint: fingerprint,
    workspaceId: uuid,
    productId: uuid.nullable(),
    repositoryId: uuid,
    repositoryIdentity: z.string().min(3).max(511),
    baseCommitSha: commitSha,
    patchId: uuid,
    status: z.enum(["passed", "failed"]),
    checks: z.array(VerificationCommandResultSchema).min(1).max(5),
    durationMs: z.number().int().min(0).max(3_600_000),
    snapshotFingerprint: fingerprint,
    patchFingerprint: fingerprint,
    cacheIdentityKey: fingerprint,
    cacheTreeSha256: fingerprint,
    outputFingerprint: fingerprint,
    resultFingerprint: fingerprint,
  })
  .strict();
export type VerificationJobResult = z.infer<typeof VerificationJobResultSchema>;

export function canonicalJson(value: unknown) {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

export function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

export function verificationJobIdentityFingerprint(identity: VerificationJobIdentity) {
  return sha256(canonicalJson(identity));
}

export function verificationRequestFingerprint(input: {
  identity: VerificationJobIdentity;
  commands: RunnerVerificationCommand[];
  snapshot: { sha256: string; byteCount: number };
  patch: { sha256: string; byteCount: number };
  cacheArchive: { sha256: string; byteCount: number };
  cacheManifest: DependencyCacheManifestV2;
  cacheSignature: string;
}) {
  return sha256(canonicalJson(input));
}

export function verificationResultSignatureInput(jobId: string, resultBodySha256: string) {
  return `${VERIFICATION_RUNNER_PROTOCOL_VERSION}\n${jobId}\n${resultBodySha256}`;
}

export function dependencyCacheManifestFingerprint(manifest: DependencyCacheManifestV2) {
  const payload = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== "manifestFingerprint"),
  );
  return sha256(canonicalJson(payload));
}

export function assertSafeVerificationCommand(command: RunnerVerificationCommand) {
  const [entrypoint, ...args] = command.args;
  const allowed = new Set([
    "node_modules/vitest/vitest.mjs",
    "node_modules/jest/bin/jest.js",
    "node_modules/typescript/bin/tsc",
    "node_modules/eslint/bin/eslint.js",
    "node_modules/next/dist/bin/next",
  ]);
  if (!allowed.has(entrypoint ?? "") || args.some((arg) => /[;&|<>`$\n\r]/.test(arg)))
    throw new Error("verification_command_unsupported");
  if (
    command.commandClass === "targeted_test" &&
    args.some((arg) => arg.startsWith("/") || arg.split("/").includes(".."))
  )
    throw new Error("verification_command_unsupported");
}
