import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareScans,
  renderReview,
  scanProject,
  serializeDiscoveryPayload,
} from "../src/scanner/index.js";

const fixtureRoot = fileURLToPath(new URL("../fixtures/projects/", import.meta.url));
const temporaryRoots: string[] = [];

async function copyFixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), "auterim-cli-scan-"));
  temporaryRoots.push(root);
  await cp(join(fixtureRoot, name), root, { recursive: true });
  return root;
}

function payloadText(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function payloadObject(value: unknown) {
  return typeof value === "string"
    ? (JSON.parse(value) as Record<string, unknown>)
    : (value as Record<string, unknown>);
}

function knownObservations(scan: Awaited<ReturnType<typeof scanProject>>) {
  return scan.observations.filter((item) => item.providerCandidate?.status === "known");
}

afterEach(async () => {
  delete (globalThis as typeof globalThis & { __auterimCliFixtureExecuted?: string })
    .__auterimCliFixtureExecuted;
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("local dependency discovery scanner", () => {
  it("extracts known provider evidence from dependency manifests without sending source text", async () => {
    const root = await copyFixture("basic");
    const scan = await scanProject({ root });
    const providers = new Set(
      knownObservations(scan).map((item) => item.providerCandidate.providerSlug),
    );
    const payload = serializeDiscoveryPayload(scan);
    const rendered = renderReview(scan);

    expect(scan.schemaVersion).toBeTypeOf("string");
    expect(scan.scannerVersion).toBeTypeOf("string");
    expect(scan.registryVersion).toBeTypeOf("string");
    expect(scan.scanId).toBeTypeOf("string");
    expect(scan.projectFingerprint).toBeNull();
    expect([...providers]).toEqual(
      expect.arrayContaining(["stripe", "supabase", "sentry", "posthog"]),
    );
    expect(payloadText(payload)).not.toContain("sourceText");
    expect(rendered).not.toContain("fileBody");
  });

  it("keeps monorepo evidence attributed to a relative subproject", async () => {
    const root = await copyFixture("monorepo");
    const scan = await scanProject({ root });
    const webEvidence = scan.observations.filter((item) => item.subproject?.includes("apps/web"));
    const billingEvidence = scan.observations.filter((item) =>
      item.subproject?.includes("packages/billing"),
    );

    expect(webEvidence.length).toBeGreaterThan(0);
    expect(billingEvidence.length).toBeGreaterThan(0);
    expect(
      [...webEvidence, ...billingEvidence].every(
        (item) => item.subproject === null || !isAbsolute(item.subproject),
      ),
    ).toBe(true);
  });

  it("extracts import, lockfile, environment-name, host, model, config, and framework evidence", async () => {
    const root = await copyFixture("evidence");
    const scan = await scanProject({ root });
    const families = scan.observations.map((item) => item.evidenceFamily);
    const identifiers = scan.observations.map((item) => item.normalizedIdentifier);

    expect(families).toEqual(
      expect.arrayContaining([
        "package_manifest",
        "lockfile_identity",
        "import_reference",
        "environment_variable_name",
        "provider_host",
        "model_identifier",
        "configuration_file",
        "framework_runtime",
      ]),
    );
    expect(identifiers).toEqual(
      expect.arrayContaining([
        "openai",
        "api.openai.com",
        "OPENAI_API_KEY",
        "next",
        "gpt-6.1-sol",
        "package-lock.json",
      ]),
    );
    expect(
      scan.observations.some(
        (item) => item.evidenceFamily === "lockfile_identity" && item.metadata.ecosystem === "npm",
      ),
    ).toBe(true);
    expect(
      scan.observations.some(
        (item) =>
          item.evidenceFamily === "framework_runtime" && item.metadata.configKind === "next",
      ),
    ).toBe(true);
    expect(renderReview(scan)).not.toContain("  next\n");
  });

  it("never serializes secret canaries from dotenv, PEM, or credential-bearing Git remotes", async () => {
    const root = await copyFixture("safety");
    const gitDirectory = join(root, ".git");
    await mkdir(join(gitDirectory, "refs", "heads"), { recursive: true });
    await writeFile(join(gitDirectory, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(
      join(gitDirectory, "refs", "heads", "main"),
      "0123456789abcdef0123456789abcdef01234567\n",
    );
    await writeFile(
      join(gitDirectory, "config"),
      '[remote "origin"]\n\turl = https://fixture-user:FIXTURE_GIT_CREDENTIAL_CANARY@github.com/example/private.git?token=FIXTURE_GIT_CREDENTIAL_CANARY\n',
    );
    const scan = await scanProject({ root });
    const output = `${renderReview(scan)}\n${payloadText(serializeDiscoveryPayload(scan))}`;
    const identifiers = scan.observations.map((item) => item.normalizedIdentifier);

    expect(identifiers).toContain("OPENAI_API_KEY");
    expect(output).not.toContain("sk-test-DO_NOT_EXPORT_THIS_FIXTURE_CANARY");
    expect(output).not.toContain("fixture-password");
    expect(output).not.toContain("fixture-user");
    expect(output).not.toContain("FIXTURE_ONLY_DO_NOT_EXPORT_THIS_PEM_CANARY");
    expect(output).not.toContain("FIXTURE_GIT_CREDENTIAL_CANARY");
    expect(output).toContain("github.com");
    expect(output).toContain("example/private");
    expect(output).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("reads only environment variable names from optional dotenv files", async () => {
    const root = await copyFixture("safety");
    await writeFile(
      join(root, ".env.local"),
      "OPENAI_API_KEY=fixture-secret-value\nthis is malformed and contains fixture-secret-value\nUNRELATED_VALUE=fixture-secret-value\n",
    );
    const scan = await scanProject({ root });
    const identifiers = scan.observations
      .filter((item) => item.evidenceFamily === "environment_variable_name")
      .map((item) => item.normalizedIdentifier);
    const text = payloadText(serializeDiscoveryPayload(scan));

    expect(identifiers).toContain("OPENAI_API_KEY");
    expect(text).not.toContain("fixture-secret-value");
  });

  it("marks an unrecognized provider as an observed unknown instead of inventing a catalog provider", async () => {
    const root = await copyFixture("unknown-provider");
    const scan = await scanProject({ root });
    const candidate = scan.observations.find((item) =>
      item.normalizedIdentifier.includes("fictional-vendor/private-runtime-sdk"),
    );

    expect(candidate).toBeDefined();
    expect(candidate?.providerCandidate).toMatchObject({
      status: "unknown",
      providerSlug: null,
      providerName: null,
    });
  });

  it("scans a non-Git project and leaves its project fingerprint null", async () => {
    const root = await copyFixture("basic");
    const scan = await scanProject({ root });

    expect(scan.projectFingerprint).toBeNull();
    expect(scan.observations.length).toBeGreaterThan(0);
  });

  it("does not follow a directory symlink outside the selected project", async () => {
    const root = await copyFixture("basic");
    const outside = await mkdtemp(join(tmpdir(), "auterim-cli-outside-"));
    temporaryRoots.push(outside);
    await writeFile(
      join(outside, "package.json"),
      JSON.stringify({
        name: "outside-canary",
        dependencies: { "@fictional-vendor/outside-secret": "1.0.0" },
      }),
    );
    const linkPath = join(root, "linked-outside");
    await symlink(outside, linkPath, "junction");

    let scan: Awaited<ReturnType<typeof scanProject>> | undefined;
    let failure: unknown;
    try {
      scan = await scanProject({ root });
    } catch (error) {
      failure = error;
    }
    const text = scan ? payloadText(serializeDiscoveryPayload(scan)) : "";
    expect(failure === undefined || failure instanceof Error).toBe(true);
    if (scan) expect(scan.stats.symlinksSkipped).toBeGreaterThan(0);
    expect(text).not.toContain("outside-canary");
    expect(text).not.toContain("outside-secret");
  });

  it("bounds malformed, oversized, and ignored inputs", async () => {
    const root = await copyFixture("basic");
    await writeFile(join(root, "broken.package.json"), "{ malformed");
    await writeFile(join(root, "package.json"), "{ malformed");
    await writeFile(join(root, "package-lock.json"), `{"padding":"${"x".repeat(2_000_000)}"}`);
    await mkdir(join(root, "node_modules", "ignored-package"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "ignored-package", "package.json"),
      JSON.stringify({
        name: "ignored-canary",
        dependencies: { "@fictional-vendor/ignored": "1" },
      }),
    );
    await writeFile(
      join(root, "dist", "package.json"),
      JSON.stringify({ name: "dist-canary", dependencies: { "@fictional-vendor/dist": "1" } }),
    );

    const scan = await scanProject({ root });
    const payload = serializeDiscoveryPayload(scan);
    const text = payloadText(payload);

    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(2_000_000);
    expect(text).not.toContain("ignored-canary");
    expect(text).not.toContain("dist-canary");
    expect(text).not.toContain("padding");
  });

  it("keeps scan schema strict, relative-path safe, and metadata bounded", async () => {
    const root = await copyFixture("basic");
    const scan = await scanProject({ root });
    const payload = payloadObject(serializeDiscoveryPayload(scan));
    const observations = payload.observations as Array<Record<string, unknown>>;

    expect(Object.keys(payload).sort()).toEqual(
      [
        "observations",
        "projectFingerprint",
        "projectSummary",
        "registryVersion",
        "scanId",
        "scannerVersion",
        "schemaVersion",
        "stats",
        "status",
      ].sort(),
    );
    expect(observations.length).toBeLessThanOrEqual(2_000);
    for (const observation of observations) {
      expect(observation.evidenceFamily).toBeTypeOf("string");
      expect(observation.normalizedIdentifier).toBeTypeOf("string");
      expect(observation.reasonCode).toBeTypeOf("string");
      expect(observation.confidence).toBeGreaterThanOrEqual(0);
      expect(observation.confidence).toBeLessThanOrEqual(1);
      expect(
        observation.safeRelativePath === null || typeof observation.safeRelativePath === "string",
      ).toBe(true);
      expect(JSON.stringify(observation).length).toBeLessThan(8_192);
      expect(JSON.stringify(observation)).not.toMatch(
        /"(?:contents|sourceText|fileBody|secret|token)"\s*:/i,
      );
      if (typeof observation.safeRelativePath === "string") {
        const relativePath = relative(resolve(root), resolve(root, observation.safeRelativePath));
        expect(isAbsolute(relativePath)).toBe(false);
        expect(relativePath === ".." || relativePath.startsWith(`..${sep}`)).toBe(false);
      }
    }
  });

  it("compares two scans and reports changed evidence without source bodies", async () => {
    const root = await copyFixture("basic");
    const previous = await scanProject({ root });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "changed-fixture",
        dependencies: { stripe: "^18.0.0", "@sentry/node": "^8.0.0" },
      }),
    );
    const current = await scanProject({ root });
    const diff = compareScans(previous, current);
    const text = payloadText(diff);

    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("sourceText");
    expect(text).not.toContain("fileBody");
  });

  it("uses no network and executes no project code", async () => {
    const root = await copyFixture("safety");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network_forbidden"));
    const scan = await scanProject({ root });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      (globalThis as typeof globalThis & { __auterimCliFixtureExecuted?: string })
        .__auterimCliFixtureExecuted,
    ).toBeUndefined();
    expect(payloadText(serializeDiscoveryPayload(scan))).not.toContain("EXECUTION_CANARY_ONLY");
  });

  it("bounds depth, total manifest bytes, and cancellation", async () => {
    const root = await copyFixture("basic");
    let deep = root;
    for (let depth = 0; depth < 12; depth += 1) {
      deep = join(deep, `depth-${depth}`);
      await mkdir(deep, { recursive: true });
      await writeFile(
        join(deep, "package.json"),
        JSON.stringify({
          dependencies: { stripe: "17.0.0", [`@fictional-vendor/pkg-${depth}`]: "1.0.0" },
          description: "x".repeat(180_000),
        }),
      );
    }
    const deepScan = await scanProject({ root });
    expect(deepScan.stats.truncated).toBe(true);
    expect(deepScan.stats.directoriesVisited).toBeLessThanOrEqual(600);
    expect(deepScan.stats.filesVisited).toBeLessThanOrEqual(4_000);
    expect(deepScan.stats.observations).toBeLessThanOrEqual(1_500);
    expect(deepScan.stats.durationMs).toBeLessThan(8_000);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await scanProject({ root, signal: controller.signal });
    expect(cancelled.status).toBe("cancelled");
  });

  it("bounds visited files and reports a time-limit stop as partial", async () => {
    const root = await copyFixture("basic");
    const junk = join(root, "junk");
    await mkdir(junk, { recursive: true });
    await Promise.all(
      Array.from({ length: 4_050 }, (_, index) =>
        writeFile(join(junk, `file-${index}.txt`), "ignored content"),
      ),
    );
    const fileBound = await scanProject({ root });
    expect(fileBound.stats.filesVisited).toBeLessThanOrEqual(4_000);
    expect(fileBound.stats.truncated).toBe(true);

    let time = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      time += 9_000;
      return time;
    });
    const timed = await scanProject({ root });
    expect(timed.stats.durationMs).toBeGreaterThanOrEqual(0);
    expect(timed.status).toBe("partial");
  });

  it("returns a safe error for invalid roots and respects unreadable directories where supported", async () => {
    const root = await copyFixture("basic");
    const failed = await scanProject({ root: join(root, "package.json") });
    expect(failed.status).toBe("failed");
    expect(failed.stats.partialReasons).toEqual(["root_unavailable"]);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const blocked = join(root, "blocked");
      await mkdir(blocked);
      await writeFile(join(blocked, "package.json"), "{}\n");
      await chmod(blocked, 0);
      const scan = await scanProject({ root });
      await chmod(blocked, 0o700);
      expect(scan.stats.truncated).toBe(true);
    }
  });

  it("keeps CLI stdout and stderr free of secret canaries", async () => {
    const { main } = await import("../src/cli.js");
    const root = await copyFixture("safety");
    let stdout = "";
    let stderr = "";
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);

    expect(await main(["connect", "--dry-run", "--root", root])).toBe(0);
    expect(stdoutSpy).toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    const output = `${stdout}\n${stderr}`;
    expect(output).not.toContain("sk-test-DO_NOT_EXPORT_THIS_FIXTURE_CANARY");
    expect(output).not.toContain("fixture-password");
    expect(output).not.toContain("FIXTURE_GIT_CREDENTIAL_CANARY");
    expect(output).not.toContain("FIXTURE_ONLY_DO_NOT_EXPORT_THIS_PEM_CANARY");
  });
});
