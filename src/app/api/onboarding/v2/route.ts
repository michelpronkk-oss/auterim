import { z } from "zod";
import { getWorkspaceRole, resolveWorkspaceEntitlementsForMember } from "@/lib/billing/server";
import {
  authenticateOnboardingRequest,
  onboardingError,
  parseJsonBody,
} from "@/lib/onboarding/auth";
import {
  deriveOnboardingRecommendations,
  deriveProductBaselineStatus,
  ONBOARDING_V2_STAGES,
} from "@/lib/onboarding/v2";
import { getProductProtectionGraph } from "@/lib/protection/product-graph";
import { dispatchOnboardingBaselines } from "@/lib/onboarding/dispatch-baselines";
import { recordGrowthFirstPartyEvent } from "@/lib/growth-v2/feedback";

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0" };
const productScope = z
  .object({ workspaceId: z.string().uuid(), productId: z.string().uuid() })
  .strict();
const mutation = z.discriminatedUnion("operation", [
  productScope.extend({ operation: z.literal("start") }),
  productScope.extend({
    operation: z.literal("transition"),
    targetStage: z.enum(ONBOARDING_V2_STAGES),
  }),
  productScope.extend({ operation: z.literal("activate") }),
]);

function errorResponse(error: { code?: string; message?: string }) {
  const message = error.message ?? "";
  if (error.code === "42501")
    return Response.json({ error: "forbidden" }, { status: 403, headers: privateHeaders });
  if (error.code === "P0002")
    return Response.json({ error: "not_found" }, { status: 404, headers: privateHeaders });
  if (/discovery_still_running/.test(message))
    return Response.json(
      { error: "discovery_still_running" },
      { status: 409, headers: privateHeaders },
    );
  if (/review_pending_candidates/.test(message))
    return Response.json(
      { error: "review_pending_candidates" },
      { status: 409, headers: privateHeaders },
    );
  if (/confirmed_dependency_required/.test(message))
    return Response.json(
      { error: "confirmed_dependency_required" },
      { status: 409, headers: privateHeaders },
    );
  if (error.code === "22023" || error.code === "23514")
    return Response.json(
      { error: "invalid_onboarding_transition" },
      { status: 409, headers: privateHeaders },
    );
  return onboardingError(error);
}

