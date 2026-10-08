import { beforeEach, describe, expect, it, vi } from "vitest";

const { evaluateGrowthCandidateMock } = vi.hoisted(() => ({
  evaluateGrowthCandidateMock: vi.fn(),
}));

vi.mock("@/lib/growth/evaluator", () => ({
  evaluateGrowthCandidate: evaluateGrowthCandidateMock,
}));

import { dispatchGrowthOpportunityEvaluation } from "@/lib/growth/dispatch";

const claimedItem = {
  queue_id: "queue-id",
  classification_id: "classification-id",
  source_change_id: "source-change-id",
  lease_token: "lease-token",
  attempts: 1,
};

function mockedClient(responses: Array<{ data: unknown; error: unknown }>) {
  return {
    rpc: vi.fn(async () => responses.shift() ?? { data: null, error: null }),
  };
}

describe("Growth Engine dispatcher observability", () => {
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  it("distinguishes a claim RPC error and logs only a safe error code", async () => {
    const client = mockedClient([
      { data: null, error: { code: "42702", message: "private provider payload" } },
    ]);

    await expect(dispatchGrowthOpportunityEvaluation({ client: client as never })).rejects.toThrow(
      "growth_queue_claim_failed",
    );
    expect(info).toHaveBeenCalledWith(
      JSON.stringify({
        scope: "growth_opportunity_dispatch",
        event: "claim_error",
        error_code: "42702",
        limit: 10,
      }),
    );
    expect(info.mock.calls.flat().join(" ")).not.toContain("private provider payload");
  });

  it("distinguishes an empty queue from a claim error", async () => {
    const client = mockedClient([{ data: [], error: null }]);

    await expect(
      dispatchGrowthOpportunityEvaluation({ client: client as never }),
    ).resolves.toMatchObject({ claimed: 0, completed: 0 });
    expect(info).toHaveBeenCalledWith(
      JSON.stringify({
        scope: "growth_opportunity_dispatch",
        event: "claim_empty",
        limit: 10,
      }),
    );
  });

  it("records safe claim-success and completion counts", async () => {
    const client = mockedClient([
      { data: [claimedItem], error: null },
      { data: true, error: null },
    ]);
    evaluateGrowthCandidateMock.mockResolvedValue({ packet: { schemaVersion: 1 } });

    await expect(
      dispatchGrowthOpportunityEvaluation({ client: client as never }),
    ).resolves.toMatchObject({ claimed: 1, completed: 1, retryExhausted: 0 });
    expect(info).toHaveBeenCalledWith(
      JSON.stringify({
        scope: "growth_opportunity_dispatch",
        event: "claim_success",
        count: 1,
        limit: 10,
      }),
    );
  });

  it.each([
    { attempts: 2, event: "processing_failure", outcome: "retry_scheduled" },
    { attempts: 5, event: "retry_exhausted", outcome: undefined },
  ])(
    "records bounded processing failure state at attempt $attempts",
    async ({ attempts, event, outcome }) => {
      const client = mockedClient([
        { data: [{ ...claimedItem, attempts }], error: null },
        { data: true, error: null },
      ]);
      evaluateGrowthCandidateMock.mockRejectedValue(new Error("sensitive failure detail"));

      const result = await dispatchGrowthOpportunityEvaluation({ client: client as never });
      expect(result.retryExhausted).toBe(attempts >= 5 ? 1 : 0);
      expect(result.retried).toBe(attempts >= 5 ? 0 : 1);
      expect(info).toHaveBeenCalledWith(
        JSON.stringify({
          scope: "growth_opportunity_dispatch",
          event,
          ...(outcome ? { outcome, attempts } : { attempts }),
        }),
      );
      expect(info.mock.calls.flat().join(" ")).not.toContain("sensitive failure detail");
    },
  );
});
