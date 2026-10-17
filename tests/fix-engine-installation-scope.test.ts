import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { inspectGitHubInstallationScope } from "../src/lib/fix-engine/github-write-token";
import {
  hasExpectedActiveProductRepositoryMappings,
  diagnosePreflightEntitlement,
  M1578RInternalTestAcceptanceInputSchema,
} from "../src/trigger/m1578r-internal-test-acceptance";

const repositoryId = 1_409_364_414;
const fixtureSha = "a".repeat(40);
const installationToken = "installation-token-for-scope-read-only-test";
const requiredPaths = [
  "package.json",
  "package-lock.json",
  "jest.config.js",
  "src/endpoint.js",
  "src/types.ts",
  "test/endpoint.test.js",
  "tsconfig.json",
];

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function scopeFetcher(
  options: {
    repositories?: Array<Record<string, unknown>>;
    permissions?: Record<string, unknown>;
  } = {},
) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
    if (url === "https://api.github.com/app") return response({ id: 123 });
    if (url.endsWith("/app/installations/456")) {
      return response({
        id: 456,
        app_id: 123,
        account: { login: "michelpronkk-oss" },
        repository_selection: "selected",
        permissions: options.permissions ?? {
          contents: "write",
          pull_requests: "write",
          metadata: "read",
        },
        suspended_at: null,
      });
    }
    if (url.endsWith("/app/installations/456/access_tokens")) {
      return response({
        token: installationToken,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        permissions: { contents: "read", metadata: "read" },
      });
    }
    if (url.endsWith("/installation/repositories?per_page=100")) {
      return response({
        total_count: options.repositories?.length ?? 1,
        repositories: options.repositories ?? [
          {
            id: repositoryId,
            full_name: "michelpronkk-oss/auterim-m15-github-qa",
          },
        ],
      });
    }
    if (url.endsWith("/branches/main")) return response({ commit: { sha: fixtureSha } });
    if (url.includes("/git/trees/")) {
      return response({
        truncated: false,
        tree: [
          ...requiredPaths.map((path) => ({ path, type: "blob" })),
          { path: "node_modules/fsevents/package-lock.json", type: "blob" },
        ],
      });
    }
    throw new Error(`unexpected_test_request:${url}`);
  });
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    fetcher: fetcher as typeof fetch,
    calls,
  };
}

const baseInput = {
  appId: "123",
  installationId: 456,
  expectedAccountLogin: "michelpronkk-oss",
  repositoryId,
  owner: "michelpronkk-oss",
  repository: "auterim-m15-github-qa",
  defaultBranch: "main",
  requiredPaths,
};

describe("M15.78R bounded GitHub installation inspection", () => {
  it("proves the exact selected QA-only installation using a temporary read-only token", async () => {
    const fixture = scopeFetcher();
    const result = await inspectGitHubInstallationScope({
      ...baseInput,
      privateKey: fixture.privateKey,
      fetcher: fixture.fetcher,
    });

    expect(result).toMatchObject({
      appIdentityMatches: true,
      installationIdentityMatches: true,
      accountLogin: "michelpronkk-oss",
      installationActive: true,
      selectedRepositoriesOnly: true,
      requiredWritePermissionsGranted: true,
      noUnexpectedWritePermissions: true,
      visibleRepositoryCount: 1,
      exactRepositoryVisible: true,
      defaultBranch: "main",
      defaultBranchSha: fixtureSha,
      requiredPathsPresent: true,
      npmLockfileFamily: "npm",
    });
    expect(JSON.stringify(result)).not.toContain(installationToken);
    const tokenRequest = fixture.calls.find((call) => call.url.endsWith("/access_tokens"));
    expect(tokenRequest?.method).toBe("POST");
    expect(JSON.parse(tokenRequest?.body ?? "{}")).toEqual({ permissions: { contents: "read" } });
  });

  it("stops before repository metadata reads when the installation has unexpected write scope", async () => {
    const fixture = scopeFetcher({
      permissions: {
        contents: "write",
        pull_requests: "write",
        metadata: "read",
        administration: "write",
      },
    });
    const result = await inspectGitHubInstallationScope({
      ...baseInput,
      privateKey: fixture.privateKey,
      fetcher: fixture.fetcher,
    });

    expect(result.noUnexpectedWritePermissions).toBe(false);
    expect(result.visibleRepositoryCount).toBeNull();
    expect(fixture.calls.some((call) => call.url.endsWith("/access_tokens"))).toBe(false);
  });

  it("stops on a broad visible repository set before reading the QA branch", async () => {
    const fixture = scopeFetcher({
      repositories: [
        { id: repositoryId, full_name: "michelpronkk-oss/auterim-m15-github-qa" },
        { id: 44, full_name: "michelpronkk-oss/unrelated" },
      ],
    });
    const result = await inspectGitHubInstallationScope({
      ...baseInput,
      privateKey: fixture.privateKey,
      fetcher: fixture.fetcher,
    });

    expect(result.visibleRepositoryCount).toBe(2);
    expect(result.exactRepositoryVisible).toBe(false);
    expect(fixture.calls.some((call) => call.url.endsWith("/branches/main"))).toBe(false);
  });
});

