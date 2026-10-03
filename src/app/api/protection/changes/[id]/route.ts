import { z } from "zod";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { getWorkspaceRole } from "@/lib/billing/server";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const workspaceId = z
    .string()
    .uuid()
    .safeParse(new URL(request.url).searchParams.get("workspaceId"));
  const { id } = await context.params;
  if (!workspaceId.success || !z.string().uuid().safeParse(id).success)
    return Response.json({ error: "invalid_change" }, { status: 400 });
  if (!(await getWorkspaceRole(auth.client, workspaceId.data, auth.user.id)))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { data: impact, error } = await auth.client
    .from("impact_assessments")
    .select(
      "id,workspace_dependency_id,source_change_classification_id,relevant,severity,impact_summary,why_it_matters,recommended_action,action_required,confidence,assessed_at,status,workspace_dependencies!inner(workspace_id,dependency_id,monitoring_enabled,dependency_catalog(name,slug,category),dependency_context(criticality,production_critical,used_for))",
    )
    .eq("id", id)
    .eq("workspace_id", workspaceId.data)
    .eq("status", "assessed")
    .maybeSingle();
  if (error) return Response.json({ error: "change_unavailable" }, { status: 503 });
  if (!impact) return Response.json({ error: "not_found" }, { status: 404 });
  const [classification, runs] = await Promise.all([
    auth.client
      .from("source_change_classifications")
      .select("id,change_id,material,category,summary,confidence,classified_at,status")
      .eq("id", impact.source_change_classification_id)
      .maybeSingle(),
    auth.client
      .from("preflight_runs")
      .select("id,status,verified_impact,deadline,announced_at,effective_at,completed_at")
      .eq("workspace_id", workspaceId.data)
      .eq("impact_assessment_id", id)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  if (classification.error || runs.error)
    return Response.json({ error: "change_unavailable" }, { status: 503 });
  const dependency = Array.isArray(impact.workspace_dependencies)
    ? impact.workspace_dependencies[0]
    : impact.workspace_dependencies;
  if (
    !classification.data ||
    classification.data.status !== "classified" ||
    !dependency?.monitoring_enabled
  )
    return Response.json({ error: "not_found" }, { status: 404 });
  const change = await auth.client
    .from("source_changes")
    .select("id,source_id,created_at")
    .eq("id", classification.data.change_id)
    .maybeSingle();
  if (change.error) return Response.json({ error: "change_unavailable" }, { status: 503 });
  const source = change.data
    ? await auth.client
        .from("source_catalog")
        .select("id,name,source_type,url")
        .eq("id", change.data.source_id)
        .maybeSingle()
    : { data: null, error: null };
  if (source.error) return Response.json({ error: "change_unavailable" }, { status: 503 });
  return Response.json({
    item: {
      id: impact.id,
      dependency,
      source: source.data,
      change: classification.data
        ? {
            category: classification.data.category,
            summary: classification.data.summary,
            material: classification.data.material,
            confidence: classification.data.confidence,
            classifiedAt: classification.data.classified_at,
            detectedAt: change.data?.created_at ?? null,
          }
        : null,
      customerImpact: {
        relevant: impact.relevant,
        severity: impact.severity,
        summary: impact.impact_summary,
        whyItMatters: impact.why_it_matters,
        recommendedAction: impact.recommended_action,
        actionRequired: impact.action_required,
        confidence: impact.confidence,
      },
      preflight: runs.data?.[0] ?? null,
      assessedAt: impact.assessed_at,
    },
  });
}
