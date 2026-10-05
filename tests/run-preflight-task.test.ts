import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  resolveWorkspaceEntitlementsForService: vi.fn(),
  runPreflight: vi.fn(),
}));

vi.mock("@trigger.dev/sdk", () => ({
  AbortTaskRunError: class AbortTaskRunError extends Error {},
  schemaTask: (definition: unknown) => definition,
}));
vi.mock("@/lib/preflight/preflight-service", () => ({ runPreflight: mocks.runPreflight }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));
vi.mock("@/lib/billing/server", () => ({
  resolveWorkspaceEntitlementsForService: mocks.resolveWorkspaceEntitlementsForService,
}));

import { runPreflightTask } from "@/trigger/run-preflight";

function taskRun() {
  return (
    runPreflightTask as unknown as {
      run: (payload: {
        queueId: string;
        workspaceId: string;
        impactAssessmentId: string;
      }) => Promise<unknown>;
    }
  ).run;
}

function clientWithQueue(status: string) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: {
      workspace_id: "11111111-1111-4111-8111-111111111111",
      impact_assessment_id: "22222222-2222-4222-8222-222222222222",
      status,
    },
    error: null,
  });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  const rpc = vi.fn();
  return { client: { from, rpc }, from, select, eq, maybeSingle, rpc };
}

describe("run-preflight Trigger task lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not run a superseded queue item after product archival", async () => {
    const { client } = clientWithQueue("superseded");
    mocks.createSupabaseServerClient.mockReturnValue(client);

    const result = await taskRun()({
      queueId: "33333333-3333-4333-8333-333333333333",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      impactAssessmentId: "22222222-2222-4222-8222-222222222222",
    });

    expect(result).toEqual({ status: "superseded" });
    expect(mocks.runPreflight).not.toHaveBeenCalled();
    expect(mocks.resolveWorkspaceEntitlementsForService).not.toHaveBeenCalled();
  });

  it("does not repeat completed work when Trigger retries a finished queue item", async () => {
    const { client } = clientWithQueue("complete");
    mocks.createSupabaseServerClient.mockReturnValue(client);

    const result = await taskRun()({
      queueId: "33333333-3333-4333-8333-333333333333",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      impactAssessmentId: "22222222-2222-4222-8222-222222222222",
    });

    expect(result).toEqual({ status: "complete" });
    expect(mocks.runPreflight).not.toHaveBeenCalled();
  });
});
