import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createClient } from "@supabase/supabase-js";
import { buildSignedNpmDependencyCache } from "../verification-runner/cache-builder.ts";
import {
  canonicalJson,
  DependencyCacheManifestSchema,
  dependencyCacheManifestFingerprint,
  sha256,
} from "../verification-runner/contracts.ts";
import { extractSafeTarGzip } from "../verification-runner/archive.ts";
import {
  createDependencyCacheIdentity,
  dependencyCacheIdentityKey,
} from "../src/lib/fix-engine/cache-identity.ts";

const EXPECTED_PROJECT_REF = "lnljaacbptrubppoypaz";
const BUCKET = "fix-engine-verification-artifacts";
const [repositoryId, repositoryIdentity, commitSha, sourcePath] = process.argv.slice(2);

function fail(category: string): never {
  throw new Error(category);
}

if (
  !/^[0-9a-f-]{36}$/i.test(repositoryId ?? "") ||
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryIdentity ?? "") ||
  !/^[a-f0-9]{40,64}$/i.test(commitSha ?? "") ||
  !sourcePath ||
  !path.isAbsolute(sourcePath)
)
  fail("dependency_cache_builder_arguments_invalid");

const urlText = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey =
  process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const signingKey = process.env.FIX_DEPENDENCY_CACHE_SIGNING_PRIVATE_KEY;
if (!urlText || !serviceKey || !signingKey) fail("dependency_cache_builder_not_configured");

const url = new URL(urlText);
const local = ["localhost", "127.0.0.1"].includes(url.hostname);
if (!local) {
  const projectRef = await readFile("supabase/.temp/project-ref", "utf8").catch(() => "");
  if (projectRef.trim() !== EXPECTED_PROJECT_REF)
    fail("dependency_cache_builder_project_identity_mismatch");
  if (url.hostname !== `${EXPECTED_PROJECT_REF}.supabase.co`)
    fail("dependency_cache_builder_supabase_url_mismatch");
  try {
    execFileSync(process.execPath, ["--experimental-strip-types", "scripts/project-check.mts"], {
      stdio: "ignore",
      timeout: 60_000,
    });
  } catch {
    fail("dependency_cache_builder_project_check_failed");
  }
}

const root = path.resolve(sourcePath);
const packageText = await readFile(path.join(root, "package.json"), "utf8").catch(() =>
  fail("dependency_cache_package_manifest_missing"),
);
const lockNames = ["package-lock.json", "npm-shrinkwrap.json"].filter((name) => {
  try {
    return existsSync(path.join(root, name));
  } catch {
    return false;
  }
});
if (lockNames.length !== 1) fail("dependency_cache_lockfile_unsupported");
const lockText = await readFile(path.join(root, lockNames[0]!), "utf8");
const identity = createDependencyCacheIdentity({
  repositoryId,
  repositoryIdentity: repositoryIdentity.toLowerCase(),
  commitSha: commitSha.toLowerCase(),
  packageJson: packageText,
  lockfiles: { [lockNames[0]!]: lockText },
});
if (!identity || identity.packageManager !== "npm") fail("dependency_cache_profile_unsupported");

const client = createClient(urlText, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data: buckets, error: bucketError } = await client.storage.listBuckets();
if (bucketError) fail("dependency_cache_bucket_unavailable");
const bucket = buckets?.find((candidate) => candidate.id === BUCKET);
if (!bucket || bucket.public) fail("dependency_cache_bucket_not_private");

const identityKey = dependencyCacheIdentityKey(identity);
const prefix = `caches/${identity.repositoryId}/${identity.commitSha}/${identityKey}`;
const store = client.storage.from(BUCKET);
const { data: existing, error: listError } = await store.list(prefix, { limit: 10 });
if (listError) fail("dependency_cache_lookup_failed");

