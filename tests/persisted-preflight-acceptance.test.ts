import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runPreflight: vi.fn(),
  createSupabaseServerClient: vi.fn(),
}));

vi.mock("@/lib/preflight/preflight-service", () => ({
  runPreflight: mocks.runPreflight,
  SupabasePreflightRepository: class SupabasePreflightRepository {},
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));

import {
  createPinnedFixtureRepositoryProvider,
  runPersistedPreflightAcceptance,
} from "@/lib/m15/persisted-preflight-acceptance";
import {
  inspectRepositories,
  type PreflightChange,
  type RepositoryTarget,
} from "@/lib/preflight/preflight";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const assessmentId = "22222222-2222-4222-8222-222222222222";
const customerImpactQueueId = "33333333-3333-4333-8333-333333333333";
const preflightQueueId = "44444444-4444-4444-8444-444444444444";
const preflightRunId = "55555555-5555-4555-8555-555555555555";
const fixtureSha = "a".repeat(40);
const fixtureTarget: RepositoryTarget = {
  id: "77777777-7777-4777-8777-777777777777",
  workspaceId,
  owner: "auterim-internal-qa",
  name: "m15-pinned-fixture",
  defaultBranch: "main",
  externalId: 7001,
  installationId: 7002,
};
const fixtureChange: PreflightChange = {
  assessmentId,
  workspaceDependencyId: "88888888-8888-4888-8888-888888888888",
  dependencyName: "OpenAI",
  material: true,
  relevant: true,
  severity: "high",
  summary: "Model X is being removed.",
  impactSummary: "The workspace uses Model X.",
  whyItMatters: "Requests for Model X may stop working.",
  recommendedAction: "Move to a supported model.",
  contextCriticality: "important",
  productionCritical: false,
  affectedEntities: ["Model X"],
  evidence: ["Model X is being removed."],
  contextUsedFor: ["AI processing"],
  effectiveAt: null,
  announcedAt: null,
  deadline: null,
};

function syntheticChange() {
  return {
    sourceChangeId: "66666666-6666-4666-8666-666666666666",
    classification: {
      status: "classified",
      changeId: "66666666-6666-4666-8666-666666666666",
      classification: { material: true, decisionStatus: "classified" },
      replayed: false,
    },
    impactAssessments: [
      {
        queueId: customerImpactQueueId,
        result: { status: "assessed", id: assessmentId, replayed: false },
      },
    ],
  };
}

function result(verifiedImpact: "verified" | "not_found" | "inconclusive") {
  return {
    status: verifiedImpact === "inconclusive" ? "partial" : "completed",
    verifiedImpact,
    confidence: verifiedImpact === "verified" ? 0.94 : 0.3,
    repositoriesScanned: 1,
    findings: [],
    affectedAreas: [],
    complexity: "unknown",
    recommendedRemediation: null,
    effectiveAt: null,
    announcedAt: null,
    deadline: null,
    daysRemaining: null,
  };
}

function setup(verifiedImpact: "verified" | "not_found" | "inconclusive") {
  const persisted = result(verifiedImpact);
  const repository = { loadResult: vi.fn(async () => persisted) };
  const rpc = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
    void _args;
    if (name === "list_preflight_dispatch_queue") {
      return {
        data: [
          {
            queue_id: preflightQueueId,
            workspace_id: workspaceId,
            impact_assessment_id: assessmentId,
          },
        ],
        error: null,
      };
    }
    return { data: 1, error: null };
  });
  mocks.createSupabaseServerClient.mockReturnValue({ rpc });
  mocks.runPreflight.mockResolvedValue({
    status: persisted.status,
    runId: preflightRunId,
    result: persisted,
  });
  return { repository, rpc, persisted };
}

describe("persisted Preflight acceptance helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AUTERIM_M15_LOCAL_INTEGRATION", "1");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("rejects production and unflagged execution before database reads", async () => {
    const { rpc } = setup("verified");
    const input = {
      syntheticChange: syntheticChange() as never,
      customerImpactQueueId,
      provider: {
        getHead: async () => fixtureSha,
        searchCode: async () => [],
        getFile: async () => null,
      },
    };
    vi.stubEnv("NODE_ENV", "production");
    await expect(runPersistedPreflightAcceptance(input)).rejects.toThrow(
      "m15_local_acceptance_production_forbidden",
    );
    expect(rpc).not.toHaveBeenCalled();

    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTERIM_M15_LOCAL_INTEGRATION", "0");
    await expect(runPersistedPreflightAcceptance(input)).rejects.toThrow(
      "m15_local_acceptance_flag_required",
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["verified", "verified"],
    ["not_found", "not_found"],
    ["inconclusive", "inconclusive"],
  ] as const)(
    "fixture provider produces %s at its pinned SHA",
    async (providerOutcome, expected) => {
      const provider = createPinnedFixtureRepositoryProvider({
        outcome: providerOutcome,
        commitSha: fixtureSha,
        affectedEntity: "Model X",
      });
      const result = await inspectRepositories({
        change: fixtureChange,
        repositories: [fixtureTarget],
        provider,
      });
      expect(result.verifiedImpact).toBe(expected);
      if (result.findings[0]) expect(result.findings[0].commitSha).toBe(fixtureSha);
    },
  );

  it.each(["verified", "not_found", "inconclusive"] as const)(
    "uses the real queue and persistence seams for %s fixture results",
    async (verifiedImpact) => {
      const { repository, rpc, persisted } = setup(verifiedImpact);
      const provider = {
        getHead: vi.fn(async () => fixtureSha),
        searchCode: vi.fn(async () => []),
        getFile: vi.fn(async () => null),
      };

      const outcome = await runPersistedPreflightAcceptance({
        syntheticChange: syntheticChange() as never,
        customerImpactQueueId,
        provider,
        repository: repository as never,
      });

      expect(outcome.queueId).toBe(preflightQueueId);
      expect(outcome.impactAssessmentId).toBe(assessmentId);
      expect(outcome.persisted?.verifiedImpact).toBe(verifiedImpact);
      expect(mocks.runPreflight).toHaveBeenCalledWith({
        impactAssessmentId: assessmentId,
        repository,
        provider,
      });
      expect(repository.loadResult).toHaveBeenCalledWith(preflightRunId);
      expect(rpc.mock.calls.map(([name]) => name)).toEqual([
        "list_preflight_dispatch_queue",
        "mark_preflight_dispatch",
        "mark_preflight_dispatch",
      ]);
      expect(rpc.mock.calls[1]?.[1]).toMatchObject({
        p_queue_id: preflightQueueId,
        p_status: "dispatched",
      });
      expect(rpc.mock.calls[2]?.[1]).toMatchObject({
        p_queue_id: preflightQueueId,
        p_status: "complete",
      });
      expect(persisted.verifiedImpact).toBe(verifiedImpact);
    },
  );

  it("rejects assessments that were not returned by the persisted synthetic-change service", async () => {
    const { rpc } = setup("verified");
    await expect(
      runPersistedPreflightAcceptance({
        syntheticChange: {
          ...syntheticChange(),
          impactAssessments: [],
        } as never,
        customerImpactQueueId,
        provider: {
          getHead: async () => fixtureSha,
          searchCode: async () => [],
          getFile: async () => null,
        },
      }),
    ).rejects.toThrow(
      "Preflight acceptance requires a persisted assessment from the synthetic run.",
    );
    expect(rpc).not.toHaveBeenCalled();
  });
});
