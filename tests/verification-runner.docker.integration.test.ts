import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
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
import { VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF } from "../verification-runner/contracts";
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
      const storage = artifactStorageRef.current;
      if (storage) return { storage } as ReturnType<typeof actual.createSupabaseServerClient>;
      return actual.createSupabaseServerClient();
    },
  };
});

const execFileAsync = promisify(execFile);
const execNpm = (args: string[], options: Parameters<typeof execFileAsync>[2]) =>
  process.platform === "win32"
    ? execFileAsync("cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`], options)
    : execFileAsync("npm", args, options);
const enabled = process.env.AUTERIM_M1578R_DOCKER_ACCEPTANCE === "1";
const actualRunnerContainer = process.env.AUTERIM_M1578R_ACTUAL_RUNNER_CONTAINER === "1";
const supabaseUrl = process.env.AUTERIM_M1578_EXPECTED_URL;
const serviceKey = process.env.AUTERIM_M1578_SERVICE_KEY;
const workspaceId = "e140d48e-9dc0-4552-a9a4-a81fe3872422";
const cleanups: Array<() => Promise<void>> = [];
let artifactHarness: Awaited<ReturnType<typeof createM1578RPrivateArtifactHarness>> | null = null;
let actualRunnerWorkRoot: string | null = null;
let actualRunnerContainerName: string | null = null;

beforeAll(async () => {
  artifactHarness = await createM1578RPrivateArtifactHarness(
    actualRunnerContainer ? { originHost: "localhost" } : undefined,
  );
  artifactStorageRef.current = artifactHarness.storage;
});

afterAll(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  artifactStorageRef.current = null;
  await artifactHarness?.close();
});

