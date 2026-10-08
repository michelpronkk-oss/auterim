import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  role: vi.fn(),
  serviceRpc: vi.fn(),
}));

vi.mock("@/lib/onboarding/auth", () => ({ authenticateOnboardingRequest: mocks.authenticate }));
vi.mock("@/lib/billing/server", () => ({ getWorkspaceRole: mocks.role }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: () => ({ rpc: mocks.serviceRpc }),
}));

import { GET, POST } from "@/app/api/account/members/route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";

function addRequest(body: unknown) {
  return new Request("https://auterim.com/api/account/members", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("workspace member API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: { id: actorId },
      client: {},
    });
    mocks.role.mockResolvedValue("owner");
    mocks.serviceRpc.mockResolvedValue({ data: null, error: null });
  });

  it("allows an owner to add an existing user by exact email with fixed member role", async () => {
    const response = await POST(
      addRequest({ workspaceId, email: "  Existing.User@example.test  " }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.serviceRpc).toHaveBeenCalledWith("add_existing_workspace_member", {
      p_workspace_id: workspaceId,
      p_actor_user_id: actorId,
      p_email: "existing.user@example.test",
    });
    const body = await response.json();
    expect(body.processed).toBe(true);
    expect(JSON.stringify(body)).not.toContain(actorId);
  });

  it("allows admins while denying ordinary members and anonymous callers", async () => {
    mocks.role.mockResolvedValue("admin");
    expect((await POST(addRequest({ workspaceId, email: "member@example.test" }))).status).toBe(
      200,
    );

    mocks.role.mockResolvedValue("member");
    expect((await POST(addRequest({ workspaceId, email: "member@example.test" }))).status).toBe(
      403,
    );
    expect(mocks.serviceRpc).toHaveBeenCalledTimes(1);

    mocks.authenticate.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "authentication_required" }, { status: 401 }),
    });
    expect((await POST(addRequest({ workspaceId, email: "member@example.test" }))).status).toBe(
      401,
    );
    expect(mocks.serviceRpc).toHaveBeenCalledTimes(1);
  });

  it("rejects forged user IDs, role escalation and foreign workspace access", async () => {
    expect(
      (
        await POST(
          addRequest({ workspaceId, email: "member@example.test", role: "owner", userId: actorId }),
        )
      ).status,
    ).toBe(400);
    expect(mocks.serviceRpc).not.toHaveBeenCalled();

    mocks.role.mockResolvedValue(null);
    expect((await POST(addRequest({ workspaceId, email: "member@example.test" }))).status).toBe(
      403,
    );
    expect(mocks.serviceRpc).not.toHaveBeenCalled();
  });

  it("returns the same outcome for unknown and existing/already-member emails", async () => {
    const unknown = await POST(addRequest({ workspaceId, email: "unknown@example.test" }));
    const existing = await POST(addRequest({ workspaceId, email: "existing@example.test" }));
    expect(await unknown.json()).toEqual(await existing.json());
    expect(unknown.status).toBe(existing.status);
  });

  it("returns the workspace-local roster only to owners and admins", async () => {
    mocks.serviceRpc.mockResolvedValue({
      data: [{ email: "owner@example.test", role: "owner", created_at: "2026-10-01T00:00:00Z" }],
      error: null,
    });
    const response = await GET(
      new Request(`https://auterim.com/api/account/members?workspaceId=${workspaceId}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      members: [{ email: "owner@example.test", role: "owner", created_at: "2026-10-01T00:00:00Z" }],
    });

    mocks.role.mockResolvedValue("member");
    expect(
      (await GET(new Request(`https://auterim.com/api/account/members?workspaceId=${workspaceId}`)))
        .status,
    ).toBe(403);
  });
});
