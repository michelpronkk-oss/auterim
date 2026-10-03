import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEnvironment, isIntegrationConfigured } from "../src/lib/env/schema.ts";
import { GitHubAppRepositoryProvider } from "../src/lib/preflight/github-provider.ts";
import { inspectRepositories, type PreflightChange } from "../src/lib/preflight/preflight.ts";

function readAuterimEnvironment() {
  let contents: string;
  try {
    contents = readFileSync(".env.local", "utf8");
  } catch {
    return parseEnvironment({});
  }
  const entries = contents.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return [];
    const separator = trimmed.indexOf("=");
    if (separator < 1) return [];
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    return [[key, value]];
  });
  return parseEnvironment(Object.fromEntries(entries));
}

const environment = readAuterimEnvironment();
const safeFixture =
  environment.AUTERIM_PREFLIGHT_LIVE === "1" &&
  isIntegrationConfigured("githubApp", environment) &&
  environment.AUTERIM_PREFLIGHT_FIXTURE_OWNER === "michelpronkk-oss" &&
  Boolean(
    environment.AUTERIM_PREFLIGHT_FIXTURE_REPOSITORY?.startsWith("auterim-preflight-fixture"),
  ) &&
  Boolean(environment.AUTERIM_PREFLIGHT_FIXTURE_INSTALLATION_ID) &&
  Boolean(environment.AUTERIM_PREFLIGHT_FIXTURE_REPOSITORY_ID) &&
  Boolean(environment.AUTERIM_PREFLIGHT_FIXTURE_BRANCH) &&
  Boolean(environment.AUTERIM_PREFLIGHT_FIXTURE_ENTITY);

describe("opt-in Auterim GitHub Preflight live fixture", () => {
  it.skipIf(!safeFixture)(
    "reads one bounded known marker from the dedicated Auterim fixture repository",
    async () => {
      const repository = {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        owner: environment.AUTERIM_PREFLIGHT_FIXTURE_OWNER!,
        name: environment.AUTERIM_PREFLIGHT_FIXTURE_REPOSITORY!,
        defaultBranch: environment.AUTERIM_PREFLIGHT_FIXTURE_BRANCH!,
        externalId: environment.AUTERIM_PREFLIGHT_FIXTURE_REPOSITORY_ID!,
        installationId: environment.AUTERIM_PREFLIGHT_FIXTURE_INSTALLATION_ID!,
      };
      const entity = environment.AUTERIM_PREFLIGHT_FIXTURE_ENTITY!;
      const change: PreflightChange = {
        assessmentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        workspaceDependencyId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        dependencyName: "Auterim fixture marker",
        material: true,
        relevant: true,
        severity: "low",
        summary: "Fixture validation of one known marker.",
        impactSummary: "Validate a known configured marker.",
        whyItMatters: "This confirms repository scanning is wired correctly.",
        recommendedAction: null,
        contextCriticality: "normal",
        productionCritical: false,
        affectedEntities: [entity],
        evidence: [entity],
        contextUsedFor: [],
        effectiveAt: null,
        announcedAt: null,
        deadline: null,
      };
      const provider = new GitHubAppRepositoryProvider({
        appId: environment.GITHUB_APP_ID,
        privateKey: environment.GITHUB_APP_PRIVATE_KEY,
      });
      const result = await inspectRepositories({ change, repositories: [repository], provider });
      expect(result.repositoriesScanned).toBe(1);
      expect(result.findings.length).toBeLessThanOrEqual(40);
    },
    60_000,
  );
});