export async function GET(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const parsed = productScope.safeParse({
    workspaceId: new URL(request.url).searchParams.get("workspaceId"),
    productId: new URL(request.url).searchParams.get("productId"),
  });
  if (!parsed.success)
    return Response.json(
      { error: "invalid_product_scope" },
      { status: 400, headers: privateHeaders },
    );
  const { workspaceId, productId } = parsed.data;
  const role = await getWorkspaceRole(auth.client, workspaceId, auth.user.id).catch(() => null);
  if (!role) return Response.json({ error: "forbidden" }, { status: 403, headers: privateHeaders });

  try {
    const [productResult, progressResult, onboardingResult, dependenciesResult, entitlements] =
      await Promise.all([
        auth.client
          .from("workspace_products")
          .select("id,workspace_id,name,slug,status,is_default,protected_at,created_at")
          .eq("id", productId)
          .eq("workspace_id", workspaceId)
          .maybeSingle(),
        auth.client
          .from("product_onboarding_progress")
          .select("stage,completed_stages,milestone_times,updated_at")
          .eq("workspace_id", workspaceId)
          .eq("product_id", productId)
          .maybeSingle(),
        auth.client.rpc("get_onboarding_status", { p_workspace_id: workspaceId }),
        auth.client.rpc("get_product_dependencies", {
          p_workspace_id: workspaceId,
          p_product_id: productId,
        }),
        resolveWorkspaceEntitlementsForMember(auth.client, workspaceId),
      ]);
    if (
      productResult.error ||
      progressResult.error ||
      onboardingResult.error ||
      dependenciesResult.error
    ) {
      return Response.json(
        { error: "onboarding_v2_unavailable" },
        { status: 503, headers: privateHeaders },
      );
    }
    if (!productResult.data)
      return Response.json({ error: "not_found" }, { status: 404, headers: privateHeaders });

    const product = productResult.data;
    const onboarding = onboardingResult.data as Record<string, unknown>;
    const company = onboarding.company as Record<string, unknown>;
    const discovery = onboarding.discovery as Record<string, unknown>;
    const candidates = Array.isArray(discovery.candidates) ? discovery.candidates : [];
    const workspaceDependencies = (
      Array.isArray(dependenciesResult.data) ? dependenciesResult.data : []
    ).map((item) => {
      const dependency = item as Record<string, unknown>;
      const context =
        dependency.context && typeof dependency.context === "object"
          ? (dependency.context as Record<string, unknown>)
          : {};
      return {
        workspaceDependencyId: dependency.id,
        dependencyId: dependency.dependencyId,
        dependencySlug: dependency.providerSlug,
        providerName: dependency.providerName,
        category: dependency.category,
        origin: dependency.origin,
        monitoringEnabled: dependency.monitoringEnabled,
        usedFor: Array.isArray(context.usedFor) ? context.usedFor : [],
        criticality: context.criticality ?? "normal",
        productionCritical: context.productionCritical ?? false,
        contextNote: context.contextNote ?? "",
      };
    });
    const [graph, repositories] = await Promise.all([
      getProductProtectionGraph(auth.client, {
        workspaceId,
        productId,
        verificationCapabilityAvailable: entitlements.capabilities.automaticPreflight,
      }),
      auth.client
        .from("workspace_product_repositories")
        .select("repository_id,status")
        .eq("workspace_id", workspaceId)
        .eq("protected_product_id", productId)
        .limit(200),
    ]);
    if (repositories.error)
      return Response.json(
        { error: "onboarding_v2_unavailable" },
        { status: 503, headers: privateHeaders },
      );

    const progress = progressResult.data;
    const unresolved = candidates.some(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        "suggestedStatus" in candidate &&
        candidate.suggestedStatus === "candidate",
    );
    const graphSources = graph?.coverage.authoritativeSourcesAvailable ?? 0;
    const observedBaselines = graph?.coverage.sourcesWithObservedGlobalBaseline ?? 0;
    const baselineStatus = deriveProductBaselineStatus({
      protectedProduct: product.status === "protected",
      sources: graphSources,
      observedBaselines,
    });
    try {
      await recordGrowthFirstPartyEvent({
        eventType: "product_selected",
        stableKey: productId,
      });
      await recordGrowthFirstPartyEvent({
        eventType: "protection_graph_viewed",
        stableKey: productId,
      });
      if (workspaceDependencies.length > 0 && graphSources > 0)
        await recordGrowthFirstPartyEvent({
          eventType: "first_grounded_value",
          stableKey: productId,
        });
    } catch {
      // Funnel reporting is best-effort and must never block onboarding reads.
    }
    return Response.json(
      {
        workspaceId,
        company: { id: company.id, name: company.name, websiteUrl: company.websiteUrl ?? null },
        product,
        progress: progress ?? {
          stage: product.status === "protected" ? "complete" : "scan_import",
          completed_stages: [],
          milestone_times: {},
          updated_at: null,
        },
        discovery: { status: discovery.status ?? null, candidates },
        dependencies: workspaceDependencies,
        notificationPreferences: onboarding.notificationPreferences ?? null,
        protectionGraph: graph,
        repositories: (repositories.data ?? []).map((item) => ({
          id: item.repository_id,
          status: item.status,
        })),
        activation:
          product.status === "protected"
            ? {
                activatedAt: product.protected_at,
                baselineStatus,
              }
            : null,
        recommendations: deriveOnboardingRecommendations({
          dependencyCount: workspaceDependencies.length,
          mappedRepositories:
            graph?.repositories?.filter((repository) => repository.mappingState === "active")
              .length ?? 0,
          verificationAvailable: entitlements.capabilities.automaticPreflight,
          baselineStatus,
          hasUnresolvedCandidates: unresolved,
        }),
        cliInsertionPoint: { available: false, command: "npx auterim connect", stage: "discovery" },
      },
      { headers: privateHeaders },
    );
  } catch {
    return Response.json(
      { error: "onboarding_v2_unavailable" },
      { status: 503, headers: privateHeaders },
    );
  }
}

