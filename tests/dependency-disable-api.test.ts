import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  workspaceRole: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/onboarding/auth", () => ({
  authenticateOnboardingRequest: mocks.authenticate,
  parseJsonBody: async (request: Request) => request.json(),
}));
vi.mock("@/lib/billing/server", () => ({ getWorkspaceRole: mocks.workspaceRole }));

import { PATCH } from "@/app/api/protection/dependencies/[id]/route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const dependencyId = "22222222-2222-4222-8222-222222222222";

describe("dependency disable API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspaceRole.mockResolvedValue("owner");
    mocks.rpc.mockResolvedValue({
      data: {
        workspaceId,
        workspaceDependencyId: dependencyId,
        monitoringEnabled: false,
        changed: true,
      },
      error: null,
    });
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: { id: "owner-id" },
      client: { rpc: mocks.rpc },
    });
  });

  it("uses the owner/admin lifecycle RPC for a workspace-scoped dependency", async () => {
    const response = await PATCH(
      new Request(`https://auterim.com/api/protection/dependencies/${dependencyId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, action: "disable" }),
      }),
      { params: Promise.resolve({ id: dependencyId }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      workspaceDependencyId: dependencyId,
      monitoringEnabled: false,
      changed: true,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("disable_workspace_dependency", {
      p_workspace_id: workspaceId,
      p_workspace_dependency_id: dependencyId,
    });
  });

  it("requires owner or admin before invoking the lifecycle operation", async () => {
    mocks.workspaceRole.mockResolvedValue("member");
    const response = await PATCH(
      new Request(`https://auterim.com/api/protection/dependencies/${dependencyId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, action: "disable" }),
      }),
      { params: Promise.resolve({ id: dependencyId }) },
    );

    expect(response.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("maps cross-workspace or missing dependency RPC denial without exposing database details", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "P0002", message: "private detail" },
    });
    const response = await PATCH(
      new Request(`https://auterim.com/api/protection/dependencies/${dependencyId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, action: "disable" }),
      }),
      { params: Promise.resolve({ id: dependencyId }) },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "dependency_not_found" });
  });
});
