import { describe, expect, it } from "vitest";
import {
  getVercelProjectDeploymentSnapshot,
  listVercelProjects,
  normalizeVercelConfiguration,
} from "@/lib/deployments/vercel";
import {
  decideDeploymentEvidence,
  normalizeDeploymentObservation,
  safeHttpsUrl,
} from "@/lib/deployments/model";

const workspaceId = "a0000000-0000-4000-8000-000000000001";
const productId = "b0000000-0000-4000-8000-000000000001";
const repositoryId = "c0000000-0000-4000-8000-000000000001";
const commit = "0123456789abcdef0123456789abcdef01234567";

function observation(
  overrides: Partial<Parameters<typeof normalizeDeploymentObservation>[0]> = {},
) {
  return normalizeDeploymentObservation({
    id: "dpl_current",
    target: "production",
    state: "READY",
    commitSha: commit,
    owner: "auterim",
    repository: "service",
    branch: "main",
    url: "auterim.com",
    createdAt: "2026-10-01T12:00:00.000Z",
    readyAt: "2026-10-01T12:01:00.000Z",
    observedAt: "2026-10-01T12:02:00.000Z",
    isCurrentProduction: true,
    ...overrides,
  })!;
}

function decide(input: {
  observed?: ReturnType<typeof observation>;
  proof?: {
    workspaceId?: string;
    productId?: string;
    repositoryId?: string;
    commitSha?: string;
    verified?: boolean;
  } | null;
  mappedProductId?: string | null;
  mappedRepositoryId?: string | null;
}) {
  return decideDeploymentEvidence({
    repositoryEvidence:
      input.proof === undefined
        ? { workspaceId, productId, repositoryId, commitSha: commit, verified: true }
        : input.proof && {
            workspaceId: input.proof.workspaceId ?? workspaceId,
            productId: input.proof.productId ?? productId,
            repositoryId: input.proof.repositoryId ?? repositoryId,
            commitSha: input.proof.commitSha ?? commit,
            verified: input.proof.verified ?? true,
          },
    mappedWorkspaceId: workspaceId,
    mappedProductId: input.mappedProductId === undefined ? productId : input.mappedProductId,
    mappedRepositoryId:
      input.mappedRepositoryId === undefined ? repositoryId : input.mappedRepositoryId,
    observation: input.observed ?? observation(),
  });
}