export async function POST(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  let input: z.infer<typeof mutation>;
  try {
    input = mutation.parse(await parseJsonBody(request));
  } catch {
    return Response.json(
      { error: "invalid_onboarding_operation" },
      { status: 400, headers: privateHeaders },
    );
  }

  if (input.operation === "activate") {
    const progress = await auth.client
      .from("product_onboarding_progress")
      .select("stage")
      .eq("workspace_id", input.workspaceId)
      .eq("product_id", input.productId)
      .maybeSingle();
    if (progress.error)
      return Response.json(
        { error: "activation_unavailable" },
        { status: 503, headers: privateHeaders },
      );
    if (progress.data?.stage !== "activation" && progress.data?.stage !== "complete")
      return Response.json(
        { error: "onboarding_activation_stage_required" },
        { status: 409, headers: privateHeaders },
      );
    const product = await auth.client
      .from("workspace_products")
      .select("is_default,status")
      .eq("workspace_id", input.workspaceId)
      .eq("id", input.productId)
      .maybeSingle();
    if (product.error)
      return Response.json(
        { error: "activation_unavailable" },
        { status: 503, headers: privateHeaders },
      );
    if (!product.data)
      return Response.json({ error: "not_found" }, { status: 404, headers: privateHeaders });
    if (product.data.is_default) {
      const response = await fetch(new URL("/api/onboarding/activate", request.url), {
        method: "POST",
        headers: {
          authorization: request.headers.get("authorization") ?? "",
          "content-type": "application/json",
        },
        body: JSON.stringify({ workspaceId: input.workspaceId }),
      });
      if (!response.ok)
        return new Response(response.body, {
          status: response.status,
          headers: { ...Object.fromEntries(response.headers), ...privateHeaders },
        });
      const payload = await response.json();
      const completed = await auth.client.rpc("transition_product_onboarding_v2", {
        p_workspace_id: input.workspaceId,
        p_product_id: input.productId,
        p_target_stage: "complete",
      });
      if (completed.error) return errorResponse(completed.error);
      return Response.json(payload, { status: response.status, headers: privateHeaders });
    }
    const role = await getWorkspaceRole(auth.client, input.workspaceId, auth.user.id).catch(
      () => null,
    );
    if (role !== "owner" && role !== "admin")
      return Response.json(
        { error: "owner_or_admin_required" },
        { status: 403, headers: privateHeaders },
      );
    const result = await auth.client.rpc("activate_product_protection_v2", {
      p_workspace_id: input.workspaceId,
      p_product_id: input.productId,
    });
    if (result.error) return errorResponse(result.error);
    try {
      await dispatchOnboardingBaselines(auth.user.id, input.workspaceId);
    } catch {
      // Protection activation is durable; the global baseline dispatcher recovers queued work.
      console.warn("Onboarding baseline dispatch could not start.", {
        workspaceId: input.workspaceId,
        stage: "claim",
        outcome: "error",
        errorCategory: "claim_rpc_error",
      });
    }
    const completed = await auth.client.rpc("transition_product_onboarding_v2", {
      p_workspace_id: input.workspaceId,
      p_product_id: input.productId,
      p_target_stage: "complete",
    });
    if (completed.error) return errorResponse(completed.error);
    try {
      await recordGrowthFirstPartyEvent({
        eventType: "protection_activation",
        stableKey: `${input.workspaceId}:${input.productId}`,
      });
    } catch {
      // Activation is durable; first-party reporting is best-effort.
    }
    return Response.json(result.data, { headers: privateHeaders });
  }

  const rpc =
    input.operation === "start"
      ? await auth.client.rpc("start_product_onboarding_v2", {
          p_workspace_id: input.workspaceId,
          p_product_id: input.productId,
        })
      : await auth.client.rpc("transition_product_onboarding_v2", {
          p_workspace_id: input.workspaceId,
          p_product_id: input.productId,
          p_target_stage: input.targetStage,
        });
  if (rpc.error) return errorResponse(rpc.error);
  return Response.json(rpc.data, { headers: privateHeaders });
}