describe.skipIf(!enabled)("M15.78R trusted npm cache and remote Docker verification", () => {
  it.skipIf(!actualRunnerContainer)(
    "reproduces the old 0555 nested-directory write failure and extracts the same snapshot as the runner user",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "m1578r-container-archive-"));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const endpointSource = JSON.stringify('export const endpoint = "/v1/old";\n');
      const script = `
        import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
        import { extractSafeTarGzip, packSafeDirectory } from "/opt/auterim-runner/archive.ts";
        let phase = "runner_identity";
        try {
          if (process.getuid?.() !== 1000) throw new Error("runner_user_not_node");
          phase = "fixture_creation";
          await mkdir("/tmp/fixture/src", { recursive: true });
          await writeFile("/tmp/fixture/src/endpoint.js", ${endpointSource});
          await packSafeDirectory("/tmp/fixture", "/tmp/snapshot.tar.gz", { maxFiles: 100, maxBytes: 1048576 });
          phase = "old_permission_reproduction";
          await mkdir("/tmp/old-extractor", { recursive: true, mode: 0o700 });
          await mkdir("/tmp/old-extractor/src", { recursive: false, mode: 0o555 });
          let originalFailure = "";
          try { await writeFile("/tmp/old-extractor/src/endpoint.js", "x"); } catch (error) { originalFailure = error.code ?? ""; }
          if (originalFailure !== "EACCES") throw new Error("old_permission_failure_not_reproduced");
          phase = "fixed_extraction";
          await extractSafeTarGzip("/tmp/snapshot.tar.gz", "/tmp/extracted", { maxFiles: 100, maxBytes: 1048576 });
          const content = await readFile("/tmp/extracted/src/endpoint.js", "utf8");
          const directoryMode = (await stat("/tmp/extracted/src")).mode & 0o777;
          const fileMode = (await stat("/tmp/extracted/src/endpoint.js")).mode & 0o777;
          if (!content.includes("/v1/old") || directoryMode !== 0o555 || fileMode !== 0o444) throw new Error("immutable_extraction_invalid");
          process.stdout.write(JSON.stringify({ status: "PASS", uid: process.getuid(), originalFailure, directoryMode, fileMode }));
        } catch (error) {
          const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
          process.stdout.write(JSON.stringify({ status: "FAIL", phase, errorCode: /^[A-Z0-9_]{1,40}$/.test(code) ? code : "none" }));
          process.exitCode = 1;
        }
      `;
      const args = [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--user",
        "node",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700",
        "--entrypoint",
        "node",
        VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF,
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        script,
      ];
      const result = await runDocker(args);
      expect(JSON.parse(result)).toEqual({
        status: "PASS",
        uid: 1000,
        originalFailure: "EACCES",
        directoryMode: 0o555,
        fileMode: 0o444,
      });
    },
    5 * 60_000,
  );

  it(
    "builds a signed exact-commit npm cache and verifies a patch through the isolated runner",
    async () => {
      expect(supabaseUrl).toBe(process.env.AUTERIM_M1578_EXPECTED_URL ?? "http://127.0.0.1:61970");
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
        packageManager: "npm@10.8.2",
        scripts: {
          preinstall: "node -e \"require('node:fs').writeFileSync('lifecycle-ran', 'yes')\"",
        },
        devDependencies: { jest: "29.7.0", typescript: "5.9.3" },
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
              skipLibCheck: true,
              types: [],
            },
            include: ["src/**/*.ts"],
          },
          null,
          2,
        ),
      );
      await writeFile(
        path.join(repository, "jest.config.js"),
        'module.exports = { testEnvironment: "node" };\n',
      );
      await writeFile(path.join(repository, "src/endpoint.js"), 'exports.endpoint = "/v1/old";\n');
      await writeFile(
        path.join(repository, "src/typecheck.ts"),
        'export const fixtureTypecheck: string = "valid";\n',
      );
      await writeFile(
        path.join(repository, "test/endpoint.test.js"),
        [
          'const { expect, test } = require("@jest/globals");',
          'const { endpoint } = require("../src/endpoint");',
          'const { writeFileSync } = require("node:fs");',
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
        "jest.config.js",
        "src/endpoint.js",
        "src/typecheck.ts",
        "test/endpoint.test.js",
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
      expect(existsSync(path.join(cacheInspection, "jest", "bin", "jest.js"))).toBe(true);
      expect(existsSync(path.join(cacheInspection, "typescript", "bin", "tsc"))).toBe(true);

      const fixRunId = "1f3042a6-08a8-4df2-b776-8c30c90615df";
      const patchId = "2f4f848d-356a-4316-9b8f-a23d2c54dd19";
      const planId = "4a4bc3d9-ae3d-4ce0-9cae-570d2fb6b648";
      const patchText = (await git(["diff", "--no-ext-diff", "--", "src/endpoint.js"])).stdout;
      const baseSnapshot = await createPrivateBaseSnapshotArtifact({
        fixRunId,
        checkoutPath: repository,
      });
      await writeFile(path.join(repository, "src/endpoint.js"), 'exports.endpoint = "/v1/new";\n');
      const patch = (await git(["diff", "--no-ext-diff", "--", "src/endpoint.js"])).stdout;
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
        "jest.config.js",
        "src/endpoint.js",
        "src/typecheck.ts",
        "test/endpoint.test.js",
      ];
      const profile = resolveVerificationProfile({
        packageJson,
        files,
        targetedTestPaths: ["test/endpoint.test.js"],
        dependencyCacheAvailable: true,
        packageLock: lockText,
      });
      expect(profile.state).toBe("supported");
      expect(profile.packageManager).toBe("npm");

      const authSecret = randomBytes(32).toString("hex");
      const cachePublicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
      let runnerUrl: string;
      if (actualRunnerContainer) {
        runnerUrl = await startActualRunnerContainer({
          authSecret,
          artifactOrigin: artifactHarness!.origin,
          artifactRoot: artifactHarness!.rootPath,
          artifactVerificationSecret: artifactHarness!.testOnlyVerificationSecretHex,
          cachePublicKey,
        });
      } else {
        const runnerRoot = path.join(root, "runner");
        await mkdir(runnerRoot);
        const runner = createVerificationRunnerServer({
          authSecret,
          artifactOrigin: artifactHarness!.origin,
          cachePublicKey,
          jobStorePath: path.join(runnerRoot, "jobs"),
          workRoot: path.join(runnerRoot, "work"),
        });
        const address = await runner.listen(0, "127.0.0.1");
        cleanups.push(async () => {
          await runner.close();
        });
        runnerUrl = `http://127.0.0.1:${address.port}`;
      }
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
          allowedPaths: ["src/endpoint.js"],
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
      const clientStartedAt = Date.now();
      if (actualRunnerContainer && actualRunnerContainerName) {
        const artifactProbe = await probeContainerArtifactTransport(actualRunnerContainerName, [
          request.snapshot.url,
          request.patch.url,
          request.cacheArchive.url,
        ]);
        expect(artifactProbe).toEqual([
          {
            status: 200,
            contentLength: request.snapshot.byteCount,
            bodyBytes: request.snapshot.byteCount,
          },
          {
            status: 200,
            contentLength: request.patch.byteCount,
            bodyBytes: request.patch.byteCount,
          },
          {
            status: 200,
            contentLength: request.cacheArchive.byteCount,
            bodyBytes: request.cacheArchive.byteCount,
          },
        ]);
      }
      let result: Awaited<ReturnType<RemoteVerificationRunnerClient["execute"]>>;
      try {
        result = await new RemoteVerificationRunnerClient({
          url: runnerUrl,
          authSecret,
          maxWaitMs: 240_000,
        }).execute(request);
      } catch (error) {
        const failure = error as {
          category?: unknown;
          diagnostics?: unknown;
          correlation?: { admissionState?: unknown; jobId?: unknown } | null;
        };
        const jobId =
          typeof failure.correlation?.jobId === "string" &&
          /^[a-f0-9]{64}$/.test(failure.correlation.jobId)
            ? failure.correlation.jobId
            : null;
        const runnerWorkRoot = actualRunnerContainer ? actualRunnerWorkRoot : null;
        let storedFailureCategory: string | null = null;
        if (jobId && runnerWorkRoot) {
          try {
            const output = await runDocker([
              "exec",
              "--user",
              "node",
              actualRunnerContainerName!,
              "node",
              "-e",
              `try { const p=require("node:path").join(process.env.FIX_VERIFICATION_RUNNER_WORK_ROOT,"jobs",${JSON.stringify(`${jobId}.json`)}); const r=JSON.parse(require("node:fs").readFileSync(p,"utf8")); const c=r.state?.failure?.category; process.stdout.write(typeof c==="string"&&/^[a-z0-9_]{1,100}$/.test(c)?c:"unavailable"); } catch { process.stdout.write("unavailable"); }`,
            ]);
            if (/^[a-z0-9_]{1,100}$/.test(output) && output !== "unavailable")
              storedFailureCategory = output;
          } catch {
            // Local-only harness reports no stored category if the record is unavailable or invalid.
          }
        }
        const runtime = actualRunnerContainerName
          ? await inspectLocalRunnerRuntime(actualRunnerContainerName)
          : null;
        throw new Error(
          `m1578r_actual_runner_container_failure:${JSON.stringify({
            category: failure.category,
            diagnostics: failure.diagnostics,
            admissionState: failure.correlation?.admissionState,
            storedFailureCategory,
            clientElapsedMs: Date.now() - clientStartedAt,
            runtime,
            artifactBytes: {
              snapshot: request.snapshot.byteCount,
              patch: request.patch.byteCount,
              cache: request.cacheArchive.byteCount,
            },
          })}`,
        );
      }
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

async function runDocker(args: string[], timeout = 30_000) {
  try {
    const result = await execFileAsync("docker", args, {
      timeout,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
    const stdout =
      typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout) : "";
    const phase = [...stdout.matchAll(/m1578r_phase=([a-z_]{1,40})/g)].at(-1)?.[1] ?? "unknown";
    const scriptFailure =
      /\{"status":"FAIL","phase":"([a-z_]{1,40})","errorCode":"([A-Z0-9_]{1,40})"\}/.exec(stdout);
    if (scriptFailure)
      throw new Error(
        `m1578r_docker_container_acceptance_script_failure_${scriptFailure[1]}_${scriptFailure[2]}`,
      );
    if (/invalid mount config|invalid bind mount/i.test(stderr))
      throw new Error("m1578r_docker_container_acceptance_mount_invalid");
    if (/permission denied|operation not permitted|EACCES/i.test(stderr))
      throw new Error(`m1578r_docker_container_acceptance_permission_denied_${phase}`);
    if (/cannot connect to the docker daemon/i.test(stderr))
      throw new Error("m1578r_docker_container_acceptance_daemon_unavailable");
    if (/no such image|image not known/i.test(stderr))
      throw new Error("m1578r_docker_container_acceptance_image_unavailable");
    if (/syntaxerror|unexpected token|invalid or unexpected token/i.test(stderr))
      throw new Error(`m1578r_docker_container_acceptance_script_syntax_${phase}`);
    if (/err_module_not_found|cannot find module/i.test(stderr))
      throw new Error(`m1578r_docker_container_acceptance_module_missing_${phase}`);
    throw new Error(`m1578r_docker_container_acceptance_command_failed_${phase}`);
  }
}

async function startActualRunnerContainer(input: {
  authSecret: string;
  artifactOrigin: string;
  artifactRoot: string;
  artifactVerificationSecret: string;
  cachePublicKey: string;
}) {
  const artifactPort = Number(new URL(input.artifactOrigin).port);
  if (
    new URL(input.artifactOrigin).hostname !== "localhost" ||
    !Number.isSafeInteger(artifactPort) ||
    artifactPort < 1 ||
    artifactPort > 65_535 ||
    !/^[a-f0-9]{64}$/.test(input.artifactVerificationSecret)
  )
    throw new Error("m1578r_artifact_sidecar_config_invalid");
  const workVolume = await createLocalRunnerVolume("m1578r-work");
  const artifactVolume = await createLocalRunnerVolume("m1578r-artifacts");
  if (workVolume.mountpoint.includes(",")) throw new Error("m1578r_runner_work_root_invalid");
  const name = `m1578r-container-runner-${randomUUID().slice(0, 8)}`;
  actualRunnerContainerName = name;
  let runnerStarted = false;
  cleanups.push(async () => {
    if (runnerStarted) await runDocker(["rm", "-f", name]).catch(() => undefined);
    await runDocker(["volume", "rm", workVolume.name, artifactVolume.name]).catch(() => undefined);
  });
  actualRunnerWorkRoot = workVolume.mountpoint;
  await prepareLocalRunnerVolume(
    workVolume,
    `import { chmodSync, chownSync } from "node:fs"; chownSync("/destination", 1000, 1000); chmodSync("/destination", 0o700);`,
  );
  await prepareLocalRunnerVolume(
    artifactVolume,
    `
      import { chmodSync, cpSync, lstatSync, readdirSync } from "node:fs";
      for (const entry of readdirSync("/source")) cpSync("/source/" + entry, "/destination/" + entry, { recursive: true });
      const visit = (current) => {
        const info = lstatSync(current);
        if (info.isSymbolicLink()) throw new Error("fixture_symlink_forbidden");
        if (info.isDirectory()) {
          chmodSync(current, 0o755);
          for (const entry of readdirSync(current)) visit(current + "/" + entry);
        } else if (info.isFile()) chmodSync(current, 0o644);
        else throw new Error("fixture_special_file_forbidden");
      };
      visit("/destination");
    `,
    input.artifactRoot,
  );
  const imageUser = await runDocker([
    "image",
    "inspect",
    "--format",
    "{{.Config.User}}",
    VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF,
  ]);
  if (imageUser !== "node") throw new Error("m1578r_runner_image_user_invalid");
  const socketGid = Number(
    await runDocker([
      "run",
      "--rm",
      "--network",
      "none",
      "--mount",
      "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock,readonly",
      "--entrypoint",
      "node",
      VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF,
      "-e",
      'import { stat } from "node:fs/promises"; process.stdout.write(String((await stat("/var/run/docker.sock")).gid));',
    ]),
  );
  if (!Number.isSafeInteger(socketGid) || socketGid < 0)
    throw new Error("m1578r_docker_socket_group_invalid");

  const started = await runDocker(
    [
      "run",
      "-d",
      "--name",
      name,
      "--network",
      "bridge",
      "--add-host",
      "host.docker.internal:host-gateway",
      "--publish",
      "127.0.0.1::8080",
      "--mount",
      "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock,readonly",
      "--group-add",
      String(socketGid),
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700",
      "--mount",
      `type=volume,source=${workVolume.name},target=${workVolume.mountpoint}`,
      "--mount",
      `type=volume,source=${artifactVolume.name},target=/opt/m1578r-test-artifacts,readonly`,
      "--env",
      `FIX_VERIFICATION_RUNNER_AUTH_SECRET=${input.authSecret}`,
      "--env",
      `NEXT_PUBLIC_SUPABASE_URL=${input.artifactOrigin}`,
      "--env",
      `FIX_DEPENDENCY_CACHE_PUBLIC_KEY=${input.cachePublicKey}`,
      "--env",
      `FIX_VERIFICATION_RUNNER_WORK_ROOT=${workVolume.mountpoint}`,
      VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF,
    ],
    60_000,
  );
  if (!/^[a-f0-9]{64}$/.test(started)) throw new Error("m1578r_runner_container_start_invalid");
  runnerStarted = true;

  const published = await runDocker(["port", name, "8080/tcp"]);
  const match = /127\.0\.0\.1:(\d+)/.exec(published);
  if (!match) throw new Error("m1578r_runner_container_port_invalid");
  const url = `http://127.0.0.1:${match[1]}`;
  const artifactSidecar = `
    import { createServer } from "node:http";
    import { createHmac, timingSafeEqual } from "node:crypto";
    import { lstat, readFile } from "node:fs/promises";
    import path from "node:path";
    const port = Number(process.env.AUTERIM_M1578R_TEST_ARTIFACT_PORT);
    const secret = Buffer.from(process.env.AUTERIM_M1578R_TEST_ARTIFACT_SECRET ?? "", "hex");
    const root = "/opt/m1578r-test-artifacts";
    const paths = {
      "fix-engine-artifacts": /^[0-9a-f-]{36}\\/[0-9a-f-]{36}\\.diff$/i,
      "fix-engine-verification-artifacts": /^(?:snapshots\\/[0-9a-f-]{36}\\/[a-f0-9]{64}\\.tar\\.gz|caches\\/[0-9a-f-]{36}\\/[a-f0-9]{40,64}\\/[a-f0-9]{64}\\/(?:manifest\\.json|manifest\\.sig|dependencies\\.tar\\.gz))$/i
    };
    const handleArtifactRequest = async (request, response) => {
      if (request.method === "GET" && request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
        return;
      }
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        const match = /^\\/storage\\/v1\\/object\\/sign\\/(fix-engine-artifacts|fix-engine-verification-artifacts)\\/(.+)$/.exec(url.pathname);
        const bucket = match?.[1];
        const objectPath = match?.[2] ? decodeURIComponent(match[2]) : "";
        const expires = Number(url.searchParams.get("expires"));
        const signature = url.searchParams.get("signature") ?? "";
        if (!bucket || !paths[bucket]?.test(objectPath) || !Number.isSafeInteger(expires) || expires < Math.floor(Date.now()/1000) || expires > Math.floor(Date.now()/1000)+600 || !/^[a-f0-9]{64}$/.test(signature) || secret.length !== 32) throw new Error();
        const expected = createHmac("sha256", secret).update(bucket + "\\n" + objectPath + "\\n" + expires).digest();
        if (!timingSafeEqual(expected, Buffer.from(signature,"hex"))) throw new Error();
        const file = path.resolve(root, bucket, ...objectPath.split("/"));
        if (!file.startsWith(root + path.sep)) throw new Error();
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error();
        const bytes = await readFile(file);
        response.writeHead(200, { "content-length": bytes.byteLength, "cache-control": "private, no-store" }).end(bytes);
      } catch {
        response.writeHead(404).end();
      }
    };
    createServer(handleArtifactRequest).listen(port, "127.0.0.1");
    createServer(handleArtifactRequest).listen(port, "::1");
  `;
  await runDocker([
    "exec",
    "-d",
    "--user",
    "node",
    "--env",
    `AUTERIM_M1578R_TEST_ARTIFACT_PORT=${artifactPort}`,
    "--env",
    `AUTERIM_M1578R_TEST_ARTIFACT_SECRET=${input.artifactVerificationSecret}`,
    name,
    "node",
    "--input-type=module",
    "-e",
    artifactSidecar,
  ]);
  const sidecarDeadline = Date.now() + 10_000;
  let sidecarReady = false;
  while (Date.now() < sidecarDeadline) {
    try {
      const result = await runDocker([
        "exec",
        "--user",
        "node",
        name,
        "node",
        "--input-type=module",
        "-e",
        `try { const response = await fetch("http://localhost:${artifactPort}/healthz"); process.stdout.write(response.ok ? "PASS" : "FAIL"); } catch { process.stdout.write("FAIL"); }`,
      ]);
      if (result === "PASS") {
        sidecarReady = true;
        break;
      }
    } catch {
      // Retry only observation of this local synthetic test sidecar; no job is sent until ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!sidecarReady) throw new Error("m1578r_test_artifact_sidecar_health_timeout");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1_000) });
      const body = (await response.json()) as { protocolVersion?: unknown };
      if (response.ok && body.protocolVersion === "m1578-verification-runner-v1") return url;
    } catch {
      // Startup is observed with bounded health polling; the container is never restarted.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const state = await runDocker([
    "inspect",
    "--format",
    "{{.State.Status}}:{{.State.ExitCode}}",
    name,
  ]).catch(() => "unavailable");
  let startupCategory = "unclassified";
  try {
    const logResult = await execFileAsync("docker", ["logs", name], {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    const logs = `${logResult.stdout}\n${logResult.stderr}`;
    if (/permission denied|eacces/i.test(logs)) startupCategory = "permission_denied";
    else if (/work_root|workroot/i.test(logs)) startupCategory = "work_root_setup_failed";
    else if (/listen|port/i.test(logs)) {
      const code = /\b(EADDRINUSE|EADDRNOTAVAIL|EAFNOSUPPORT|EACCES|ENOENT)\b/.exec(logs)?.[1];
      const errorType = /\b(TypeError|RangeError|SyntaxError|Error)\b/.exec(logs)?.[1];
      startupCategory = code
        ? `listen_${code.toLowerCase()}`
        : errorType
          ? `listen_${errorType.toLowerCase()}`
          : "listen_failed";
    } else if (/config_missing/i.test(logs)) startupCategory = "required_config_missing";
  } catch {
    startupCategory = "logs_unavailable";
  }
  throw new Error(
    `m1578r_runner_container_health_timeout:${JSON.stringify({ state, startupCategory })}`,
  );
}

async function createLocalRunnerVolume(prefix: string) {
  const name = `${prefix}-${randomUUID().slice(0, 12)}`;
  if ((await runDocker(["volume", "create", name])) !== name)
    throw new Error("m1578r_test_volume_creation_failed");
  const mountpoint = await runDocker(["volume", "inspect", "--format", "{{.Mountpoint}}", name]);
  if (!mountpoint.startsWith("/") || mountpoint.includes(","))
    throw new Error("m1578r_test_volume_mountpoint_invalid");
  return { name, mountpoint };
}

async function prepareLocalRunnerVolume(
  volume: { name: string },
  script: string,
  hostSource?: string,
) {
  const args = [
    "run",
    "--rm",
    "--user",
    "0",
    "--mount",
    `type=volume,source=${volume.name},target=/destination`,
  ];
  if (hostSource) args.push("--mount", `type=bind,source=${hostSource},target=/source,readonly`);
  args.push(
    "--entrypoint",
    "node",
    VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF,
    "--input-type=module",
    "-e",
    script,
  );
  await runDocker(args, 60_000);
}

async function probeContainerArtifactTransport(containerName: string, urls: string[]) {
  const script = `
    const urls = ${JSON.stringify(urls)};
    const results = await Promise.all(urls.map(async (url) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
        const body = await response.arrayBuffer();
        return { status: response.status, contentLength: Number(response.headers.get("content-length")), bodyBytes: body.byteLength };
      } catch {
        return { status: 0, contentLength: 0, bodyBytes: 0 };
      }
    }));
    process.stdout.write(JSON.stringify(results));
  `;
  const output = await runDocker(
    ["exec", "--user", "node", containerName, "node", "--input-type=module", "-e", script],
    15_000,
  );
  return JSON.parse(output) as Array<{
    status: number;
    contentLength: number;
    bodyBytes: number;
  }>;
}

async function inspectLocalRunnerRuntime(containerName: string) {
  const state = await runDocker([
    "inspect",
    "--format",
    "{{.State.Status}}:{{.State.ExitCode}}",
    containerName,
  ]).catch(() => "unavailable");
  const diagnosticScript = `
    const fs = require("node:fs");
    const path = require("node:path");
    const root = path.join(process.env.FIX_VERIFICATION_RUNNER_WORK_ROOT ?? "", "jobs");
    try {
      const jobs = fs.readdirSync(root, { withFileTypes: true });
      const spool = fs.readdirSync(root + "/artifacts", { withFileTypes: true });
      process.stdout.write(JSON.stringify({
        jobRecords: jobs.filter((entry) => entry.isFile() && /^[a-f0-9]{64}\\.json$/.test(entry.name)).length,
        admittingDirectories: spool.filter((entry) => entry.isDirectory() && /^\\.[a-f0-9]{64}\\.[0-9a-f-]{36}\\.admitting$/.test(entry.name)).length,
        spoolJobDirectories: spool.filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)).length
      }));
    } catch {
      process.stdout.write(JSON.stringify({ jobRecords: 0, admittingDirectories: 0, spoolJobDirectories: 0 }));
    }
  `;
  const counts = await runDocker([
    "exec",
    "--user",
    "node",
    containerName,
    "node",
    "-e",
    diagnosticScript,
  ])
    .then(
      (output) =>
        JSON.parse(output) as {
          jobRecords: number;
          admittingDirectories: number;
          spoolJobDirectories: number;
        },
    )
    .catch(() => ({ jobRecords: 0, admittingDirectories: 0, spoolJobDirectories: 0 }));
  return { state, ...counts };
}
