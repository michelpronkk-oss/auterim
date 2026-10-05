export type PlanSlug = "core" | "pro" | "business";
export type CapabilityName =
  | "monitoring"
  | "customerImpact"
  | "repositoryConnections"
  | "automaticPreflight"
  | "generateFix"
  | "automaticRemediation"
  | "automaticDraftPr"
  | "protectionReports"
  | "slackDelivery"
  | "linearActions"
  | "sentryRuntimeContext";

export const PLAN_CATALOG: Record<
  PlanSlug,
  {
    slug: PlanSlug;
    name: string;
    priceUsdMonthly: number;
    tagline: string;
    highlights: string[];
    ctaLabel: string;
    ctaHref: "/signup";
    trialNote?: string;
    limits: {
      protectedDependencies: number;
      repositories: number;
      members: number;
      preflightRuns: number;
      remediationRuns: number;
    };
    capabilities: Record<CapabilityName, boolean>;
  }
> = {
  core: {
    slug: "core",
    name: "Core",
    priceUsdMonthly: 29,
    tagline: "Know what matters.",
    highlights: [
      "1 protected product",
      "External dependency monitoring",
      "Material-change filtering",
      "Customer-specific impact",
      "Deadlines & guidance",
      "Protection reporting",
    ],
    ctaLabel: "Start protecting",
    ctaHref: "/signup",
    limits: {
      protectedDependencies: 20,
      repositories: 0,
      members: 3,
      preflightRuns: 0,
      remediationRuns: 0,
    },
    capabilities: {
      monitoring: true,
      customerImpact: true,
      repositoryConnections: false,
      automaticPreflight: false,
      generateFix: false,
      automaticRemediation: false,
      automaticDraftPr: false,
      protectionReports: true,
      slackDelivery: true,
      linearActions: false,
      sentryRuntimeContext: false,
    },
  },
  pro: {
    slug: "pro",
    name: "Pro",
    priceUsdMonthly: 79,
    tagline: "Verify it. Fix it.",
    highlights: [
      "Everything in Core",
      "Up to 3 protected products",
      "Up to 5 GitHub repositories",
      "GitHub connection",
      "Automatic Preflight",
      "Verified code & config impact",
      "Automatic fix preparation for your review",
      "Grounded remediation guidance",
    ],
    ctaLabel: "Start 5-day Pro trial",
    ctaHref: "/signup",
    trialNote: "Your 5-day Pro trial starts when protection goes live.",
    limits: {
      protectedDependencies: 75,
      repositories: 25,
      members: 10,
      preflightRuns: 500,
      remediationRuns: 30,
    },
    capabilities: {
      monitoring: true,
      customerImpact: true,
      repositoryConnections: true,
      automaticPreflight: true,
      generateFix: true,
      automaticRemediation: false,
      automaticDraftPr: false,
      protectionReports: true,
      slackDelivery: true,
      linearActions: true,
      sentryRuntimeContext: true,
    },
  },
  business: {
    slug: "business",
    name: "Business",
    priceUsdMonthly: 199,
    tagline: "Automate protection at scale.",
    highlights: [
      "Everything in Pro",
      "Up to 10 protected products",
      "Up to 25 GitHub repositories",
      "Policy-driven Draft PR preparation",
      "Automatic workflow handoffs",
      "Approval & policy controls",
      "Multi-repository protection orchestration",
    ],
    ctaLabel: "Start Business protection",
    ctaHref: "/signup",
    limits: {
      protectedDependencies: 250,
      repositories: 100,
      members: 50,
      preflightRuns: 5000,
      remediationRuns: 500,
    },
    capabilities: {
      monitoring: true,
      customerImpact: true,
      repositoryConnections: true,
      automaticPreflight: true,
      generateFix: true,
      automaticRemediation: true,
      automaticDraftPr: true,
      protectionReports: true,
      slackDelivery: true,
      linearActions: true,
      sentryRuntimeContext: true,
    },
  },
};

export type BillingStatus =
  "trialing" | "active" | "past_due" | "on_hold" | "cancelled" | "expired";
export type BillingSnapshot = {
  workspaceId: string;
  serverNow: string;
  activatedAt?: string | null;
  subscription?: {
    plan: PlanSlug | null;
    status: BillingStatus;
    trialStartedAt: string | null;
    trialEndsAt: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    hasDodoCustomer: boolean;
    updatedAt: string;
  } | null;
};

export type WorkspaceEntitlements = {
  workspaceId: string;
  plan: PlanSlug | null;
  subscriptionStatus: BillingStatus | "not_started";
  effectivePlan: PlanSlug | null;
  trial: {
    active: boolean;
    startedAt: string | null;
    endsAt: string | null;
    daysRemaining: number;
  };
  locked: boolean;
  nextRequiredBillingAction: "activate_protection" | "select_plan" | "manage_billing" | null;
  capabilities: Record<CapabilityName, boolean>;
  limits: typeof PLAN_CATALOG.core.limits;
  usage: {
    protectedDependencies: number;
    repositories: number;
    preflightRuns: number;
    remediationRuns: number;
  };
  overLimit: { protectedDependencies: boolean; repositories: boolean };
  billing: { cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null; gracePeriod: boolean };
};

