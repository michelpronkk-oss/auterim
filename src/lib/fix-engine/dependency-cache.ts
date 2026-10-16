import "server-only";
import { createHash, verify as verifySignature } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { resolveLockedPackageManager } from "@/lib/fix-engine/package-manager";

export const FIX_VERIFICATION_RUNTIME_PROFILE =
  "node24-linux-x64-alpine3.22-sha256-3e843c608bb5232f39ecb2b25e41214b958b0795914707374c8acc28487dea17";
const MAX_CACHE_FILES = 50_000;
const MAX_CACHE_BYTES = 512 * 1024 * 1024;

export type DependencyCacheIdentity = {
  repositoryId: string;
  repositoryIdentity: string;
  commitSha: string;
  packageManager: "npm" | "pnpm" | "yarn";
  packageManifestSha256: string;
  lockfileSha256: string;
  runtimeProfile: string;
};

export type TrustedDependencyCache = {
  status: "available";
  identity: DependencyCacheIdentity;
  identityKey: string;
  nodeModulesPath: string;
  treeSha256: string;
};

export type DependencyCacheResolution =
  | TrustedDependencyCache
  | { status: "unavailable"; reason: "cache_not_configured" | "cache_missing" }
  | {
      status: "rejected";
      reason:
        | "cache_identity_mismatch"
        | "cache_signature_invalid"
        | "cache_tree_invalid"
        | "cache_mutable";
    };

type SignedManifest = {
  schemaVersion: 1;
  identity: DependencyCacheIdentity;
  identityKey: string;
  treeSha256: string;
  fileCount: number;
  byteCount: number;
};

function sha256(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value: unknown) {
  return JSON.stringify(value);
}

export function createDependencyCacheIdentity(input: {
  repositoryId: string;
  repositoryIdentity: string;
  commitSha: string;
  packageJson: string;
  lockfiles: Record<string, string>;
  runtimeProfile?: string;
}): DependencyCacheIdentity | null {
  const lockNames = Object.keys(input.lockfiles).sort();
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(input.packageJson);
  } catch {
    return null;
  }
  const manager = resolveLockedPackageManager(packageJson, ["package.json", ...lockNames]);
  if (!manager || !/^[a-f0-9]{40,64}$/i.test(input.commitSha)) return null;
  const lockPayload = lockNames.map((name) => `${name}\0${input.lockfiles[name] ?? ""}`).join("\0");
  return {
    repositoryId: input.repositoryId,
    repositoryIdentity: input.repositoryIdentity.toLowerCase(),
    commitSha: input.commitSha.toLowerCase(),
    packageManager: manager,
    packageManifestSha256: sha256(input.packageJson),
    lockfileSha256: sha256(lockPayload),
    runtimeProfile: input.runtimeProfile ?? FIX_VERIFICATION_RUNTIME_PROFILE,
  };
}

export function dependencyCacheIdentityKey(identity: DependencyCacheIdentity) {
  return sha256(canonical(identity));
}

async function inspectDependencyTree(root: string, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files: Array<{ path: string; mode: number; sha256: string; bytes: number }> = [];
  let totalBytes = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(current, entry.name);
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) throw new Error("cache_tree_invalid");
    if ((info.mode & 0o222) !== 0) throw new Error("cache_mutable");
    if (info.isDirectory()) {
      const child = await inspectDependencyTree(root, fullPath);
      files.push(...child.files);
      totalBytes += child.byteCount;
    } else if (info.isFile()) {
      totalBytes += info.size;
      files.push({
        path: path.relative(root, fullPath).replaceAll("\\", "/"),
        mode: info.mode & 0o777,
        sha256: sha256(await readFile(fullPath)),
        bytes: info.size,
      });
    } else {
      throw new Error("cache_tree_invalid");
    }
    if (files.length > MAX_CACHE_FILES || totalBytes > MAX_CACHE_BYTES)
      throw new Error("cache_tree_invalid");
  }
  return { files, byteCount: totalBytes };
}

