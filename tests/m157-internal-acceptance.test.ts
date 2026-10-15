import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  server: vi.fn(),
  executeBaseline: vi.fn(),
  runDeploymentAcceptance: vi.fn(),
  candidates: [] as Array<Record<string, unknown>>,
  mappings: new Set<string>(),
}));

vi.mock("@/lib/connectors/service", () => ({ serverConnectors: mocks.server }));
vi.mock("@/lib/preflight/baseline-executor", () => ({
  BaselinePreflightError: class BaselinePreflightError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  executeBaselinePreflight: mocks.executeBaseline,
}));
vi.mock("@/lib/m15/deployment-acceptance", () => ({
  runM157DeploymentAcceptance: mocks.runDeploymentAcceptance,
}));

import { runM157InternalAcceptance } from "@/lib/m15/internal-acceptance";

const actorUserId = "55555555-5555-4555-8555-555555555555";
const repository = {
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "e140d48e-9dc0-4552-a9a4-a81fe3872422",
  owner: "michelpronkk-oss",
  name: "auterim",
  status: "available",
  selected_for_protection: true,
};
const baseline = {
  preflightRunId: "22222222-2222-4222-8222-222222222222",
  mode: "baseline" as const,
  evidenceId: "33333333-3333-4333-8333-333333333333",
  repositoryId: repository.id,
  repository: "michelpronkk-oss/auterim",
  verifiedCommitSha: "a".repeat(40),
  verificationState: "verified" as const,
  observedAt: "2026-10-15T12:00:00.000Z",
  replayed: false,
};

function queryResult(table: string) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    limit: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({
      data: mocks.mappings.has(repository.id) ? { repository_id: repository.id } : null,
      error: null,
    })),
    then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve({
        data: table === "repositories" ? mocks.candidates : [],
        error: null,
      }).then(resolve, reject),
  };
  return query;
}

describe("fixed-target M15.7 internal baseline orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.candidates = [repository];
    mocks.mappings = new Set([repository.id]);
    mocks.server.mockReturnValue({
      from: vi.fn((table: string) => queryResult(table)),
    });
    mocks.executeBaseline.mockResolvedValue(baseline);
    mocks.runDeploymentAcceptance.mockResolvedValue({ status: "complete" });
  });

  it("uses the fixed protected repository and persists baseline before deployment acceptance", async () => {
    const result = await runM157InternalAcceptance(actorUserId);

    expect(mocks.executeBaseline).toHaveBeenCalledOnce();
    expect(mocks.executeBaseline).toHaveBeenCalledWith({
      service: expect.any(Object),
      actorUserId,
      workspaceId: "e140d48e-9dc0-4552-a9a4-a81fe3872422",
      productId: "de1f2a12-de3c-4644-8892-b6c2d458a300",
      repositoryId: repository.id,
    });
    expect(mocks.runDeploymentAcceptance).toHaveBeenCalledOnce();
    expect(mocks.runDeploymentAcceptance).toHaveBeenCalledWith({ freshBaseline: baseline });
    expect(mocks.executeBaseline.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runDeploymentAcceptance.mock.invocationCallOrder[0]!,
    );
    expect(result).toEqual({ status: "complete" });
  });

  it.each([
    { candidates: [] as Array<Record<string, unknown>> },
    {
      candidates: [repository, { ...repository, id: "44444444-4444-4444-8444-444444444444" }],
    },
  ])(
    "stops unless exactly one fixed repository is available and mapped",
    async ({ candidates }) => {
      mocks.candidates = candidates;

      await expect(runM157InternalAcceptance(actorUserId)).rejects.toThrow(
        "m157_acceptance_fixed_repository_not_unique",
      );
      expect(mocks.executeBaseline).not.toHaveBeenCalled();
      expect(mocks.runDeploymentAcceptance).not.toHaveBeenCalled();
    },
  );

  it("does not start deployment acceptance when the shared baseline executor fails", async () => {
    mocks.executeBaseline.mockRejectedValue(new Error("repository_verification_unavailable"));

    await expect(runM157InternalAcceptance(actorUserId)).rejects.toThrow(
      "m157_acceptance_baseline_unknown_safe",
    );
    expect(mocks.runDeploymentAcceptance).not.toHaveBeenCalled();
  });

  it("does not start deployment acceptance when the baseline result is not verified for the fixed repository", async () => {
    mocks.executeBaseline.mockResolvedValue({ ...baseline, repositoryId: "other-repository" });

    await expect(runM157InternalAcceptance(actorUserId)).rejects.toThrow(
      "m157_acceptance_fresh_baseline_result_invalid",
    );
    expect(mocks.runDeploymentAcceptance).not.toHaveBeenCalled();
  });
});
