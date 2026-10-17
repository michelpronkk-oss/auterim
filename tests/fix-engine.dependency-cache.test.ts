import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { readExactCommitText } from "../verification-runner/cache-builder";

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
  it("fingerprints exact Git blob bytes instead of CRLF-smudged checkout text", async () => {
    const root = await mkdtemp(path.join(process.env.TEMP ?? process.cwd(), "m1578-cache-eol-"));
    rootPaths.push(root);
    const repository = path.join(root, "repository");
    await mkdir(repository);
    const safeEnv = {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "test" as const,
      ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "" } : {}),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    };
    const git = (args: string[]) =>
      execFileSync("git", ["-C", repository, ...args], {
        encoding: "utf8",
        windowsHide: true,
        env: safeEnv,
      }).trim();
    const expectedPackage = '{"name":"eol-cache-fixture","packageManager":"npm@10.8.2"}\n';
    const expectedLock = '{"name":"eol-cache-fixture","lockfileVersion":3,"packages":{}}\n';
    await writeFile(path.join(repository, ".gitattributes"), "*.json text eol=crlf\n");
    await writeFile(path.join(repository, "package.json"), expectedPackage);
    await writeFile(path.join(repository, "package-lock.json"), expectedLock);
    git(["init", "--quiet"]);
    git(["config", "user.name", "Auterim cache fixture"]);
    git(["config", "user.email", "cache-fixture@auterim.invalid"]);
    git(["add", ".gitattributes", "package.json", "package-lock.json"]);
    git(["commit", "--quiet", "-m", "test: commit cache identity files"]);
    const commitSha = git(["rev-parse", "HEAD"]);
    await rm(path.join(repository, "package.json"));
    await rm(path.join(repository, "package-lock.json"));
    git(["checkout", "--", "package.json", "package-lock.json"]);

    const worktreePackage = await readFile(path.join(repository, "package.json"), "utf8");
    const worktreeLock = await readFile(path.join(repository, "package-lock.json"), "utf8");
    expect(worktreePackage).toContain("\r\n");
    expect(worktreeLock).toContain("\r\n");
    expect(git(["status", "--porcelain"])).toBe("");

    const exactPackage = readExactCommitText(repository, commitSha, "package.json");
    const exactLock = readExactCommitText(repository, commitSha, "package-lock.json");
    expect(exactPackage).toBe(expectedPackage);
    expect(exactLock).toBe(expectedLock);
    const rawIdentity = createDependencyCacheIdentity({
      repositoryId,
      repositoryIdentity: "michelpronkk-oss/auterim",
      commitSha,
      packageJson: exactPackage,
      lockfiles: { "package-lock.json": exactLock },
    });
    const smudgedIdentity = createDependencyCacheIdentity({
      repositoryId,
      repositoryIdentity: "michelpronkk-oss/auterim",
      commitSha,
      packageJson: worktreePackage,
      lockfiles: { "package-lock.json": worktreeLock },
    });
    expect(rawIdentity).not.toBeNull();
    expect(smudgedIdentity).not.toBeNull();
    expect(rawIdentity?.packageManifestSha256).toBe(
      createHash("sha256").update(expectedPackage).digest("hex"),
    );
    expect(rawIdentity?.lockfileSha256).not.toBe(smudgedIdentity?.lockfileSha256);
  });

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
