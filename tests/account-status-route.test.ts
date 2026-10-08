import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("@/lib/onboarding/auth", () => ({
  authenticateOnboardingRequest: mocks.authenticate,
}));

import { GET } from "@/app/api/account/status/route";

function membershipQuery(rows: Array<{ workspace_id: string; role: string }>) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    order: vi.fn(async () => ({ data: rows, error: null })),
  };
  return query;
}

function workspaceQuery(rows: Array<{ id: string; name: string }>) {
  const query = {
    select: vi.fn(() => query),
    in: vi.fn(async () => ({ data: rows, error: null })),
  };
  return query;
}

describe("GET /api/account/status workspace list", () => {
  beforeEach(() => mocks.authenticate.mockReset());

  it("returns canonical workspace names only for memberships of the authenticated user", async () => {
    const ownerId = "11111111-1111-4111-8111-111111111111";
    const testWorkspaceId = "e140d48e-9dc0-4552-a9a4-a81fe3872422";
    const koronicWorkspaceA = "20e1fd75-c4b4-4330-887b-16768cee860d";
    const koronicWorkspaceB = "cc4ecb54-901f-4d81-9627-b30d06612525";
    const memberships = membershipQuery([
      { workspace_id: testWorkspaceId, role: "owner" },
      { workspace_id: koronicWorkspaceA, role: "owner" },
      { workspace_id: koronicWorkspaceB, role: "owner" },
    ]);
    const workspaces = workspaceQuery([
      { id: testWorkspaceId, name: "Test" },
      { id: koronicWorkspaceA, name: "Koronic" },
      { id: koronicWorkspaceB, name: "Koronic" },
    ]);
    const client = {
      from: vi.fn((table: string) => (table === "workspace_members" ? memberships : workspaces)),
    };
    mocks.authenticate.mockResolvedValue({ ok: true, user: { id: ownerId }, client });

    const response = await GET(new Request("https://auterim.com/api/account/status"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workspaces: [
        { workspace_id: testWorkspaceId, role: "owner", workspace_name: "Test" },
        { workspace_id: koronicWorkspaceA, role: "owner", workspace_name: "Koronic" },
        { workspace_id: koronicWorkspaceB, role: "owner", workspace_name: "Koronic" },
      ],
    });
    expect(memberships.eq).toHaveBeenCalledWith("user_id", ownerId);
    expect(workspaces.in).toHaveBeenCalledWith("id", [
      testWorkspaceId,
      koronicWorkspaceA,
      koronicWorkspaceB,
    ]);
  });

  it("does not return a partial list when workspace names cannot be authorized/read", async () => {
    const ownerId = "11111111-1111-4111-8111-111111111111";
    const workspaceId = "e140d48e-9dc0-4552-a9a4-a81fe3872422";
    const memberships = membershipQuery([{ workspace_id: workspaceId, role: "owner" }]);
    const query = {
      select: vi.fn(() => query),
      in: vi.fn(async () => ({ data: [], error: null })),
    };
    const client = {
      from: vi.fn((table: string) => (table === "workspace_members" ? memberships : query)),
    };
    mocks.authenticate.mockResolvedValue({ ok: true, user: { id: ownerId }, client });

    const response = await GET(new Request("https://auterim.com/api/account/status"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "account_state_unavailable" });
  });
});