async function hashDependencyTree(root: string) {
  const inspected = await inspectDependencyTree(root);
  return {
    ...inspected,
    treeSha256: sha256(canonical(inspected.files)),
  };
}

/** Reads only a signed, immutable cache for this exact repository snapshot and validator runtime. */
export async function resolveTrustedDependencyCache(input: {
  root?: string;
  publicKey?: string;
  identity: DependencyCacheIdentity | null;
}): Promise<DependencyCacheResolution> {
  if (!input.root || !input.publicKey || !input.identity)
    return { status: "unavailable", reason: "cache_not_configured" };
  const base = path.resolve(input.root);
  const slot = path.join(
    base,
    input.identity.repositoryId,
    input.identity.commitSha,
    input.identity.runtimeProfile,
  );
  let slotPath: string;
  try {
    slotPath = await realpath(slot);
  } catch {
    return { status: "unavailable", reason: "cache_missing" };
  }
  if (!slotPath.startsWith(`${base}${path.sep}`))
    return { status: "rejected", reason: "cache_tree_invalid" };
  const nodeModulesPath = path.join(slotPath, "node_modules");
  try {
    const rootInfo = await lstat(slotPath);
    const dependencyInfo = await lstat(nodeModulesPath);
    if (
      rootInfo.isSymbolicLink() ||
      dependencyInfo.isSymbolicLink() ||
      !dependencyInfo.isDirectory()
    )
      return { status: "rejected", reason: "cache_tree_invalid" };
    if ((rootInfo.mode & 0o222) !== 0 || (dependencyInfo.mode & 0o222) !== 0)
      return { status: "rejected", reason: "cache_mutable" };
    const manifest = JSON.parse(
      await readFile(path.join(slotPath, "manifest.json"), "utf8"),
    ) as SignedManifest;
    const signature = Buffer.from(
      (await readFile(path.join(slotPath, "manifest.sig"), "utf8")).trim(),
      "base64",
    );
    if (
      manifest.schemaVersion !== 1 ||
      manifest.identityKey !== dependencyCacheIdentityKey(manifest.identity) ||
      manifest.identityKey !== dependencyCacheIdentityKey(input.identity) ||
      canonical(manifest.identity) !== canonical(input.identity)
    )
      return { status: "rejected", reason: "cache_identity_mismatch" };
    if (
      !verifySignature(null, Buffer.from(canonical(manifest), "utf8"), input.publicKey, signature)
    )
      return { status: "rejected", reason: "cache_signature_invalid" };
    const tree = await hashDependencyTree(nodeModulesPath);
    if (
      tree.treeSha256 !== manifest.treeSha256 ||
      tree.files.length !== manifest.fileCount ||
      tree.byteCount !== manifest.byteCount
    )
      return { status: "rejected", reason: "cache_tree_invalid" };
    return {
      status: "available",
      identity: manifest.identity,
      identityKey: manifest.identityKey,
      nodeModulesPath,
      treeSha256: tree.treeSha256,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "cache_mutable")
      return { status: "rejected", reason: "cache_mutable" };
    return { status: "rejected", reason: "cache_tree_invalid" };
  }
}

/** Test/build helper: canonical bytes that a trusted cache signer must sign. */
export function serializeDependencyCacheManifest(manifest: SignedManifest) {
  return canonical(manifest);
}

export async function inspectDependencyCacheTree(root: string) {
  return hashDependencyTree(root);
}

export const dependencyCacheManifestForSigning = (input: {
  identity: DependencyCacheIdentity;
  treeSha256: string;
  fileCount: number;
  byteCount: number;
}): SignedManifest => ({
  schemaVersion: 1,
  identity: input.identity,
  identityKey: dependencyCacheIdentityKey(input.identity),
  treeSha256: input.treeSha256,
  fileCount: input.fileCount,
  byteCount: input.byteCount,
});
