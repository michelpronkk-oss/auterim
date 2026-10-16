import "server-only";
import { verify as verifySignature } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  DependencyCacheManifestSchema,
  MAX_CACHE_ARCHIVE_BYTES,
  canonicalJson,
  dependencyCacheManifestFingerprint,
  sha256,
  type DependencyCacheManifestV2,
} from "../../../verification-runner/contracts";
import {
  dependencyCacheIdentityKey,
  type DependencyCacheIdentity,
} from "@/lib/fix-engine/dependency-cache";
import { packSafeDirectory } from "../../../verification-runner/archive";

const BUCKET = "fix-engine-verification-artifacts";
const SNAPSHOT_MAX_BYTES = 25 * 1024 * 1024;

export type PrivateArtifactReference = {
  bucket: string;
  path: string;
  sha256: string;
  byteCount: number;
  signedUrl: string;
};

export type SignedDependencyCacheReference = {
  manifest: DependencyCacheManifestV2;
  signature: string;
  archive: PrivateArtifactReference;
};

function artifactPath(kind: "snapshot" | "cache", pathValue: string) {
  if (kind === "snapshot" && /^snapshots\/[0-9a-f-]{36}\/[a-f0-9]{64}\.tar\.gz$/i.test(pathValue))
    return true;
  if (
    kind === "cache" &&
    /^caches\/[0-9a-f-]{36}\/[a-f0-9]{40,64}\/[a-f0-9]{64}\/(?:manifest\.json|manifest\.sig|dependencies\.tar\.gz)$/i.test(
      pathValue,
    )
  )
    return true;
  return false;
}

function assertFingerprint(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("verification_artifact_fingerprint_invalid");
}

async function makeSignedUrl(bucket: string, objectPath: string, expiresIn = 600) {
  const { data, error } = await createSupabaseServerClient()
    .storage.from(bucket)
    .createSignedUrl(objectPath, expiresIn);
  if (error || !data?.signedUrl) throw new Error("verification_artifact_sign_failed");
  return data.signedUrl;
}

export async function putPrivateSnapshotArtifact(input: {
  fixRunId: string;
  jobId: string;
  bytes: Buffer;
}) {
  if (!/^[0-9a-f-]{36}$/i.test(input.fixRunId) || !/^[a-f0-9]{64}$/.test(input.jobId))
    throw new Error("verification_snapshot_identity_invalid");
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > SNAPSHOT_MAX_BYTES)
    throw new Error("verification_snapshot_size_invalid");
  const fingerprint = sha256(input.bytes);
  const path = `snapshots/${input.fixRunId}/${input.jobId}.tar.gz`;
  const store = createSupabaseServerClient().storage.from(BUCKET);
  const uploaded = await store.upload(path, input.bytes, {
    contentType: "application/gzip",
    upsert: false,
    cacheControl: "0",
  });
  if (uploaded.error) {
    const existing = await store.download(path);
    if (
      existing.error ||
      !existing.data ||
      existing.data.size !== input.bytes.byteLength ||
      existing.data.size > SNAPSHOT_MAX_BYTES ||
      sha256(Buffer.from(await existing.data.arrayBuffer())) !== fingerprint
    )
      throw new Error("verification_snapshot_upload_conflict");
  }
  return {
    bucket: BUCKET,
    path,
    sha256: fingerprint,
    byteCount: input.bytes.byteLength,
    signedUrl: await makeSignedUrl(BUCKET, path),
  } satisfies PrivateArtifactReference;
}

