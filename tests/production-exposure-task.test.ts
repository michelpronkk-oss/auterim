import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: vi.fn(),
  coordinate: vi.fn(),
  analyze: vi.fn(),
  graph: vi.fn(),
  readBinding: vi.fn(),
  readGraph: vi.fn(),
  key: vi.fn(async (key: string) => key),
}));
vi.mock("@trigger.dev/sdk", () => ({
  schemaTask: (definition: unknown) => definition,
  AbortTaskRunError: class extends Error {},
  idempotencyKeys: { create: mocks.key },
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.client }));
vi.mock("@/lib/coverage-certification/production-analysis", async (original) => ({
  ...(await original<typeof import("@/lib/coverage-certification/production-analysis")>()),
  analyzeCurrentProduction: mocks.coordinate,
}));
vi.mock("@/lib/coverage-certification/production-repository", () => ({
  readProductionBinding: mocks.readBinding,
  readProductionGraph: mocks.readGraph,
}));
vi.mock("@/trigger/analyze-protected-repository-code", () => ({
  analyzeProtectedRepositoryCodeTask: { triggerAndWait: mocks.analyze },
}));
vi.mock("@/trigger/build-provider-impact-graph", () => ({
  buildProviderImpactGraphTask: { triggerAndWait: mocks.graph },
}));
import { analyzeCurrentProductionExposureTask } from "@/trigger/analyze-current-production-exposure";
import type {
  ProductionAnalysisDependencies,
  ProductionBinding,
} from "@/lib/coverage-certification/production-analysis";

const definition = analyzeCurrentProductionExposureTask as unknown as {
  run(payload: unknown, context: { ctx: { environment: { type: string } } }): Promise<unknown>;
};
const binding = {
  workspaceId: "workspace",
  productId: "product",
  repositoryId: "repository",
  routeIntentId: "route",
  commitSha: "a".repeat(40),
} as ProductionBinding;
beforeEach(() => {
  vi.stubEnv("AUTERIM_M15_LOCAL_INTEGRATION", "1");
  vi.clearAllMocks();
});
describe("dormant Production exposure task", () => {
  it("also rejects development with a remote database configuration", async () => {
    vi.stubEnv("AUTERIM_M15_LOCAL_INTEGRATION", "0");
    await expect(
      definition.run({}, { ctx: { environment: { type: "DEVELOPMENT" } } }),
    ).rejects.toThrow("activation_disabled");
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it.each(["PRODUCTION", "STAGING", "PREVIEW", "", "unknown"])(
    "rejects %s before any privileged client or child task",
    async (type) => {
      await expect(definition.run({}, { ctx: { environment: { type } } })).rejects.toThrow(
        "activation_disabled",
      );
      expect(mocks.client).not.toHaveBeenCalled();
      expect(mocks.coordinate).not.toHaveBeenCalled();
      expect(mocks.analyze).not.toHaveBeenCalled();
      expect(mocks.graph).not.toHaveBeenCalled();
    },
  );
  it("awaits exact-commit children, checks their Result and reads scoped graph evidence", async () => {
    mocks.analyze.mockResolvedValue({
      ok: true,
      output: { status: "completed", analysisRunId: "analysis" },
    });
    mocks.graph.mockResolvedValue({ ok: true, output: { graphBuildId: "graph" } });
    mocks.coordinate.mockImplementation(
      async (_request: unknown, dependencies: ProductionAnalysisDependencies) => {
        const analysis = await dependencies.analyze(binding, "key");
        return dependencies.buildGraph(binding, analysis, "key");
      },
    );
    await definition.run({}, { ctx: { environment: { type: "DEVELOPMENT" } } });
    expect(mocks.analyze).toHaveBeenCalledWith(
      {
        workspaceId: "workspace",
        productId: "product",
        repositoryId: "repository",
        routeIntentId: "route",
        commitSha: "a".repeat(40),
      },
      expect.objectContaining({ idempotencyKeyTTL: "1h" }),
    );
    expect(mocks.key).toHaveBeenCalledWith("key:analysis", { scope: "global" });
    expect(mocks.readGraph).toHaveBeenCalledWith(undefined, binding, "graph", "analysis");
  });
  it("does not build a graph after failed analysis or log the child's raw error", async () => {
    mocks.analyze.mockResolvedValue({ ok: false, error: { message: "secret token" } });
    mocks.coordinate.mockImplementation(
      async (_request: unknown, dependencies: ProductionAnalysisDependencies) =>
        dependencies.analyze(binding, "key"),
    );
    await expect(
      definition.run({}, { ctx: { environment: { type: "DEVELOPMENT" } } }),
    ).rejects.toThrow(/^production_analysis_child_failed$/);
    expect(mocks.graph).not.toHaveBeenCalled();
  });
});