const noCapabilities = (): Record<CapabilityName, boolean> => ({
  monitoring: false,
  customerImpact: false,
  repositoryConnections: false,
  automaticPreflight: false,
  generateFix: false,
  automaticRemediation: false,
  automaticDraftPr: false,
  protectionReports: false,
  slackDelivery: false,
  linearActions: false,
  sentryRuntimeContext: false,
});

export function resolveWorkspaceEntitlements(input: {
  snapshot: BillingSnapshot;
  usage?: Partial<WorkspaceEntitlements["usage"]>;
}): WorkspaceEntitlements {
  const { snapshot } = input;
  const sub = snapshot.subscription ?? null;
  const now = Date.parse(snapshot.serverNow);
  const trialStart = sub?.trialStartedAt ?? null;
  const trialEnd = sub?.trialEndsAt ?? null;
  const trialActive = Boolean(
    sub?.status === "trialing" &&
    trialStart &&
    trialEnd &&
    now >= Date.parse(trialStart) &&
    now < Date.parse(trialEnd),
  );
  const periodEnd = sub?.currentPeriodEnd ? Date.parse(sub.currentPeriodEnd) : null;
  const activePeriod = Boolean(periodEnd && periodEnd > now);
  const graceEnd = periodEnd === null ? null : periodEnd + 7 * 24 * 60 * 60 * 1000;
  const gracePeriod = sub?.status === "past_due" && graceEnd !== null && now < graceEnd;
  const paidStatus =
    (sub?.status === "active" && activePeriod) ||
    (sub?.cancelAtPeriodEnd === true && activePeriod) ||
    gracePeriod;
  const effectivePlan = trialActive ? "pro" : paidStatus ? (sub?.plan ?? null) : null;
  const locked = Boolean(snapshot.activatedAt && effectivePlan === null);
  const base = effectivePlan ? PLAN_CATALOG[effectivePlan] : null;
  const capabilities = base ? { ...base.capabilities } : noCapabilities();
  // In the explicit past-due grace period, retain read access while pausing costly execution.
  if (gracePeriod) {
    capabilities.automaticPreflight = false;
    capabilities.generateFix = false;
    capabilities.automaticRemediation = false;
    capabilities.automaticDraftPr = false;
  }
  const usage = {
    protectedDependencies: Math.max(0, input.usage?.protectedDependencies ?? 0),
    repositories: Math.max(0, input.usage?.repositories ?? 0),
    preflightRuns: Math.max(0, input.usage?.preflightRuns ?? 0),
    remediationRuns: Math.max(0, input.usage?.remediationRuns ?? 0),
  };
  const limits = base?.limits ?? {
    protectedDependencies: 0,
    repositories: 0,
    members: 0,
    preflightRuns: 0,
    remediationRuns: 0,
  };
  return {
    workspaceId: snapshot.workspaceId,
    plan: sub?.plan ?? null,
    subscriptionStatus: sub?.status ?? "not_started",
    effectivePlan,
    trial: {
      active: trialActive,
      startedAt: trialStart,
      endsAt: trialEnd,
      daysRemaining:
        trialActive && trialEnd
          ? Math.max(0, Math.ceil((Date.parse(trialEnd) - now) / 86_400_000))
          : 0,
    },
    locked,
    nextRequiredBillingAction: locked
      ? "select_plan"
      : snapshot.activatedAt
        ? effectivePlan
          ? "manage_billing"
          : "select_plan"
        : "activate_protection",
    capabilities,
    limits,
    usage,
    overLimit: {
      protectedDependencies: usage.protectedDependencies > limits.protectedDependencies,
      repositories: usage.repositories > limits.repositories,
    },
    billing: {
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      gracePeriod,
    },
  };
}

export function capabilityRequiredPlan(capability: CapabilityName): PlanSlug {
  if (capability === "automaticRemediation" || capability === "automaticDraftPr") return "business";
  if (["repositoryConnections", "automaticPreflight", "generateFix"].includes(capability))
    return "pro";
  return "core";
}

export function planProductIds(environment: {
  DODO_PRODUCT_CORE_MONTHLY?: string;
  DODO_PRODUCT_PRO_MONTHLY?: string;
  DODO_PRODUCT_BUSINESS_MONTHLY?: string;
}): Record<PlanSlug, string | undefined> {
  return {
    core: environment.DODO_PRODUCT_CORE_MONTHLY,
    pro: environment.DODO_PRODUCT_PRO_MONTHLY,
    business: environment.DODO_PRODUCT_BUSINESS_MONTHLY,
  };
}

export function planForDodoProduct(
  productId: string,
  productIds: Record<PlanSlug, string | undefined>,
): PlanSlug | null {
  const matches = (Object.keys(productIds) as PlanSlug[]).filter(
    (slug) => productIds[slug] === productId,
  );
  return matches.length === 1 ? matches[0]! : null;
}
