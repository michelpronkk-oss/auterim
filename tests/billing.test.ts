import { describe, expect, it } from "vitest";
import {
  PLAN_CATALOG,
  planForDodoProduct,
  resolveWorkspaceEntitlements,
} from "@/lib/billing/plan-catalog";

const workspaceId = "00000000-0000-4000-8000-000000000011";

describe("billing plans and workspace entitlements", () => {
  it("grants the full Pro tier only during the activation-started five-day trial", () => {
    const resolved = resolveWorkspaceEntitlements({
      snapshot: {
        workspaceId,
        activatedAt: "2026-10-01T12:00:00.000Z",
        serverNow: "2026-10-04T12:00:00.000Z",
        subscription: {
          plan: "pro",
          status: "trialing",
          trialStartedAt: "2026-10-01T12:00:00.000Z",
          trialEndsAt: "2026-10-06T12:00:00.000Z",
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          hasDodoCustomer: false,
          updatedAt: "2026-10-01T12:00:00.000Z",
        },
      },
    });
    expect(resolved.trial).toMatchObject({ active: true, daysRemaining: 2 });
    expect(resolved.effectivePlan).toBe("pro");
    expect(resolved.capabilities.automaticPreflight).toBe(true);
    expect(resolved.capabilities.generateFix).toBe(true);
    expect(resolved.capabilities.automaticRemediation).toBe(false);
  });

  it("locks expired unpaid workspaces without pretending they are Core", () => {
    const resolved = resolveWorkspaceEntitlements({
      snapshot: {
        workspaceId,
        activatedAt: "2026-10-01T12:00:00.000Z",
        serverNow: "2026-10-07T12:00:00.000Z",
        subscription: {
          plan: "pro",
          status: "trialing",
          trialStartedAt: "2026-10-01T12:00:00.000Z",
          trialEndsAt: "2026-10-06T12:00:00.000Z",
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          hasDodoCustomer: false,
          updatedAt: "2026-10-01T12:00:00.000Z",
        },
      },
      usage: { protectedDependencies: 4, repositories: 1 },
    });
    expect(resolved).toMatchObject({
      effectivePlan: null,
      locked: true,
      nextRequiredBillingAction: "select_plan",
    });
    expect(resolved.capabilities.monitoring).toBe(false);
    expect(resolved.capabilities.generateFix).toBe(false);
    expect(resolved.usage.protectedDependencies).toBe(4);
  });

  it("applies Core, Pro, and Business capability boundaries centrally", () => {
    const active = (plan: "core" | "pro" | "business") =>
      resolveWorkspaceEntitlements({
        snapshot: {
          workspaceId,
          activatedAt: "2026-10-01T12:00:00.000Z",
          serverNow: "2026-10-03T12:00:00.000Z",
          subscription: {
            plan,
            status: "active",
            trialStartedAt: null,
            trialEndsAt: null,
            currentPeriodStart: "2026-10-01T12:00:00.000Z",
            currentPeriodEnd: "2026-11-01T12:00:00.000Z",
            cancelAtPeriodEnd: false,
            hasDodoCustomer: true,
            updatedAt: "2026-10-02T12:00:00.000Z",
          },
        },
      });
    expect(active("core").capabilities).toMatchObject({
      customerImpact: true,
      automaticPreflight: false,
      generateFix: false,
    });
    expect(active("pro").capabilities).toMatchObject({
      repositoryConnections: true,
      automaticPreflight: true,
      generateFix: true,
      automaticRemediation: false,
    });
    expect(active("business").capabilities.automaticRemediation).toBe(true);
    expect(PLAN_CATALOG.business.limits.protectedDependencies).toBeGreaterThan(
      PLAN_CATALOG.pro.limits.protectedDependencies,
    );
  });

  it("keeps read access in a bounded past-due grace period but pauses execution", () => {
    const resolved = resolveWorkspaceEntitlements({
      snapshot: {
        workspaceId,
        activatedAt: "2026-10-01T12:00:00.000Z",
        serverNow: "2026-10-10T12:00:00.000Z",
        subscription: {
          plan: "pro",
          status: "past_due",
          trialStartedAt: null,
          trialEndsAt: null,
          currentPeriodStart: "2026-10-01T12:00:00.000Z",
          currentPeriodEnd: "2026-10-08T12:00:00.000Z",
          cancelAtPeriodEnd: false,
          hasDodoCustomer: true,
          updatedAt: "2026-10-09T12:00:00.000Z",
        },
      },
    });
    expect(resolved.billing.gracePeriod).toBe(true);
    expect(resolved.capabilities.customerImpact).toBe(true);
    expect(resolved.capabilities.automaticPreflight).toBe(false);
  });

  it("fails closed when an active subscription has no current paid-through date", () => {
    const resolved = resolveWorkspaceEntitlements({
      snapshot: {
        workspaceId,
        activatedAt: "2026-10-01T12:00:00.000Z",
        serverNow: "2026-10-03T12:00:00.000Z",
        subscription: {
          plan: "pro",
          status: "active",
          trialStartedAt: null,
          trialEndsAt: null,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          hasDodoCustomer: true,
          updatedAt: "2026-10-02T12:00:00.000Z",
        },
      },
    });
    expect(resolved).toMatchObject({ effectivePlan: null, locked: true });
    expect(resolved.capabilities.automaticPreflight).toBe(false);
  });

  it("maps only unique configured Dodo product IDs to internal plan slugs", () => {
    const products = { core: "prod_core", pro: "prod_pro", business: "prod_business" };
    expect(planForDodoProduct("prod_pro", products)).toBe("pro");
    expect(planForDodoProduct("prod_unknown", products)).toBeNull();
    expect(
      planForDodoProduct("prod_duplicate", {
        core: "prod_duplicate",
        pro: "prod_duplicate",
        business: "prod_business",
      }),
    ).toBeNull();
  });
});
