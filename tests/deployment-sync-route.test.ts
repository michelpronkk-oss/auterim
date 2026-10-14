import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  role: vi.fn(),
  entitlements: vi.fn(),
  connectorEntitled: vi.fn(),
  loadInstallation: vi.fn(),
  getCredentials: vi.fn(),
  sync: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/onboarding/auth", () => ({
  authenticateOnboardingRequest: mocks.authenticate,
}));
vi.mock("@/lib/billing/server", () => ({
  getWorkspaceRole: mocks.role,
  resolveWorkspaceEntitlementsForMember: mocks.entitlements,
}));
vi.mock("@/lib/connectors/entitlements", () => ({
  connectorProviderEntitled: mocks.connectorEntitled,
}));
vi.mock("@/lib/connectors/service", () => ({
  serverConnectors: () => ({}),
  loadInstallation: mocks.loadInstallation,
  getFreshProviderCredentials: mocks.getCredentials,
}));
vi.mock("@/lib/deployments/service", () => ({
  syncSelectedVercelProject: mocks.sync,
}));

import { POST } from "@/app/api/products/[id]/deployments/sync/route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";
const installationId = "33333333-3333-4333-8333-333333333333";
const resourceId = "44444444-4444-4444-8444-444444444444";

function queryResult(data: unknown) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
  };
  return query;
}

function request() {
  return new Request(`https://auterim.com/api/products/${productId}/deployments/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId, installationId, resourceId }),
  });
}

describe("deployment sync pre-provider diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockImplementation((table: string) =>
      queryResult(
        table === "workspace_products"
          ? { id: productId, status: "protected" }
          : {
              id: resourceId,
              installation_id: installationId,
              external_resource_id: "project-safe-id",
              resource_type: "project",
              selected: true,
              access_state: "available",
            },
      ),
    );
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: { id: "55555555-5555-4555-8555-555555555555" },
      client: { from: mocks.from },
    });
    mocks.role.mockResolvedValue("owner");
    mocks.entitlements.mockResolvedValue({});
    mocks.connectorEntitled.mockReturnValue(true);
    mocks.loadInstallation.mockResolvedValue({ id: installationId });
    mocks.getCredentials.mockResolvedValue({ accessToken: "test-token" });
    mocks.sync.mockResolvedValue({
      observed: 1,
      mappedProducts: 1,
      currentProductionDeploymentId: "deployment-safe-id",
    });
  });

  it.each([
    ["installation_load", "loadInstallation"],
    ["credential_refresh", "getCredentials"],
  ] as const)("logs only the fixed %s stage on %s failure", async (stage, failingCall) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const sensitiveError = new Error("Bearer should-never-be-logged");
    if (failingCall === "loadInstallation")
      mocks.loadInstallation.mockRejectedValue(sensitiveError);
    else mocks.getCredentials.mockRejectedValue(sensitiveError);

    const response = await POST(request(), { params: Promise.resolve({ id: productId }) });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "deployment_sync_failed" });
    expect(log).toHaveBeenCalledExactlyOnceWith("Vercel deployment sync preparation failed.", {
      stage,
      outcome: "error",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("should-never-be-logged");
    expect(mocks.sync).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("does not log provider or persistence failures as pre-sync stages", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.sync.mockRejectedValue(new Error("provider payload must not be logged"));

    const response = await POST(request(), { params: Promise.resolve({ id: productId }) });

    expect(response.status).toBe(503);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("keeps the public Pro entitlement gate ahead of any Vercel provider operation", async () => {
    mocks.connectorEntitled.mockReturnValue(false);

    const response = await POST(request(), { params: Promise.resolve({ id: productId }) });

    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: "connector_not_entitled" });
    expect(mocks.loadInstallation).not.toHaveBeenCalled();
    expect(mocks.getCredentials).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
