import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDependencyCacheIdentity,
  dependencyCacheIdentityKey,
} from "@/lib/fix-engine/cache-identity";
import { buildSignedNpmDependencyCache } from "../verification-runner/cache-builder";
import { extractSafeTarGzip } from "../verification-runner/archive";
import {
  createPrivateBaseSnapshotArtifact,
  createSignedDependencyCacheReference,
  putSignedDependencyCacheArtifacts,
} from "@/lib/fix-engine/verification-artifacts";
import {
  createVerificationJobRequest,
  RemoteVerificationRunnerClient,
} from "@/lib/fix-engine/verification-runner-client";
import { createVerificationRunnerServer } from "../verification-runner/server";
import { resolveVerificationProfile } from "@/lib/fix-engine/verification-profile";
import { createM1578RPrivateArtifactHarness } from "./helpers/m1578r-private-artifact-harness";

const artifactStorageRef = vi.hoisted(() => ({
  current: null as null | { from: (bucket: string) => unknown },
}));

vi.mock("@/lib/supabase/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/server")>();
  return {
    ...actual,
    createSupabaseServerClient: () => {
      const client = actual.createSupabaseServerClient();
      const storage = artifactStorageRef.current;
      if (!storage) return client;
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "storage") return storage;
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

const execFileAsync = promisify(execFile);
const execNpm = (args: string[], options: Parameters<typeof execFileAsync>[2]) =>
  process.platform === "win32"
    ? execFileAsync("cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`], options)
    : execFileAsync("npm", args, options);
const enabled = process.env.AUTERIM_M1578R_DOCKER_ACCEPTANCE === "1";
const supabaseUrl = process.env.AUTERIM_M1578_EXPECTED_URL;
const serviceKey = process.env.AUTERIM_M1578_SERVICE_KEY;
const workspaceId = "e140d48e-9dc0-4552-a9a4-a81fe3872422";
const cleanups: Array<() => Promise<void>> = [];
let artifactHarness: Awaited<ReturnType<typeof createM1578RPrivateArtifactHarness>> | null = null;

beforeAll(async () => {
  artifactHarness = await createM1578RPrivateArtifactHarness();
  artifactStorageRef.current = artifactHarness.storage;
});

afterAll(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  artifactStorageRef.current = null;
  await artifactHarness?.close();
});

describe.skipIf(!enabled)("M15.78R trusted npm cache and remote Docker verification", () => {
  it(
    "builds a signed exact-commit npm cache and verifies a patch through the isolated runner",
    async () => {
      expect(supabaseUrl).toBe("http://127.0.0.1:61970");
      expect(serviceKey?.length).toBeGreaterThan(20);
      const root = await mkdtemp(path.join(os.tmpdir(), "m1578r-remote-acceptance-"));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const repository = path.join(root, "repository");
      await mkdir(path.join(repository, "src"), { recursive: true });
      await mkdir(path.join(repository, "test"), { recursive: true });
      const packageJson = {
        name: "m1578r-deterministic-fixture",
        version: "1.0.0",
        private: true,
        type: "module",
        packageManager: "npm@10.8.2",
        scripts: {
          preinstall: "node -e \"require('node:fs').writeFileSync('lifecycle-ran', 'yes')\"",
        },
        devDependencies: { vitest: "3.2.4", typescript: "5.9.3" },
      };
      await writeFile(
        path.join(repository, "package.json"),
        `${JSON.stringify(packageJson, null, 2)}\n`,
      );
      await writeFile(
        path.join(repository, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              noEmit: true,
            },
            include: ["src/**/*.ts"],
          },
          null,
          2,
        ),
      );
      await writeFile(
        path.join(repository, "src/endpoint.ts"),
        'export const endpoint: string = "/v1/old";\n',
      );
      await writeFile(
        path.join(repository, "test/endpoint.test.ts"),
        [
          'import { expect, test } from "vitest";',
          'import { endpoint } from "../src/endpoint.ts";',
          'import { writeFileSync } from "node:fs";',
          'test("the candidate endpoint patch is applied", () => expect(endpoint).toBe("/v1/new"));',
          'test("the verifier is constrained", async () => {',
          "  expect(process.getuid?.()).toBe(1000);",
          '  expect(() => writeFileSync("/etc/m1578r-write-probe", "x")).toThrow();',
          '  expect(() => writeFileSync("node_modules/m1578r-write-probe", "x")).toThrow();',
          "  expect(Object.keys(process.env).filter((key) => /SECRET|TOKEN|API_KEY|PRIVATE_KEY/i.test(key))).toEqual([]);",
          '  await expect(fetch("http://1.1.1.1/", { signal: AbortSignal.timeout(1500) })).rejects.toThrow();',
          "});",
        ].join("\n"),
      );

      const safeEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            !/(SUPABASE|TRIGGER|VERCEL|GITHUB|OPENAI|DODO|RESEND|DATABASE_URL|POSTGRES|PRIVATE_KEY|SECRET|TOKEN|API_KEY|NODE_OPTIONS)/i.test(
              name,
            ),
        ),
      );
      await execNpm(
        [
          "install",
          "--package-lock-only",
          "--ignore-scripts",
          "--package-lock-version=3",
          "--no-audit",
          "--no-fund",
          "--registry=https://registry.npmjs.org",
        ],
        {
          cwd: repository,
          timeout: 120_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
          env: {
            ...safeEnv,
            NODE_ENV: "production",
            npm_config_ignore_scripts: "true",
            npm_config_userconfig: process.platform === "win32" ? "NUL" : "/dev/null",
            npm_config_audit: "false",
            npm_config_fund: "false",
          },
        },
      );
      const git = (args: string[]) =>
        execFileAsync("git", args, {
          cwd: repository,
          timeout: 15_000,
          maxBuffer: 4096,
          windowsHide: true,
          env: {
            ...safeEnv,
            NODE_ENV: "production",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          },
        });
      await git(["init", "--quiet"]);
      await git(["config", "user.name", "Auterim M15.78R Fixture"]);
      await git(["config", "user.email", "m1578r-fixture@auterim.invalid"]);
      await git([
        "add",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "src/endpoint.ts",
        "test/endpoint.test.ts",
      ]);
      await git(["commit", "--quiet", "-m", "test: create isolated verifier fixture"]);
      const commitSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
      const repositoryId = "c4c0d571-8610-4d0c-9a71-4be0a7d6a176";
      const repositoryIdentity = "fixture.invalid/m1578r-verification";
      const packageText = await readFile(path.join(repository, "package.json"), "utf8");
      const lockText = await readFile(path.join(repository, "package-lock.json"), "utf8");
      const cacheIdentity = createDependencyCacheIdentity({
        repositoryId,
        repositoryIdentity,
        commitSha,
        packageJson: packageText,
        lockfiles: { "package-lock.json": lockText },
      });
      expect(cacheIdentity?.packageManager).toBe("npm");
      if (!cacheIdentity) throw new Error("fixture_cache_identity_missing");
      const keys = generateKeyPairSync("ed25519");
      const cacheOutput = path.join(root, "cache-output");
      const built = await buildSignedNpmDependencyCache({
        sourceRepositoryPath: repository,
        identity: { repositoryId, repositoryIdentity, commitSha },
        signingPrivateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        outputDirectory: cacheOutput,
      });
      expect(built.manifest.identityKey).toBe(dependencyCacheIdentityKey(cacheIdentity));
      expect(await readFile(path.join(repository, "lifecycle-ran")).catch(() => null)).toBeNull();
      const cacheInspection = path.join(root, "cache-inspection");
      await extractSafeTarGzip(path.join(cacheOutput, "dependencies.tar.gz"), cacheInspection, {
        maxFiles: 50_000,
        maxBytes: 512 * 1024 * 1024,
      });
      expect(existsSync(path.join(cacheInspection, "vitest", "vitest.mjs"))).toBe(true);
      expect(existsSync(path.join(cacheInspection, "typescript", "bin", "tsc"))).toBe(true);

      const fixRunId = "1f3042a6-08a8-4df2-b776-8c30c90615df";
      const patchId = "2f4f848d-356a-4316-9b8f-a23d2c54dd19";
      const planId = "4a4bc3d9-ae3d-4ce0-9cae-570d2fb6b648";
      const patchText = (await git(["diff", "--no-ext-diff", "--", "src/endpoint.ts"])).stdout;
      const baseSnapshot = await createPrivateBaseSnapshotArtifact({
        fixRunId,
        checkoutPath: repository,
      });
      await writeFile(
        path.join(repository, "src/endpoint.ts"),
        'export const endpoint: string = "/v1/new";\n',
      );
      const patch = (await git(["diff", "--no-ext-diff", "--", "src/endpoint.ts"])).stdout;
      expect(patch).not.toBe(patchText);
      const patchFingerprint = runnerHash(patch);
      const patchPath = `${fixRunId}/${patchId}.diff`;
      const patchStore = artifactHarness!.storage.from("fix-engine-artifacts");
      const patchUpload = await patchStore.upload(patchPath, Buffer.from(patch), {
        contentType: "application/octet-stream",
        upsert: false,
        cacheControl: "0",
      });
      expect(patchUpload.error).toBeNull();
      const patchSigned = await patchStore.createSignedUrl(patchPath, 600);
      expect(patchSigned.error).toBeNull();
      if (!patchSigned.data?.signedUrl) throw new Error("fixture_patch_signed_url_missing");

      await putSignedDependencyCacheArtifacts({
        identity: cacheIdentity,
        manifest: built.manifest,
        signature: built.signature,
        archive: built.archive,
      });
      const cache = await createSignedDependencyCacheReference({
        identity: cacheIdentity,
        publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      });
      const files = [
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "src/endpoint.ts",
        "test/endpoint.test.ts",
      ];
      const profile = resolveVerificationProfile({
        packageJson,
        files,
        targetedTestPaths: ["test/endpoint.test.ts"],
        dependencyCacheAvailable: true,
      });
      expect(profile.state).toBe("supported");
      expect(profile.packageManager).toBe("npm");

      const runnerRoot = path.join(root, "runner");
      await mkdir(runnerRoot);
      const authSecret = randomBytes(32).toString("hex");
      const runner = createVerificationRunnerServer({
        authSecret,
        artifactOrigin: artifactHarness!.origin,
        cachePublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        jobStorePath: path.join(runnerRoot, "jobs"),
        workRoot: path.join(runnerRoot, "work"),
      });
      const address = await runner.listen(0, "127.0.0.1");
      cleanups.push(async () => {
        await runner.close();
      });
      const cacheArchive = cache.archive;
      const request = createVerificationJobRequest({
        identity: {
          workspaceId,
          productId: null,
          fixRunId,
          planId,
          planFingerprint: "7".repeat(64),
          evidenceFingerprint: "8".repeat(64),
          patchId,
          patchFingerprint,
          allowedPaths: ["src/endpoint.ts"],
          repositoryId,
          repositoryIdentity,
          baseCommitSha: commitSha,
          packageManager: "npm",
          packageManifestSha256: cacheIdentity.packageManifestSha256,
          lockfileSha256: cacheIdentity.lockfileSha256,
          runtimeProfile: cacheIdentity.runtimeProfile,
          profileId: "javascript-typescript-v1",
          profileVersion: "javascript-typescript-v1",
          cacheIdentityKey: cache.manifest.identityKey,
          cacheTreeSha256: cache.manifest.treeSha256,
        },
        snapshot: baseSnapshot,
        patch: {
          bucket: "fix-engine-artifacts",
          path: patchPath,
          sha256: patchFingerprint,
          byteCount: Buffer.byteLength(patch),
          signedUrl: patchSigned.data.signedUrl,
        },
        cacheArchive,
        cacheManifest: cache.manifest,
        cacheSignature: cache.signature,
        commands: profile.commands,
      });
      const result = await new RemoteVerificationRunnerClient({
        url: `http://127.0.0.1:${address.port}`,
        authSecret,
        maxWaitMs: 240_000,
      }).execute(request);
      expect(
        result.status,
        JSON.stringify(
          result.checks.map(({ commandClass, status, diagnosticCategory }) => ({
            commandClass,
            status,
            diagnosticCategory,
          })),
        ),
      ).toBe("passed");
      expect(result.checks.map((check) => check.commandClass)).toEqual([
        "targeted_test",
        "typecheck",
      ]);
      expect(result.baseCommitSha).toBe(commitSha);
      expect(result.patchFingerprint).toBe(patchFingerprint);
      expect(result.cacheTreeSha256).toBe(cache.manifest.treeSha256);
    },
    15 * 60_000,
  );
});

function runnerHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