describe("M15.78R internal source operator payload", () => {
  it("requires the QA and preserved Auterim repositories as the only active Product mappings", () => {
    expect(
      hasExpectedActiveProductRepositoryMappings([
        { repository_id: "b2abf377-2dbc-4b9c-b546-b0604f3ee4fe", status: "active" },
        { repository_id: "3b4f4fe6-cbbd-4bbd-a340-71f7c268e2c4", status: "active" },
      ]),
    ).toBe(true);
    expect(
      hasExpectedActiveProductRepositoryMappings([
        { repository_id: "b2abf377-2dbc-4b9c-b546-b0604f3ee4fe", status: "active" },
        { repository_id: "3b4f4fe6-cbbd-4bbd-a340-71f7c268e2c4", status: "active" },
        { repository_id: "historical-repository-id", status: "inactive" },
      ]),
    ).toBe(true);
    expect(
      hasExpectedActiveProductRepositoryMappings([
        { repository_id: "b2abf377-2dbc-4b9c-b546-b0604f3ee4fe", status: "active" },
      ]),
    ).toBe(false);
    expect(
      hasExpectedActiveProductRepositoryMappings([
        { repository_id: "b2abf377-2dbc-4b9c-b546-b0604f3ee4fe", status: "active" },
        { repository_id: "3b4f4fe6-cbbd-4bbd-a340-71f7c268e2c4", status: "active" },
        { repository_id: "another-repository-id", status: "active" },
      ]),
    ).toBe(false);
    expect(
      hasExpectedActiveProductRepositoryMappings([
        { repository_id: "b2abf377-2dbc-4b9c-b546-b0604f3ee4fe", status: "active" },
        { repository_id: "3b4f4fe6-cbbd-4bbd-a340-71f7c268e2c4", status: "active" },
        { repository_id: "historical-repository-id", status: "revoked" },
      ]),
    ).toBe(false);
  });

  it("accepts only verify or exact-commit source creation requests", () => {
    expect(M1578RInternalTestAcceptanceInputSchema.safeParse({ action: "verify" }).success).toBe(
      true,
    );
    expect(
      M1578RInternalTestAcceptanceInputSchema.safeParse({
        action: "create_source",
        fixtureCommitSha: fixtureSha,
      }).success,
    ).toBe(true);
    expect(
      M1578RInternalTestAcceptanceInputSchema.safeParse({
        action: "create_source",
        fixtureCommitSha: fixtureSha,
        workspaceId: "00000000-0000-0000-0000-000000000000",
      }).success,
    ).toBe(false);
    expect(
      M1578RInternalTestAcceptanceInputSchema.safeParse({
        action: "create_source",
      }).success,
    ).toBe(false);
    expect(
      M1578RInternalTestAcceptanceInputSchema.safeParse({
        action: "diagnose_entitlement",
      }).success,
    ).toBe(true);
    expect(
      M1578RInternalTestAcceptanceInputSchema.safeParse({
        action: "diagnose_entitlement",
        workspaceId: "00000000-0000-0000-0000-000000000000",
      }).success,
    ).toBe(false);
  });

  it("reports the canonical trial, subscription, period, plan, and quota denial reasons", () => {
    const serverNow = "2026-10-17T12:00:00.000Z";
    const snapshot = (subscription: Record<string, unknown> | null) => ({
      serverNow,
      subscription,
    });

    expect(
      diagnosePreflightEntitlement({ snapshot: snapshot(null), preflightRuns: 0 }),
    ).toMatchObject({
      status: "ineligible",
      failureReasons: ["subscription_missing"],
    });
    expect(
      diagnosePreflightEntitlement({
        snapshot: snapshot({
          plan: "pro",
          status: "trialing",
          trialStartedAt: "2026-10-01T00:00:00.000Z",
          trialEndsAt: "2026-10-06T00:00:00.000Z",
        }),
        preflightRuns: 0,
      }),
    ).toMatchObject({ status: "ineligible", failureReasons: ["trial_expired"] });
    expect(
      diagnosePreflightEntitlement({
        snapshot: snapshot({ plan: "pro", status: "past_due" }),
        preflightRuns: 0,
      }),
    ).toMatchObject({ status: "ineligible", failureReasons: ["subscription_past_due"] });
    expect(
      diagnosePreflightEntitlement({
        snapshot: snapshot({
          plan: "pro",
          status: "active",
          currentPeriodEnd: "2026-10-16T00:00:00.000Z",
        }),
        preflightRuns: 0,
      }),
    ).toMatchObject({ status: "ineligible", failureReasons: ["current_period_expired"] });
    expect(
      diagnosePreflightEntitlement({
        snapshot: snapshot({
          plan: "core",
          status: "active",
          currentPeriodEnd: "2026-11-16T00:00:00.000Z",
        }),
        preflightRuns: 0,
      }),
    ).toMatchObject({ status: "ineligible", failureReasons: ["plan_not_preflight_eligible"] });
    expect(
      diagnosePreflightEntitlement({
        snapshot: snapshot({
          plan: "pro",
          status: "active",
          currentPeriodEnd: "2026-11-16T00:00:00.000Z",
        }),
        preflightRuns: 501,
      }),
    ).toMatchObject({ status: "ineligible", failureReasons: ["preflight_usage_limit_exceeded"] });
    expect(
      diagnosePreflightEntitlement({
        snapshot: snapshot({
          plan: "pro",
          status: "active",
          currentPeriodEnd: "2026-11-16T00:00:00.000Z",
        }),
        preflightRuns: 500,
      }),
    ).toMatchObject({ status: "eligible", failureReasons: [] });
  });
});
