import "server-only";
import DodoPayments from "dodopayments";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getEnvironment } from "@/lib/env/schema";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { hasUniqueProductAttribution } from "@/lib/repositories/product-repository-protection";
import {
  planProductIds,
  resolveWorkspaceEntitlements as resolveFromSnapshot,
  type BillingSnapshot,
  type WorkspaceEntitlements,
} from "./plan-catalog";

export function createDodoClient() {
  const environment = getEnvironment();
  if (!environment.DODO_PAYMENTS_API_KEY) throw new Error("dodo_not_configured");
  return new DodoPayments({
    bearerToken: environment.DODO_PAYMENTS_API_KEY,
    webhookKey: environment.DODO_PAYMENTS_WEBHOOK_KEY,
    environment: environment.DODO_PAYMENTS_ENVIRONMENT,
  });
}

export async function getWorkspaceRole(
  client: SupabaseClient,
  workspaceId: string,
  userId: string,
) {
  const { data, error } = await client
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error("workspace_access_check_failed");
  return (data?.role as "owner" | "admin" | "member" | undefined) ?? null;
}

async function usageSnapshot(client: SupabaseClient, workspaceId: string, periodStart: string) {
  const [
    products,
    activeProducts,
    dependencies,
    repositories,
    repositoryMappings,
    preflightRuns,
    remediationRuns,
  ] = await Promise.all([
    client
      .from("workspace_products")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .neq("status", "archived"),
    client
      .from("workspace_products")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("status", "protected"),
    client
      .from("workspace_dependencies")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId),
    client
      .from("repositories")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("selected_for_protection", true),
    client
      .from("workspace_product_repositories")
      .select("repository_id,protected_product_id,status")
      .eq("workspace_id", workspaceId),
    client
      .from("preflight_runs")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .gte("created_at", periodStart),
    client
      .from("remediation_proposals")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .gte("created_at", periodStart),
  ]);
  if (
    [
      products.error,
      activeProducts.error,
      dependencies.error,
      repositories.error,
      repositoryMappings.error,
      preflightRuns.error,
      remediationRuns.error,
    ].some(Boolean)
  ) {
    throw new Error("billing_usage_unavailable");
  }
  const mappingHistoryRepositoryIds = new Set(
    (repositoryMappings.data ?? []).map((mapping) => mapping.repository_id),
  );
  const protectedProductIds = new Set((activeProducts.data ?? []).map((product) => product.id));
  const protectedRepositoryIds = new Set(
    (repositoryMappings.data ?? [])
      .filter(
        (mapping) =>
          mapping.status === "active" && protectedProductIds.has(mapping.protected_product_id),
      )
      .map((mapping) => mapping.repository_id),
  );
  const legacyRepositoryIds = (repositories.data ?? [])
    .map((repository) => repository.id)
    .filter((repositoryId) => !mappingHistoryRepositoryIds.has(repositoryId));
  const { data: legacyAccess, error: legacyAccessError } = legacyRepositoryIds.length
    ? await client
        .from("workspace_repository_access")
        .select("repository_id,workspace_dependency_id")
        .eq("workspace_id", workspaceId)
        .in("repository_id", legacyRepositoryIds)
    : { data: [], error: null };
  if (legacyAccessError) throw new Error("billing_usage_unavailable");
  const legacyDependencyIds = [
    ...new Set((legacyAccess ?? []).map((edge) => edge.workspace_dependency_id)),
  ];
  const { data: legacyDependencies, error: legacyDependenciesError } = legacyDependencyIds.length
    ? await client
        .from("workspace_dependencies")
        .select("id,protected_product_id")
        .eq("workspace_id", workspaceId)
        .in("id", legacyDependencyIds)
    : { data: [], error: null };
  if (legacyDependenciesError) throw new Error("billing_usage_unavailable");
  const productByDependency = new Map(
    (legacyDependencies ?? []).map((dependency) => [
      dependency.id,
      dependency.protected_product_id,
    ]),
  );
  const productIdsByRepository = new Map<string, Set<string>>();
  for (const edge of legacyAccess ?? []) {
    const productId = productByDependency.get(edge.workspace_dependency_id);
    if (!productId) continue;
    const productIds = productIdsByRepository.get(edge.repository_id) ?? new Set();
    productIds.add(productId);
    productIdsByRepository.set(edge.repository_id, productIds);
  }
  for (const repositoryId of legacyRepositoryIds) {
    const productIds = productIdsByRepository.get(repositoryId) ?? new Set();
    const [productId] = productIds;
    if (
      productId &&
      hasUniqueProductAttribution([...productIds], productId) &&
      protectedProductIds.has(productId)
    ) {
      protectedRepositoryIds.add(repositoryId);
    }
  }
  return {
    protectedProducts: products.count ?? 0,
    protectedDependencies: dependencies.count ?? 0,
    repositories: protectedRepositoryIds.size,
    preflightRuns: preflightRuns.count ?? 0,
    remediationRuns: remediationRuns.count ?? 0,
  };
}

export async function resolveWorkspaceEntitlementsForMember(
  client: SupabaseClient,
  workspaceId: string,
): Promise<WorkspaceEntitlements> {
  const { data, error } = await client.rpc("get_workspace_billing_snapshot", {
    p_workspace_id: workspaceId,
  });
  if (error) throw new Error("billing_state_unavailable");
  const snapshot = data as BillingSnapshot;
  const periodStart =
    snapshot.subscription?.currentPeriodStart ??
    snapshot.subscription?.trialStartedAt ??
    new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const usage = await usageSnapshot(client, workspaceId, periodStart);
  return resolveFromSnapshot({ snapshot, usage });
}

export async function resolveWorkspaceEntitlementsForService(workspaceId: string) {
  const client = createSupabaseServerClient();
  const { data, error } = await client.rpc("get_workspace_billing_snapshot_service", {
    p_workspace_id: workspaceId,
  });
  if (error) throw new Error("billing_state_unavailable");
  const snapshot = data as BillingSnapshot;
  const periodStart =
    snapshot.subscription?.currentPeriodStart ??
    snapshot.subscription?.trialStartedAt ??
    new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const usage = await usageSnapshot(client, workspaceId, periodStart);
  return resolveFromSnapshot({ snapshot, usage });
}

export function configuredDodoProducts() {
  return planProductIds(getEnvironment());
}

export function normalizeDodoStatus(eventType: string, status: unknown) {
  if (eventType === "subscription.cancelled") return "cancelled" as const;
  if (eventType === "subscription.expired") return "expired" as const;
  if (eventType === "subscription.failed") return "past_due" as const;
  if (eventType === "subscription.on_hold") return "on_hold" as const;
  if (status === "active") return "active" as const;
  if (status === "failed" || status === "past_due") return "past_due" as const;
  if (status === "on_hold") return "on_hold" as const;
  if (status === "cancelled") return "cancelled" as const;
  if (status === "expired") return "expired" as const;
  return null;
}

export type { WorkspaceEntitlements };
