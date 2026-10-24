import { describe, expect, it, vi } from "vitest";
import {
  analyzeCurrentProduction,
  productionAnalysisKey,
  PRODUCTION_EXPOSURE_ISSUANCE_ENABLED,
  type ProductionBinding,
  type ProductionGraph,
} from "@/lib/coverage-certification/production-analysis";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = new Date("2026-10-24T20:00:00Z");
const request = {
  workspaceId: id(1),
  productId: id(2),
  repositoryId: id(3),
  surfaceId: id(4),
  seedGraphBuildId: id(5),
};
const binding: ProductionBinding = {
  ...request,
  routeIntentId: id(6),
  deploymentId: "dpl_current",
  commitSha: "a".repeat(40),
  observationId: id(7),
  evidenceId: id(8),
  syncAttemptId: id(9),
  syncCompletedAt: now.toISOString(),
  observedAt: now.toISOString(),
};
const graph: ProductionGraph = {
  id: id(10),
  workspaceId: id(1),
  productId: id(2),
  repositoryId: id(3),
  routeIntentId: id(6),
  commitSha: binding.commitSha,
  status: "completed",
  assessmentState: "evidence_present",
  analysisProfile: "javascript-typescript-v2.3",
  coverageState: "complete",
};
function deps() {
  return {
    readBinding: vi.fn().mockResolvedValue(binding),
    analyze: vi.fn().mockResolvedValue(id(11)),
    buildGraph: vi.fn().mockResolvedValue(graph),
    now: vi.fn(() => now),
  };
}

