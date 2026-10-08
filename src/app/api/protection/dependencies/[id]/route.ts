import { z } from "zod";
import { authenticateOnboardingRequest, parseJsonBody } from "@/lib/onboarding/auth";
import { getWorkspaceRole } from "@/lib/billing/server";

const disableSchema = z
  .object({ workspaceId: z.string().uuid(), action: z.literal("disable") })
  .strict();

export async function PATCH(request: Request, routeContext: { params: Promise<{ id: string }> }) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const { id } = await routeContext.params;
  const dependencyId = z.string().uuid().safeParse(id);
  if (!dependencyId.success) return Response.json({ error: "invalid_dependency" }, { status: 400 });

  let input: z.infer<typeof disableSchema>;
  try {
    input = disableSchema.parse(await parseJsonBody(request));
  } catch {
    return Response.json({ error: "invalid_dependency_operation" }, { status: 400 });
  }
  const role = await getWorkspaceRole(auth.client, input.workspaceId, auth.user.id).catch(
    () => null,
  );
  if (role !== "owner" && role !== "admin")
    return Response.json({ error: "owner_or_admin_required" }, { status: 403 });

  const { data, error } = await auth.client.rpc("disable_workspace_dependency", {
    p_workspace_id: input.workspaceId,
    p_workspace_dependency_id: dependencyId.data,
  });
  if (error) {
    if (error.code === "P0002")
      return Response.json({ error: "dependency_not_found" }, { status: 404 });
    if (error.code === "42501") return Response.json({ error: "forbidden" }, { status: 403 });
    return Response.json({ error: "dependency_update_failed" }, { status: 503 });
  }
  return Response.json(data);
}

export async function GET(request: Request, routeContext: { params: Promise<{ id: string }> }) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const workspaceId = z
    .string()
    .uuid()
    .safeParse(new URL(request.url).searchParams.get("workspaceId"));
  const { id } = await routeContext.params;
  if (!workspaceId.success || !z.string().uuid().safeParse(id).success)
    return Response.json({ error: "invalid_dependency" }, { status: 400 });
  if (!(await getWorkspaceRole(auth.client, workspaceId.data, auth.user.id)))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { data: dependency, error } = await auth.client
    .from("workspace_dependencies")
    .select(
      "id,protected_product_id,dependency_id,origin,monitoring_enabled,created_at,dependency_catalog(name,slug,category,description),dependency_context(criticality,production_critical,used_for,context_note)",
    )
    .eq("id", id)
    .eq("workspace_id", workspaceId.data)
    .maybeSingle();
  if (error) return Response.json({ error: "dependency_unavailable" }, { status: 503 });
  if (!dependency) return Response.json({ error: "not_found" }, { status: 404 });
  const [productResult, sources, impacts] = await Promise.all([
    auth.client
      .from("workspace_products")
      .select("id,name,status")
      .eq("workspace_id", workspaceId.data)
      .eq("id", dependency.protected_product_id)
      .maybeSingle(),
    auth.client
      .from("source_catalog")
      .select("id,name,source_type,url,enabled")
      .eq("dependency_id", dependency.dependency_id)
      .eq("enabled", true)
      .order("source_type")
      .limit(100),
    auth.client
      .from("impact_assessments")
      .select(
        "id,relevant,severity,impact_summary,why_it_matters,recommended_action,assessed_at,status",
      )
      .eq("workspace_id", workspaceId.data)
      .eq("workspace_dependency_id", dependency.id)
      .eq("status", "assessed")
      .order("assessed_at", { ascending: false })
      .limit(20),
  ]);
  if (productResult.error || sources.error || impacts.error)
    return Response.json({ error: "dependency_unavailable" }, { status: 503 });
  if (!productResult.data) return Response.json({ error: "not_found" }, { status: 404 });
  const coveredSources = sources.data ?? [];
  const sourceIds = coveredSources.map((source) => source.id);
  const { data: snapshots, error: snapshotError } = sourceIds.length
    ? await auth.client.rpc("get_dependency_source_baselines", {
        p_workspace_id: workspaceId.data,
        p_source_ids: sourceIds,
      })
    : { data: [], error: null };
  if (snapshotError) return Response.json({ error: "dependency_unavailable" }, { status: 503 });
  const snapshotsBySource = new Map<string, string>();
  for (const snapshot of snapshots ?? []) {
    if (snapshot.latest_baseline_at)
      snapshotsBySource.set(snapshot.source_id, snapshot.latest_baseline_at);
  }
  const latestImpact = impacts.data?.[0] ?? null;
  const contextValue: unknown = dependency.dependency_context;
  const dependencyContext = (
    Array.isArray(contextValue) ? contextValue[0] : contextValue
  ) as Record<string, unknown> | null;
  return Response.json(
    {
      item: {
        id: dependency.id,
        product: {
          id: productResult.data.id,
          name: productResult.data.name,
          status: productResult.data.status,
        },
        dependencyId: dependency.dependency_id,
        provider: Array.isArray(dependency.dependency_catalog)
          ? dependency.dependency_catalog[0]
          : dependency.dependency_catalog,
        origin: dependency.origin,
        protected: dependency.monitoring_enabled,
        criticality: dependencyContext?.criticality,
        productionCritical: dependencyContext?.production_critical,
        usedFor: dependencyContext?.used_for,
        contextNote: dependencyContext?.context_note,
        createdAt: dependency.created_at,
        protectionState: !dependency.monitoring_enabled
          ? "disabled"
          : latestImpact?.relevant
            ? "attention_required"
            : snapshotsBySource.size
              ? "monitoring_evidence_available"
              : coveredSources.length
                ? "baseline_pending"
                : "coverage_pending",
        latestImpact,
        sources: coveredSources.map((source) => ({
          ...source,
          latestBaselineAt: snapshotsBySource.get(source.id) ?? null,
        })),
        sourceCount: coveredSources.length,
        sourcesWithBaseline: snapshotsBySource.size,
        recentAssessments: impacts.data ?? [],
      },
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
