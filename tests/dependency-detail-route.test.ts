import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  workspaceRole: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/onboarding/auth", () => ({
  authenticateOnboardingRequest: mocks.authenticate,
}));
vi.mock("@/lib/billing/server", () => ({
  getWorkspaceRole: mocks.workspaceRole,
}));

import { GET } from "@/app/api/protection/dependencies/[id]/route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const dependencyId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";

function queryResult(data: unknown) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
    then: (resolve: (result: { data: unknown; error: null }) => unknown) =>
      Promise.resolve(resolve({ data, error: null })),
  };
  return query;
}

describe("protection dependency detail route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const tables: Record<string, unknown> = {
      workspace_members: { role: "owner" },
      workspace_dependencies: {
        id: dependencyId,
        dependency_id: "provider-id",
        origin: "discovered",
        monitoring_enabled: true,
        created_at: "2026-10-01T00:00:00.000Z",
        dependency_catalog: { name: "OpenAI", slug: "openai", category: "ai" },
        dependency_context: null,
      },
      source_catalog: [{ id: sourceId, name: "API docs", source_type: "api_docs", enabled: true }],
      impact_assessments: [],
    };
    mocks.from.mockImplementation((table: string) => queryResult(tables[table]));
    mocks.rpc.mockResolvedValue({
      data: [{ source_id: sourceId, latest_baseline_at: "2026-10-04T01:00:00.000Z" }],
      error: null,
    });
    mocks.workspaceRole.mockResolvedValue("owner");
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: { id: "user-id" },
      client: { from: mocks.from, rpc: mocks.rpc },
    });
  });

  it("returns authorized baseline metadata through the narrow RPC, without snapshot-table reads", async () => {
    const response = await GET(
      new Request(
        `https://auterim.com/api/protection/dependencies/${dependencyId}?workspaceId=${workspaceId}`,
        { headers: { authorization: "Bearer test-token" } },
      ),
      { params: Promise.resolve({ id: dependencyId }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      item: {
        protectionState: "monitoring_evidence_available",
        sourcesWithBaseline: 1,
        sources: [{ latestBaselineAt: "2026-10-04T01:00:00.000Z" }],
      },
    });
    expect(mocks.rpc).toHaveBeenCalledWith("get_dependency_source_baselines", {
      p_workspace_id: workspaceId,
      p_source_ids: [sourceId],
    });
    expect(mocks.from).not.toHaveBeenCalledWith("source_snapshots");
  });
});