describe("current Production exposure coordinator (issuance disabled)", () => {
  it("analyzes the deployed SHA, binds exact identities and only prepares Step 4a RPC arguments", async () => {
    const d = deps();
    const result = await analyzeCurrentProduction(request, d);
    expect(result).toMatchObject({
      status: "preview",
      state: "proven",
      issuanceEnabled: false,
      binding: { deploymentId: "dpl_current", commitSha: binding.commitSha },
      issueArguments: {
        p_product_deployment_evidence_id: id(8),
        p_deployment_sync_attempt_id: id(9),
        p_graph_build_id: id(10),
        p_exposure_state: "proven",
      },
    });
    expect(d.analyze).toHaveBeenCalledExactlyOnceWith(binding, productionAnalysisKey(binding));
    expect(d.readBinding).toHaveBeenCalledTimes(2);
    expect(PRODUCTION_EXPOSURE_ISSUANCE_ENABLED).toBe(false);
  });
  it("replays the same bounded analysis/graph identity without a new assessment", async () => {
    expect(await analyzeCurrentProduction(request, deps())).toEqual(
      await analyzeCurrentProduction(request, deps()),
    );
  });
  it.each([
    "workspaceId",
    "productId",
    "repositoryId",
    "surfaceId",
    "routeIntentId",
    "deploymentId",
    "commitSha",
  ] as const)("includes %s in orchestration idempotency", (field) => {
    expect(productionAnalysisKey({ ...binding, [field]: "different" })).not.toBe(
      productionAnalysisKey(binding),
    );
  });
  it.each(["workspaceId", "productId", "repositoryId", "surfaceId", "seedGraphBuildId"] as const)(
    "rejects cross-scope %s before any analysis",
    async (field) => {
      const d = deps();
      d.readBinding.mockResolvedValue({ ...binding, [field]: id(99) });
      expect(await analyzeCurrentProduction(request, d)).toMatchObject({ state: "unknown" });
      expect(d.analyze).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    { ...binding, commitSha: "main" },
    { ...binding, observedAt: "invalid" },
    { ...binding, observedAt: "2026-10-24T20:00:01Z" },
    { ...binding, observedAt: "2026-10-24T19:57:59Z" },
    { ...binding, syncCompletedAt: "2026-10-23T20:00:00Z" },
    { ...binding, syncCompletedAt: "invalid" },
    { ...binding, syncCompletedAt: "2026-10-24T20:00:01Z" },
    { ...binding, evidenceId: "bad" },
  ])("fails closed on missing, stale, future or malformed initial evidence %#", async (value) => {
    const d = deps();
    d.readBinding.mockResolvedValue(value);
    expect(await analyzeCurrentProduction(request, d)).toMatchObject({ state: "unknown" });
    expect(d.analyze).not.toHaveBeenCalled();
  });
  it.each([
    "deploymentId",
    "commitSha",
    "observationId",
    "evidenceId",
    "syncAttemptId",
    "syncCompletedAt",
    "routeIntentId",
  ] as const)("fails closed on a %s race, including same-commit redeploys", async (field) => {
    const d = deps();
    const changed =
      field === "commitSha"
        ? "b".repeat(40)
        : field === "deploymentId"
          ? "dpl_same_commit_redeploy"
          : field === "syncCompletedAt"
            ? "2026-10-24T19:59:59Z"
            : id(99);
    d.readBinding
      .mockResolvedValueOnce(binding)
      .mockResolvedValueOnce({ ...binding, [field]: changed });
    expect(await analyzeCurrentProduction(request, d)).toMatchObject({
      status: "unknown",
      state: "unknown",
    });
  });
  it("fails closed if mappings/credentials are revoked during analysis", async () => {
    const d = deps();
    d.readBinding.mockResolvedValueOnce(binding).mockResolvedValueOnce(null);
    expect(await analyzeCurrentProduction(request, d)).toMatchObject({ state: "unknown" });
  });
  it.each(["workspaceId", "productId", "repositoryId", "routeIntentId", "commitSha"] as const)(
    "rejects graph %s mismatch",
    async (field) => {
      const d = deps();
      d.buildGraph.mockResolvedValue({ ...graph, [field]: "wrong" });
      await expect(analyzeCurrentProduction(request, d)).rejects.toThrow("graph_identity_mismatch");
    },
  );
  it.each([
    ["absence_observed", "complete", "javascript-typescript-v2.3", "completed", "disproven"],
    ["absence_observed", "partial", "javascript-typescript-v2.3", "completed", "unknown"],
    ["absence_observed", "complete", "old-profile", "completed", "unknown"],
    ["unknown_incomplete", "complete", "javascript-typescript-v2.3", "completed", "unknown"],
    ["evidence_present", "complete", "javascript-typescript-v2.3", "building", "unknown"],
    ["failed", "failed", "javascript-typescript-v2.3", "failed", "unknown"],
  ])(
    "uses existing classification rules: %s/%s/%s/%s -> %s",
    async (assessmentState, coverageState, analysisProfile, status, state) => {
      const d = deps();
      d.buildGraph.mockResolvedValue({
        ...graph,
        assessmentState,
        coverageState,
        analysisProfile,
        status,
      });
      expect(await analyzeCurrentProduction(request, d)).toMatchObject({ state });
    },
  );
  it("does not persist or retry internally when a child fails", async () => {
    const d = deps();
    d.analyze.mockRejectedValue(new Error("child_failed"));
    await expect(analyzeCurrentProduction(request, d)).rejects.toThrow("child_failed");
    expect(d.analyze).toHaveBeenCalledTimes(1);
    expect(d.buildGraph).not.toHaveBeenCalled();
  });
  it("re-resolves the deployment on the next attempt", async () => {
    const d = deps();
    d.analyze.mockRejectedValueOnce(new Error("transient"));
    await expect(analyzeCurrentProduction(request, d)).rejects.toThrow();
    d.readBinding.mockResolvedValue({ ...binding, deploymentId: "dpl_new" });
    expect(await analyzeCurrentProduction(request, d)).toMatchObject({
      binding: { deploymentId: "dpl_new" },
    });
    expect(d.analyze.mock.calls[0][1]).not.toBe(d.analyze.mock.calls[1][1]);
  });
  it("rejects caller-supplied commits and issuance switches", async () => {
    for (const extra of [
      { commitSha: "b".repeat(40) },
      { issue: true },
      { issuanceEnabled: true },
    ]) {
      const d = deps();
      await expect(analyzeCurrentProduction({ ...request, ...extra }, d)).rejects.toThrow();
      expect(d.readBinding).not.toHaveBeenCalled();
    }
  });
  it("returns unknown when the wall-time budget expires even with fresh provider reads", async () => {
    const d = deps();
    const later = new Date(now.getTime() + 601_000);
    d.now.mockReturnValueOnce(now).mockReturnValueOnce(now).mockReturnValue(later);
    d.readBinding
      .mockResolvedValueOnce(binding)
      .mockResolvedValueOnce({ ...binding, observedAt: later.toISOString() });
    expect(await analyzeCurrentProduction(request, d)).toMatchObject({
      state: "unknown",
      reason: "graph_evidence_incomplete",
    });
  });
});
