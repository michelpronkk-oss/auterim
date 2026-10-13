import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "dodopayments";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  createDodoClient: vi.fn(),
  workspaceRole: vi.fn(),
  entitlements: vi.fn(),
  getEnvironment: vi.fn(),
  productIds: vi.fn(),
  dodo: {
    customersCreate: vi.fn(),
    checkoutCreate: vi.fn(),
    planChange: vi.fn(),
  },
  from: vi.fn(),
  rpc: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock("@/lib/onboarding/auth", () => ({
  authenticateOnboardingRequest: mocks.authenticate,
}));
vi.mock("@/lib/billing/server", () => ({
  createDodoClient: mocks.createDodoClient,
  getWorkspaceRole: mocks.workspaceRole,
  resolveWorkspaceEntitlementsForMember: mocks.entitlements,
}));
vi.mock("@/lib/env/schema", () => ({ getEnvironment: mocks.getEnvironment }));
vi.mock("@/lib/billing/plan-catalog", () => ({ planProductIds: mocks.productIds }));

import { POST } from "@/app/api/billing/checkout/route";

const workspaceId = "e140d48e-9dc0-4552-a9a4-a81fe3872422";
const fixtureEmail = "owner@example.invalid";
const privateFixture = "private-provider-body-token-fixture";

function request(body: unknown = { workspaceId, plan: "pro" }) {
  return new Request("https://auterim.com/api/billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "checkout-test-123" },
    body: JSON.stringify(body),
  });
}

function subscriptionQuery() {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: mocks.maybeSingle,
  };
  return query;
}

function configuredEnvironment() {
  return {
    DODO_PAYMENTS_API_KEY: "never-return-this-key-fixture",
    DODO_PAYMENTS_ENVIRONMENT: "test_mode",
    NEXT_PUBLIC_APP_URL: "https://auterim.com",
  };
}

describe("POST /api/billing/checkout safe failure diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: { id: "owner-user", email: fixtureEmail },
      client: { from: mocks.from, rpc: mocks.rpc },
    });
    mocks.from.mockReturnValue(subscriptionQuery());
    mocks.rpc.mockResolvedValue({ error: null });
    mocks.workspaceRole.mockResolvedValue("owner");
    mocks.entitlements.mockResolvedValue({ nextRequiredBillingAction: null });
    mocks.getEnvironment.mockReturnValue(configuredEnvironment());
    mocks.productIds.mockReturnValue({
      core: "core-fixture",
      pro: "pro-fixture",
      business: "business-fixture",
    });
    mocks.maybeSingle.mockResolvedValue({
      data: {
        dodo_customer_id: null,
        dodo_subscription_id: null,
        plan: null,
        status: "expired",
      },
      error: null,
    });
    mocks.dodo.customersCreate.mockResolvedValue({ customer_id: "customer-id-fixture" });
    mocks.dodo.checkoutCreate.mockResolvedValue({
      checkout_url: "https://checkout.dodopayments.com/session/opaque-fixture",
      session_id: "session-id-fixture",
    });
    mocks.dodo.planChange.mockResolvedValue({});
    mocks.createDodoClient.mockReturnValue({
      customers: { create: mocks.dodo.customersCreate },
      checkoutSessions: { create: mocks.dodo.checkoutCreate },
      subscriptions: { changePlan: mocks.dodo.planChange },
    });
  });

  it("preserves successful checkout behavior", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      checkoutUrl: "https://checkout.dodopayments.com/session/opaque-fixture",
      sessionId: "session-id-fixture",
    });
    expect(mocks.dodo.customersCreate).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith("attach_workspace_dodo_customer", {
      p_workspace_id: workspaceId,
      p_customer_id: "customer-id-fixture",
    });
    expect(mocks.dodo.checkoutCreate).toHaveBeenCalledOnce();
  });

  it("returns only a fixed stage and category for a provider exception", async () => {
    mocks.dodo.checkoutCreate.mockRejectedValue(
      new AuthenticationError(401, { detail: privateFixture }, privateFixture, new Headers()),
    );

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: "billing_checkout_failed",
      stage: "checkout_session_create",
      category: "auth_failed",
    });
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      privateFixture,
      fixtureEmail,
      "customer-id-fixture",
      "session-id-fixture",
      "never-return-this-key-fixture",
    ])
      expect(serialized).not.toContain(forbidden);
  });

  it("normalizes unknown exception details without exposing provider payloads", async () => {
    mocks.dodo.customersCreate.mockRejectedValue(
      new Error(`${privateFixture} ${fixtureEmail} customer-id-fixture`),
    );

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: "billing_checkout_failed",
      stage: "customer_create",
      category: "unknown_safe",
    });
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      privateFixture,
      fixtureEmail,
      "customer-id-fixture",
      "never-return-this-key-fixture",
    ])
      expect(serialized).not.toContain(forbidden);
  });

  it("keeps workspace owner/admin authorization unchanged", async () => {
    mocks.workspaceRole.mockResolvedValue("member");

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(mocks.entitlements).not.toHaveBeenCalled();
    expect(mocks.createDodoClient).not.toHaveBeenCalled();
  });

  it("keeps malformed requests unchanged", async () => {
    const response = await POST(request({ workspaceId, plan: "unknown" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_billing_request" });
  });

  it("keeps explicit billing configuration responses unchanged", async () => {
    mocks.getEnvironment.mockReturnValue({ DODO_PAYMENTS_ENVIRONMENT: "test_mode" });

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "billing_not_configured" });
  });

  it("keeps the explicit activation gate response unchanged", async () => {
    mocks.entitlements.mockResolvedValue({ nextRequiredBillingAction: "activate_protection" });

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "protection_activation_required" });
  });
});