async function verifyExistingCache() {
  const names = new Set((existing ?? []).map((entry) => entry.name));
  const requiredNames = ["manifest.json", "manifest.sig", "dependencies.tar.gz"];
  if (requiredNames.some((name) => !names.has(name)) || names.size !== requiredNames.length)
    fail("dependency_cache_existing_artifact_incomplete");
  const [manifestDownload, signatureDownload, archiveDownload] = await Promise.all([
    store.download(`${prefix}/manifest.json`),
    store.download(`${prefix}/manifest.sig`),
    store.download(`${prefix}/dependencies.tar.gz`),
  ]);
  if (
    manifestDownload.error ||
    signatureDownload.error ||
    archiveDownload.error ||
    !manifestDownload.data ||
    !signatureDownload.data ||
    !archiveDownload.data
  )
    fail("dependency_cache_existing_artifact_unavailable");
  const manifestText = await manifestDownload.data.text();
  const manifest = DependencyCacheManifestSchema.parse(JSON.parse(manifestText));
  const signatureText = (await signatureDownload.data.text()).trim();
  const signature = Buffer.from(signatureText, "base64");
  const archive = Buffer.from(await archiveDownload.data.arrayBuffer());
  const publicKey = createPublicKey(createPrivateKey(signingKey!));
  if (
    canonicalJson(manifest) !== manifestText ||
    canonicalJson(manifest.identity) !== canonicalJson(identity) ||
    manifest.identityKey !== identityKey ||
    manifest.buildStatus !== "complete" ||
    manifest.artifactFingerprint !== manifest.archiveSha256 ||
    manifest.manifestFingerprint !== dependencyCacheManifestFingerprint(manifest) ||
    sha256(archive) !== manifest.archiveSha256 ||
    archive.byteLength !== manifest.archiveByteCount ||
    !verify(null, Buffer.from(manifestText), publicKey, signature)
  )
    fail("dependency_cache_existing_artifact_invalid");
  const temp = await mkdtemp(path.join(os.tmpdir(), "auterim-cache-reuse-check-"));
  try {
    const archivePath = path.join(temp, "cache.tar.gz");
    const nodeModules = path.join(temp, "node_modules");
    const { writeFile, mkdir } = await import("node:fs/promises");
    await writeFile(archivePath, archive);
    await mkdir(nodeModules);
    await extractSafeTarGzip(archivePath, nodeModules, {
      maxFiles: 50_000,
      maxBytes: 512 * 1024 * 1024,
    });
    const files: Array<{ path: string; mode: number; sha256: string; bytes: number }> = [];
    let byteCount = 0;
    const visit = async (current: string): Promise<void> => {
      for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const target = path.join(current, entry.name);
        const stat = await lstat(target);
        if (stat.isSymbolicLink()) fail("dependency_cache_existing_tree_invalid");
        if (stat.isDirectory()) await visit(target);
        else if (stat.isFile()) {
          byteCount += stat.size;
          files.push({
            path: path.relative(nodeModules, target).replaceAll("\\", "/"),
            mode: stat.mode & 0o777,
            sha256: sha256(await readFile(target)),
            bytes: stat.size,
          });
        } else fail("dependency_cache_existing_tree_invalid");
      }
    };
    await visit(nodeModules);
    if (
      sha256(canonicalJson(files)) !== manifest.treeSha256 ||
      files.length !== manifest.fileCount ||
      byteCount !== manifest.byteCount
    )
      fail("dependency_cache_existing_tree_invalid");
    return { treeSha256: manifest.treeSha256, artifactBytes: manifest.archiveByteCount };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if ((existing ?? []).length > 0) {
  const verified = await verifyExistingCache();
  process.stdout.write(JSON.stringify({ status: "reused", identityKey, ...verified }) + "\n");
} else {
  const built = await buildSignedNpmDependencyCache({
    sourceRepositoryPath: sourcePath,
    identity: {
      repositoryId,
      repositoryIdentity: repositoryIdentity.toLowerCase(),
      commitSha: commitSha.toLowerCase(),
    },
    signingPrivateKey: signingKey,
  });
  try {
    const objects = [
      {
        path: `${prefix}/manifest.json`,
        bytes: Buffer.from(canonicalJson(built.manifest)),
        contentType: "application/json",
      },
      {
        path: `${prefix}/manifest.sig`,
        bytes: Buffer.from(built.signature.toString("base64"), "utf8"),
        contentType: "application/octet-stream",
      },
      {
        path: `${prefix}/dependencies.tar.gz`,
        bytes: built.archive,
        contentType: "application/gzip",
      },
    ];
    for (const object of objects) {
      const { error } = await store.upload(object.path, object.bytes, {
        contentType: object.contentType,
        upsert: false,
        cacheControl: "31536000, immutable",
      });
      if (error) fail("dependency_cache_artifact_conflict");
    }
    process.stdout.write(
      JSON.stringify({
        status: "persisted",
        identityKey: built.manifest.identityKey,
        treeSha256: built.manifest.treeSha256,
        archiveSha256: built.manifest.archiveSha256,
        artifactBytes: built.manifest.archiveByteCount,
      }) + "\n",
    );
  } finally {
    await rm(built.outputDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
