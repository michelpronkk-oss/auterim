import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDependencyCacheIdentity,
  dependencyCacheManifestForSigning,
  inspectDependencyCacheTree,
  resolveTrustedDependencyCache,
  serializeDependencyCacheManifest,
} from "@/lib/fix-engine/dependency-cache";
import { FIX_VERIFICATION_NETWORK_MODE } from "@/lib/fix-engine/sandbox";

const rootPaths: string[] = [];
const repositoryId = "30000000-0000-4000-8000-000000000001";
const commitSha = "a".repeat(40);
const packageJson = JSON.stringify({ name: "cache-fixture", devDependencies: { vitest: "1.0.0" } });
const lockfiles = { "package-lock.json": "deterministic-fixture-lock-v1" };
const keys = generateKeyPairSync("ed25519");

afterEach(async () => {
  await Promise.all(rootPaths.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeCache(input: {
  mutable?: boolean;
  identityOverride?: ReturnType<typeof createDependencyCacheIdentity>;
}) {
  const root = await mkdtemp(path.join(process.env.TEMP ?? process.cwd(), "m1578-cache-test-"));
  rootPaths.push(root);
  const identity =
    input.identityOverride ??
    createDependencyCacheIdentity({
      repositoryId,
      repositoryIdentity: "michelpronkk-oss/auterim",
      commitSha,
      packageJson,
      lockfiles,
    });
  if (!identity) throw new Error("fixture_dependency_cache_identity_invalid");
  const slot = path.join(root, repositoryId, commitSha, identity.runtimeProfile);
  const modules = path.join(slot, "node_modules", "vitest");
  await mkdir(modules, { recursive: true });
  const fixtureEntry = path.join(modules, "vitest.mjs");
  await writeFile(fixtureEntry, "if (process.argv[2] !== 'run') process.exit(1);\n");
  await chmod(fixtureEntry, 0o444);
  await chmod(modules, 0o555);
  await chmod(path.join(slot, "node_modules"), 0o555);
  const tree = await inspectDependencyCacheTree(path.join(slot, "node_modules"));
  const manifest = dependencyCacheManifestForSigning({
    identity,
    treeSha256: tree.treeSha256,
    fileCount: tree.files.length,
    byteCount: tree.byteCount,
  });
  await writeFile(path.join(slot, "manifest.json"), serializeDependencyCacheManifest(manifest));
  await writeFile(
    path.join(slot, "manifest.sig"),
    sign(null, Buffer.from(serializeDependencyCacheManifest(manifest)), keys.privateKey).toString(
      "base64",
    ),
  );
  await chmod(path.join(slot, "manifest.json"), 0o444);
  await chmod(path.join(slot, "manifest.sig"), 0o444);
  if (input.mutable) await chmod(fixtureEntry, 0o644);
  else await chmod(slot, 0o555);
  return { root, identity };
}

describe("M15.78 trusted dependency cache", () => {
  it("accepts only a signed immutable cache with an exact repository/commit/lock identity", async () => {
    const { root, identity } = await makeCache({});
    const resolved = await resolveTrustedDependencyCache({
      root,
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      identity,
    });
    expect(resolved.status).toBe("available");
    if (resolved.status === "available") {
      expect(resolved.identity).toEqual(identity);
      expect(resolved.identityKey).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(FIX_VERIFICATION_NETWORK_MODE).toBe("none");
  });

  it("reports an absent cache as unavailable without falling back to host dependencies", async () => {
    const { root, identity } = await makeCache({});
    const result = await resolveTrustedDependencyCache({
      root: `${root}-missing`,
      publicKey: "unused",
      identity,
    });
    expect(result).toEqual({ status: "unavailable", reason: "cache_missing" });
  });

  it("rejects a cache whose package/lock identity differs", async () => {
    const { root } = await makeCache({});
    const wrong = createDependencyCacheIdentity({
      repositoryId,
      repositoryIdentity: "michelpronkk-oss/auterim",
      commitSha,
      packageJson,
      lockfiles: { "package-lock.json": "different-lock" },
    });
    const result = await resolveTrustedDependencyCache({
      root,
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      identity: wrong,
    });
    expect(result).toEqual({ status: "rejected", reason: "cache_identity_mismatch" });
  });

  it("rejects cache content from a different provider repository", async () => {
    const { root, identity } = await makeCache({});
    const wrongRepository = { ...identity, repositoryIdentity: "another-owner/another-repo" };
    const result = await resolveTrustedDependencyCache({
      root,
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      identity: wrongRepository,
    });
    expect(result).toEqual({ status: "rejected", reason: "cache_identity_mismatch" });
  });

  it("does not construct cache identity from competing lockfile families", () => {
    expect(
      createDependencyCacheIdentity({
        repositoryId,
        repositoryIdentity: "michelpronkk-oss/auterim",
        commitSha,
        packageJson,
        lockfiles: {
          "package-lock.json": "npm-lock",
          "pnpm-lock.yaml": "pnpm-lock",
        },
      }),
    ).toBeNull();
  });

  it("rejects a writable dependency cache", async () => {
    const { root, identity } = await makeCache({ mutable: true });
    const result = await resolveTrustedDependencyCache({
      root,
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      identity,
    });
    expect(result).toEqual({ status: "rejected", reason: "cache_mutable" });
  });
});