describe("M15.7 deployment evidence", () => {
  it("verifies only an exact verified repository commit on the current successful Production deployment", () => {
    expect(decide({}).state).toBe("production_verified");
  });

  it("keeps Preview, failed, mismatched, and historical deployments below Production verified", () => {
    expect(decide({ observed: observation({ target: "preview" }) }).state).toBe("commit_verified");
    expect(decide({ observed: observation({ state: "ERROR" }) }).state).toBe("commit_verified");
    expect(decide({ observed: observation({ commitSha: "f".repeat(40) }) }).state).toBe(
      "inconclusive",
    );
    expect(decide({ observed: observation({ isCurrentProduction: false }) }).state).toBe(
      "historical",
    );
  });

  it("does not infer Product or repository identity when mapping is missing, ambiguous, or mismatched", () => {
    expect(decide({ mappedProductId: null }).state).toBe("observed");
    expect(decide({ proof: { productId: "b0000000-0000-4000-8000-000000000002" } }).reason).toBe(
      "repository_mismatch",
    );
    expect(decide({ proof: { repositoryId: "c0000000-0000-4000-8000-000000000002" } }).state).toBe(
      "inconclusive",
    );
    expect(decide({ proof: null }).state).toBe("observed");
    expect(
      decideDeploymentEvidence({
        repositoryEvidence: {
          workspaceId,
          productId,
          repositoryId,
          commitSha: commit,
          verified: true,
        },
        mappedWorkspaceId: workspaceId,
        mappedProductId: productId,
        mappedRepositoryId: repositoryId,
        mappedRepositoryIdentity: { owner: "michelpronkk-oss", name: "auterim" },
        observation: observation(),
      }).state,
    ).toBe("inconclusive");
  });

  it("normalizes provider observations without unsafe URLs or malformed commit identifiers", () => {
    expect(safeHttpsUrl("https://user:pass@example.com/path?token=secret")).toBeNull();
    const value = observation({ commitSha: "not-a-sha", url: "auterim.com/path?token=secret" });
    expect(value.commitSha).toBeNull();
    expect(value.url).toBeNull();
    expect(JSON.stringify(value)).not.toContain("secret");
  });

  it("requires verified read scopes and binds the installation to the callback account", () => {
    const config = normalizeVercelConfiguration(
      {
        id: "icfg_auterim",
        teamId: "team_auterim",
        projectSelection: "selected",
        projects: ["prj_auterim"],
        scopes: [
          { name: "integration-configuration", accessLevel: "read" },
          { name: "project", accessLevel: "read" },
          { name: "deployment", accessLevel: "read" },
          { name: "domain", accessLevel: "read" },
          { name: "team", accessLevel: "read" },
        ],
      },
      { configurationId: "icfg_auterim", teamId: "team_auterim" },
    );
    expect(config.projects).toEqual(["prj_auterim"]);
    expect(config.scopes).not.toContain("project-env-vars:read");
    expect(() =>
      normalizeVercelConfiguration(
        {
          id: "icfg_auterim",
          teamId: "team_auterim",
          projectSelection: "selected",
          projects: ["prj_auterim"],
          scopes: [
            "integration-configuration:read",
            "project:read",
            "deployment:read",
            "domain:read",
            "team:read",
            "project-env-vars:write",
          ],
        },
        { configurationId: "icfg_auterim", teamId: "team_auterim" },
      ),
    ).toThrow();
    expect(() =>
      normalizeVercelConfiguration(
        {
          id: "icfg_other",
          teamId: "team_auterim",
          projectSelection: "selected",
          projects: ["prj_auterim"],
          scopes: config.scopes,
        },
        { configurationId: "icfg_auterim", teamId: "team_auterim" },
      ),
    ).toThrow();
    expect(() =>
      normalizeVercelConfiguration(
        {
          id: "icfg_auterim",
          teamId: "team_other",
          projectSelection: "all",
          scopes: config.scopes,
        },
        { configurationId: "icfg_auterim", teamId: "team_auterim" },
      ),
    ).toThrow();
  });

  it("fails closed when project scope or required read permissions are absent", () => {
    expect(() =>
      normalizeVercelConfiguration(
        {
          id: "icfg_auterim",
          teamId: null,
          projectSelection: "selected",
          projects: [],
          scopes: [],
        },
        { configurationId: "icfg_auterim", teamId: null },
      ),
    ).toThrow();
  });

  it("lists only projects authorized by a selected Vercel installation", async () => {
    const credentials = {
      accessToken: "test-token-never-logged",
      refreshToken: null,
      expiresAt: null,
      scopes: [],
      providerMetadata: { configurationId: "icfg_auterim", teamId: "team_auterim" },
    };
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname.startsWith("/v1/integrations/configuration/"))
        return Response.json({
          id: "icfg_auterim",
          teamId: "team_auterim",
          projectSelection: "selected",
          projects: ["prj_allowed"],
          scopes: [
            "integration-configuration:read",
            "project:read",
            "deployment:read",
            "domain:read",
            "team:read",
          ],
        });
      return Response.json({
        projects: [
          {
            id: "prj_allowed",
            name: "auterim",
            accountId: "team_auterim",
            link: { type: "github", org: "michelpronkk-oss", repo: "auterim" },
          },
          { id: "prj_other", name: "unrelated", accountId: "team_auterim" },
        ],
      });
    }) as typeof fetch;
    try {
      const projects = await listVercelProjects(credentials, "team_auterim");
      expect(projects.map((project) => project.id)).toEqual(["prj_allowed"]);
      expect(JSON.stringify(projects)).not.toContain(credentials.accessToken);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("identifies Production only through the current verified-domain alias and exact deployment commit", async () => {
    const credentials = {
      accessToken: "test-token-never-logged",
      refreshToken: null,
      expiresAt: null,
      scopes: [],
      providerMetadata: { configurationId: "icfg_auterim", teamId: "team_auterim" },
    };
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname.startsWith("/v1/integrations/configuration/"))
        return Response.json({
          id: "icfg_auterim",
          teamId: "team_auterim",
          projectSelection: "selected",
          projects: ["prj_allowed"],
          scopes: [
            "integration-configuration:read",
            "project:read",
            "deployment:read",
            "domain:read",
            "team:read",
          ],
        });
      if (url.pathname === "/v9/projects/prj_allowed")
        return Response.json({
          id: "prj_allowed",
          name: "auterim",
          accountId: "team_auterim",
          link: { type: "github", org: "michelpronkk-oss", repo: "auterim" },
        });
      if (url.pathname === "/v6/deployments")
        return Response.json({
          deployments: [
            {
              uid: "dpl_current",
              target: "production",
              readyState: "READY",
              gitSource: { sha: commit, org: "michelpronkk-oss", repo: "auterim", ref: "main" },
              url: "auterim-prod.vercel.app",
              createdAt: Date.parse("2026-10-01T12:00:00.000Z"),
              ready: Date.parse("2026-10-01T12:01:00.000Z"),
            },
            {
              uid: "dpl_preview",
              target: "preview",
              readyState: "READY",
              gitSource: { sha: commit, org: "michelpronkk-oss", repo: "auterim", ref: "feature" },
              url: "auterim-preview.vercel.app",
            },
            {
              uid: "dpl_failed",
              target: "production",
              readyState: "ERROR",
              gitSource: {
                sha: "f".repeat(40),
                org: "michelpronkk-oss",
                repo: "auterim",
                ref: "main",
              },
              url: "auterim-failed.vercel.app",
            },
          ],
        });
      if (url.pathname.endsWith("/domains"))
        return Response.json({
          domains: [
            { name: "auterim.com", verified: true },
            { name: "unverified.example", verified: false },
          ],
        });
      if (url.pathname === "/v4/aliases/auterim.com")
        return Response.json({ deploymentId: "dpl_current" });
      throw new Error("unexpected_test_request");
    }) as typeof fetch;
    try {
      const result = await getVercelProjectDeploymentSnapshot(
        credentials,
        "prj_allowed",
        "team_auterim",
      );
      expect(result.currentProductionDeploymentId).toBe("dpl_current");
      expect(
        result.observations.find((deployment) => deployment.providerDeploymentId === "dpl_current")
          ?.isCurrentProduction,
      ).toBe(true);
      expect(
        result.observations.find((deployment) => deployment.providerDeploymentId === "dpl_preview")
          ?.isCurrentProduction,
      ).toBe(false);
      expect(result.observations).toHaveLength(3);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
