import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  DependencyCacheManifestSchema,
  MAX_ARTIFACT_BYTES,
  VerificationCommandSchema,
  VerificationJobIdentitySchema,
  canonicalJson,
  type VerificationJobRequest,
} from "./contracts.ts";

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const preparedArtifact = z
  .object({
    sha256: fingerprint,
    byteCount: z.number().int().positive(),
    fileName: z.enum(["snapshot.tar.gz", "patch.diff", "cache.tar.gz"]),
  })
  .strict();

export const MaterializedVerificationJobSchema = z
  .object({
    version: z.literal(1),
    jobId: fingerprint,
    requestFingerprint: fingerprint,
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    identity: VerificationJobIdentitySchema,
    commands: z.array(VerificationCommandSchema).min(1).max(5),
    snapshot: preparedArtifact,
    patch: preparedArtifact,
    cacheArchive: preparedArtifact,
    cacheManifest: DependencyCacheManifestSchema,
    cacheSignature: z.string().min(80).max(256),
  })
  .strict();

export type MaterializedVerificationJob = z.infer<typeof MaterializedVerificationJobSchema>;

export function toMaterializedVerificationJob(
  request: VerificationJobRequest,
): MaterializedVerificationJob {
  return MaterializedVerificationJobSchema.parse({
    version: 1,
    jobId: request.jobId,
    requestFingerprint: request.requestFingerprint,
    issuedAt: request.issuedAt,
    expiresAt: request.expiresAt,
    identity: request.identity,
    commands: request.commands,
    // The authenticated admission request contains signed URLs. Deliberately
    // copy only immutable artifact identity into the durable runner spool.
    snapshot: {
      sha256: request.snapshot.sha256,
      byteCount: request.snapshot.byteCount,
      fileName: "snapshot.tar.gz",
    },
    patch: {
      sha256: request.patch.sha256,
      byteCount: request.patch.byteCount,
      fileName: "patch.diff",
    },
    cacheArchive: {
      sha256: request.cacheArchive.sha256,
      byteCount: request.cacheArchive.byteCount,
      fileName: "cache.tar.gz",
    },
    cacheManifest: request.cacheManifest,
    cacheSignature: request.cacheSignature,
  });
}

function admissionMac(job: MaterializedVerificationJob, secret: string) {
  return createHmac("sha256", secret)
    .update(`m1578-materialized-job-v1\n${job.jobId}\n${canonicalJson(job)}`, "utf8")
    .digest("hex");
}

export async function persistMaterializedJobManifest(
  directory: string,
  job: MaterializedVerificationJob,
  secret: string,
) {
  const pathName = path.join(directory, "admission.json");
  const body = Buffer.from(
    canonicalJson({ version: 1, job, mac: admissionMac(job, secret) }),
    "utf8",
  );
  const handle = await open(pathName, "wx", 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const dirHandle = await open(directory, "r").catch(() => null);
  if (dirHandle) {
    try {
      await dirHandle.sync();
    } catch {
      // Some supported filesystems do not expose directory fsync.
    } finally {
      await dirHandle.close();
    }
  }
}

export async function readMaterializedJobManifest(
  directory: string,
  secret: string,
): Promise<MaterializedVerificationJob> {
  const bytes = await readFile(path.join(directory, "admission.json"));
  if (bytes.byteLength > 64 * 1024) throw new Error("verification_runner_spool_invalid");
  const envelope = z
    .object({ version: z.literal(1), job: MaterializedVerificationJobSchema, mac: fingerprint })
    .strict()
    .parse(JSON.parse(bytes.toString("utf8")));
  if (path.basename(directory) !== envelope.job.jobId)
    throw new Error("verification_runner_spool_identity_mismatch");
  const expected = Buffer.from(admissionMac(envelope.job, secret), "hex");
  const supplied = Buffer.from(envelope.mac, "hex");
  if (expected.byteLength !== supplied.byteLength || !timingSafeEqual(expected, supplied))
    throw new Error("verification_runner_spool_authentication_failed");
  return envelope.job;
}

export async function assertMaterializedArtifact(
  directory: string,
  artifact: MaterializedVerificationJob["snapshot"],
) {
  const file = path.join(directory, artifact.fileName);
  if (path.dirname(file) !== path.resolve(directory))
    throw new Error("verification_runner_spool_path_invalid");
  const info = await lstat(file).catch(() => null);
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    info.size !== artifact.byteCount ||
    info.size > MAX_ARTIFACT_BYTES
  )
    throw new Error("verification_runner_spool_artifact_invalid");
  const digest = createHash("sha256");
  let byteCount = 0;
  try {
    for await (const chunk of createReadStream(file)) {
      byteCount += chunk.byteLength;
      if (byteCount > artifact.byteCount || byteCount > MAX_ARTIFACT_BYTES)
        throw new Error("verification_runner_spool_artifact_invalid");
      digest.update(chunk);
    }
  } catch {
    throw new Error("verification_runner_spool_artifact_invalid");
  }
  if (byteCount !== artifact.byteCount || digest.digest("hex") !== artifact.sha256)
    throw new Error("verification_runner_spool_artifact_invalid");
  return file;
}
