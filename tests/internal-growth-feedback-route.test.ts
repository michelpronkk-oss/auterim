import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  adminEmails: vi.fn(() => new Set(["admin@auterim.com"])),
  readModel: vi.fn(),
  sync: vi.fn(),
  evaluate: vi.fn(),
}));

vi.mock("@/lib/onboarding/auth", () => ({
  authenticateOnboardingRequest: mocks.authenticate,
}));

vi.mock("@/lib/growth-v2/search-console", () => ({
  searchConsoleAdminEmails: mocks.adminEmails,
}));

vi.mock("@/lib/growth-v2/feedback", () => ({
  getGrowthFeedbackReadModel: mocks.readModel,
  syncSearchConsole: mocks.sync,
  evaluateGrowthFeedback: mocks.evaluate,
}));

import { GET, POST } from "@/app/api/internal/growth/feedback/route";

describe("internal Growth feedback route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adminEmails.mockReturnValue(new Set(["admin@auterim.com"]));
    mocks.readModel.mockResolvedValue({ status: "ready" });
    mocks.sync.mockResolvedValue({ status: "complete" });
    mocks.evaluate.mockResolvedValue({ status: "complete" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { email: "admin@auterim.com", email_confirmed_at: null },
    { email: "other@auterim.com", email_confirmed_at: "2026-01-01T00:00:00Z" },
  ])("denies an unverified or non-allowlisted account", async (user) => {
    mocks.authenticate.mockResolvedValue({ ok: true, user });

    const getResponse = await GET(new Request("https://auterim.com/api/internal/growth/feedback"));
    const postResponse = await POST(
      new Request("https://auterim.com/api/internal/growth/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "sync" }),
      }),
    );

    expect(getResponse.status).toBe(403);
    expect(postResponse.status).toBe(403);
    expect(mocks.readModel).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("allows a verified allowlisted admin to read and evaluate feedback", async () => {
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: {
        email: " ADMIN@AUTERIM.COM ",
        email_confirmed_at: "2026-01-01T00:00:00Z",
      },
    });

    const getResponse = await GET(new Request("https://auterim.com/api/internal/growth/feedback"));
    const postResponse = await POST(
      new Request("https://auterim.com/api/internal/growth/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "evaluate" }),
      }),
    );

    expect(getResponse.status).toBe(200);
    expect(postResponse.status).toBe(200);
    expect(mocks.readModel).toHaveBeenCalledOnce();
    expect(mocks.evaluate).toHaveBeenCalledOnce();
  });

  it("denies unauthenticated requests", async () => {
    mocks.authenticate.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "unauthenticated" }, { status: 401 }),
    });

    const response = await GET(new Request("https://auterim.com/api/internal/growth/feedback"));

    expect(response.status).toBe(401);
    expect(mocks.readModel).not.toHaveBeenCalled();
  });
});
