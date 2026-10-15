import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { failCodeAnalysisRun } from "@/lib/code-intelligence/service";
import {
  isTransientGitHubTransportFailure,
  safeInstallationError,
} from "@/lib/preflight/github-provider";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  executeCodeAnalysisStages,
  normalizeCodeAnalysisFailure,
  type CodeAnalysisFailureStage,
} from "@/lib/code-intelligence/failures";

vi.mock("server-only", () => ({}));

const stages: Array<{
  stage: CodeAnalysisFailureStage;
  expectedCategory: string;
}> = [
  { stage: "environment_validation", expectedCategory: "environment_invalid" },
  { stage: "github_provider_setup", expectedCategory: "analysis_failed" },
  { stage: "repository_materialization", expectedCategory: "analysis_failed" },
  { stage: "snapshot_collection", expectedCategory: "snapshot_collection_failed" },
  { stage: "static_analysis", expectedCategory: "static_analysis_failed" },
  { stage: "analysis_persistence", expectedCategory: "analysis_persistence_failed" },
];

async function runFailureAt(failureStage: CodeAnalysisFailureStage, cleanupFails = false) {
  const calls: string[] = [];
  const actions: string[] = [];
  const persistedFacts: string[] = [];
  const canary = "CANARY_SOURCE_AND_SECRET_MUST_NOT_ESCAPE";
  const fail = (stage: CodeAnalysisFailureStage) => {
    calls.push(stage);
    if (failureStage === stage) throw new Error(`untrusted exception ${canary}`);
  };
  const outcome = await executeCodeAnalysisStages({
    validateEnvironment: () => {
      fail("environment_validation");
      return { safe: true };
    },
    setupProvider: () => {
      fail("github_provider_setup");
      return { provider: true };
    },
    materialize: async () => fail("repository_materialization"),
    collectSnapshot: async () => {
      fail("snapshot_collection");
      return [{ path: "src/example.ts", text: "safe fixture" }];
    },
    analyze: () => {
      fail("static_analysis");
      return { references: ["structural-fact"] };
    },
    persist: async () => {
      fail("analysis_persistence");
      persistedFacts.push("completed-fact");
    },
    cleanup: async () => {
      calls.push("cleanup");
      if (cleanupFails) throw new Error(`cleanup error ${canary}`);
    },
  });

  return { outcome, calls, actions, persistedFacts, canary };
}

describe("Code Intelligence failure-stage safety", () => {
  it.each(stages)(
    "attributes $stage without returning raw errors or success facts",
    async ({ stage, expectedCategory }) => {
      const result = await runFailureAt(stage);
      expect(result.outcome).toMatchObject({
        ok: false,
        failure: { stage, category: expectedCategory, retryable: false },
        cleanupFailed: false,
      });
      expect(result.outcome).not.toHaveProperty("analysis");
      expect(result.calls).toContain("cleanup");
      if (stage === "analysis_persistence") {
        expect(result.calls.indexOf("cleanup")).toBeLessThan(
          result.calls.indexOf("analysis_persistence"),
        );
      } else {
        expect(result.calls.at(-1)).toBe("cleanup");
      }
      expect(result.persistedFacts).toEqual([]);
      expect(result.actions).toEqual([]);
      expect(JSON.stringify(result.outcome)).not.toContain(result.canary);
    },
  );

  it("keeps the primary failure when cleanup also fails", async () => {
    const result = await runFailureAt("repository_materialization", true);
    expect(result.outcome).toMatchObject({
      ok: false,
      failure: {
        stage: "repository_materialization",
        category: "analysis_failed",
        retryable: false,
      },
      cleanupFailed: true,
    });
    expect(JSON.stringify(result.outcome)).not.toContain(result.canary);
  });

  it("does not persist completion when cleanup fails", async () => {
    let persistCalls = 0;
    const outcome = await executeCodeAnalysisStages({
      validateEnvironment: () => ({ safe: true }),
      setupProvider: () => ({ provider: true }),
      materialize: async () => {},
      collectSnapshot: async () => ["bounded snapshot"],
      analyze: (snapshot) => ({ snapshot }),
      persist: async () => {
        persistCalls += 1;
      },
      cleanup: async () => {
        throw new Error("cleanup secret canary");
      },
    });
    expect(outcome).toMatchObject({
      ok: false,
      failure: { stage: null, category: "analysis_failed", retryable: false },
      cleanupFailed: true,
    });
    expect(persistCalls).toBe(0);
    expect(outcome).not.toHaveProperty("analysis");
  });

  it("classifies cleanup-only failure without a primary stage", async () => {
    const outcome = await executeCodeAnalysisStages({
      validateEnvironment: () => ({ safe: true }),
      setupProvider: () => ({ provider: true }),
      materialize: async () => {},
      collectSnapshot: async () => ["bounded snapshot"],
      analyze: (snapshot) => ({ snapshot }),
      persist: async () => {
        throw new Error("must_not_persist");
      },
      cleanup: async () => {
        throw new Error("cleanup secret canary");
      },
    });
    expect(outcome).toMatchObject({
      ok: false,
      failure: { stage: null, category: "analysis_failed", retryable: false },
      cleanupFailed: true,
    });
    expect(JSON.stringify(outcome)).not.toContain("cleanup secret canary");
  });

  it("retries only typed transient GitHub failures", () => {
    expect(isTransientGitHubTransportFailure({ cause: { code: "ETIMEDOUT" } })).toBe(true);
    expect(isTransientGitHubTransportFailure(new Error("arbitrary programming failure"))).toBe(
      false,
    );
    const transportFailure = safeInstallationError("repository_archive", {
      cause: { code: "ETIMEDOUT" },
    });
    expect(normalizeCodeAnalysisFailure("repository_materialization", transportFailure)).toEqual({
      stage: "repository_materialization",
      category: "github_provider_unavailable",
      retryable: true,
    });
    expect(
      normalizeCodeAnalysisFailure("repository_materialization", {
        name: "GitHubAppInstallationError",
        category: "rate_limited",
      }),
    ).toEqual({
      stage: "repository_materialization",
      category: "github_rate_limited",
      retryable: true,
    });
    expect(
      normalizeCodeAnalysisFailure("repository_materialization", {
        name: "GitHubAppInstallationError",
        category: "permission_denied",
      }),
    ).toEqual({
      stage: "repository_materialization",
      category: "github_permission_denied",
      retryable: false,
    });
    expect(
      normalizeCodeAnalysisFailure("github_provider_setup", new Error("github_app_not_configured")),
    ).toEqual({
      stage: "github_provider_setup",
      category: "github_config_unavailable",
      retryable: false,
    });
    expect(normalizeCodeAnalysisFailure("static_analysis", { code: "ECONNRESET" })).toEqual({
      stage: "static_analysis",
      category: "static_analysis_failed",
      retryable: false,
    });
    expect(
      normalizeCodeAnalysisFailure("repository_materialization", new Error("unclassified")),
    ).toEqual({
      stage: "repository_materialization",
      category: "analysis_failed",
      retryable: false,
    });
  });

  it("treats a false failure RPC result as a claim mismatch", async () => {
    const client = {
      rpc: async () => ({ data: false, error: null }),
    } as unknown as SupabaseClient;
    await expect(
      failCodeAnalysisRun(
        {
          analysisRunId: "00000000-0000-4000-8000-000000000001",
          claimToken: "00000000-0000-4000-8000-000000000002",
          failureStage: "static_analysis",
          failureCategory: "static_analysis_failed",
          retryable: false,
        },
        client,
      ),
    ).rejects.toThrow("code_intelligence_failure_claim_mismatch");
  });
});