export async function createPrivateBaseSnapshotArtifact(input: {
  fixRunId: string;
  checkoutPath: string;
}) {
  const temporary = await mkdtemp(path.join(tmpdir(), "auterim-fix-snapshot-artifact-"));
  const archivePath = path.join(temporary, "snapshot.tar.gz");
  try {
    await packSafeDirectory(input.checkoutPath, archivePath, {
      maxFiles: 50_000,
      maxBytes: SNAPSHOT_MAX_BYTES,
    });
    const bytes = await readFile(archivePath);
    const fingerprint = sha256(bytes);
    return await putPrivateSnapshotArtifact({
      fixRunId: input.fixRunId,
      jobId: fingerprint,
      bytes,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {
      throw new Error("verification_snapshot_temp_cleanup_failed");
    });
  }
}

export async function removePrivateVerificationArtifact(path: string) {
  if (!/^snapshots\/[0-9a-f-]{36}\/[a-f0-9]{64}\.tar\.gz$/i.test(path))
    throw new Error("verification_artifact_path_invalid");
  const { error } = await createSupabaseServerClient().storage.from(BUCKET).remove([path]);
  if (error) throw new Error("verification_snapshot_cleanup_failed");
}

export function dependencyCacheObjectPrefix(identity: DependencyCacheIdentity) {
  return `caches/${identity.repositoryId}/${identity.commitSha}/${dependencyCacheIdentityKey(identity)}`;
}

export async function putSignedDependencyCacheArtifacts(input: {
  identity: DependencyCacheIdentity;
  manifest: DependencyCacheManifestV2;
  signature: Buffer;
  archive: Buffer;
}) {
  const prefix = dependencyCacheObjectPrefix(input.identity);
  if (
    input.manifest.identityKey !== dependencyCacheIdentityKey(input.identity) ||
    input.manifest.manifestFingerprint !== dependencyCacheManifestFingerprint(input.manifest) ||
    input.manifest.artifactFingerprint !== input.manifest.archiveSha256 ||
    input.manifest.buildStatus !== "complete" ||
    input.manifest.signatureAlgorithm !== "ed25519" ||
    input.archive.byteLength < 1 ||
    input.archive.byteLength > MAX_CACHE_ARCHIVE_BYTES ||
    input.archive.byteLength !== input.manifest.archiveByteCount ||
    sha256(input.archive) !== input.manifest.archiveSha256 ||
    input.signature.byteLength < 64 ||
    input.signature.byteLength > 128
  )
    throw new Error("verification_cache_artifact_invalid");
  const store = createSupabaseServerClient().storage.from(BUCKET);
  const objects = [
    {
      path: `${prefix}/manifest.json`,
      bytes: Buffer.from(canonicalJson(input.manifest)),
      contentType: "application/json",
    },
    {
      path: `${prefix}/manifest.sig`,
      bytes: Buffer.from(input.signature.toString("base64"), "utf8"),
      contentType: "application/octet-stream",
    },
    {
      path: `${prefix}/dependencies.tar.gz`,
      bytes: input.archive,
      contentType: "application/gzip",
    },
  ];
  for (const object of objects) {
    const { error } = await store.upload(object.path, object.bytes, {
      contentType: object.contentType,
      upsert: false,
      cacheControl: "31536000, immutable",
    });
    if (error) {
      const existing = await store.download(object.path);
      if (
        existing.error ||
        !existing.data ||
        existing.data.size !== object.bytes.byteLength ||
        sha256(Buffer.from(await existing.data.arrayBuffer())) !== sha256(object.bytes)
      )
        throw new Error("verification_cache_artifact_conflict");
    }
  }
  return { prefix, identityKey: input.manifest.identityKey, treeSha256: input.manifest.treeSha256 };
}

async function readObject(path: string, maxBytes: number) {
  const { data, error } = await createSupabaseServerClient().storage.from(BUCKET).download(path);
  if (error || !data || data.size > maxBytes)
    throw new Error("verification_cache_artifact_unavailable");
  const bytes = Buffer.from(await data.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("verification_cache_artifact_size_invalid");
  return bytes;
}

export async function createSignedDependencyCacheReference(input: {
  identity: DependencyCacheIdentity;
  publicKey: string;
}): Promise<SignedDependencyCacheReference> {
  const prefix = dependencyCacheObjectPrefix(input.identity);
  if (!artifactPath("cache", `${prefix}/manifest.json`))
    throw new Error("verification_cache_identity_invalid");
  let manifest: DependencyCacheManifestV2;
  let signature: Buffer;
  let manifestText: string;
  try {
    const [manifestBytes, signatureBytes] = await Promise.all([
      readObject(`${prefix}/manifest.json`, 16 * 1024),
      readObject(`${prefix}/manifest.sig`, 128),
    ]);
    manifestText = manifestBytes.toString("utf8");
    manifest = DependencyCacheManifestSchema.parse(JSON.parse(manifestText));
    signature = Buffer.from(signatureBytes.toString("utf8").trim(), "base64");
  } catch {
    throw new Error("verification_cache_artifact_unavailable");
  }
  const serialized = canonicalJson(manifest);
  if (
    canonicalJson(manifest.identity) !== canonicalJson(input.identity) ||
    manifest.identityKey !== dependencyCacheIdentityKey(input.identity) ||
    manifest.manifestFingerprint !== dependencyCacheManifestFingerprint(manifest) ||
    manifest.artifactFingerprint !== manifest.archiveSha256 ||
    manifest.buildStatus !== "complete" ||
    manifest.signatureAlgorithm !== "ed25519" ||
    serialized !== manifestText! ||
    !verifySignature(null, Buffer.from(serialized), input.publicKey, signature)
  )
    throw new Error("verification_cache_signature_invalid");
  const archivePath = `${prefix}/dependencies.tar.gz`;
  const signedUrl = await makeSignedUrl(BUCKET, archivePath);
  assertFingerprint(manifest.archiveSha256);
  return {
    manifest,
    signature: signature.toString("base64"),
    archive: {
      bucket: BUCKET,
      path: archivePath,
      sha256: manifest.archiveSha256,
      byteCount: manifest.archiveByteCount,
      signedUrl,
    } satisfies PrivateArtifactReference,
  };
}
