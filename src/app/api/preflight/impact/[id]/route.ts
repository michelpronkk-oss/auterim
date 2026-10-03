import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const { data: assessment, error } = await auth.client
    .from("impact_assessments")
    .select(
      "id,workspace_id,workspace_dependency_id,source_change_classification_id,status,relevant,severity,impact_summary,why_it_matters,recommended_action,assessed_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) return Response.json({ error: "preflight_unavailable" }, { status: 503 });
  if (!assessment) return Response.json({ error: "not_found" }, { status: 404 });
  const service = createSupabaseServerClient();
  const [dependencyResult, classificationResult, runResult] = await Promise.all([
    service
      .from("workspace_dependencies")
      .select("dependency_id")
      .eq("id", assessment.workspace_dependency_id)
      .eq("workspace_id", assessment.workspace_id)
      .maybeSingle(),
    service
      .from("source_change_classifications")
      .select("change_id,summary,category,affected_entities,evidence")
      .eq("id", assessment.source_change_classification_id)
      .maybeSingle(),
    auth.client
      .from("preflight_runs")
      .select(
        "id,status,verified_impact,confidence,complexity,recommended_remediation,effective_at,announced_at,deadline,days_remaining,repositories_scanned,created_at,completed_at",
      )
      .eq("impact_assessment_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (dependencyResult.error || classificationResult.error || runResult.error)
    return Response.json({ error: "preflight_unavailable" }, { status: 503 });
  const dependencyId = dependencyResult.data?.dependency_id;
  const dependency = dependencyId
    ? await service
        .from("dependency_catalog")
        .select("name,slug,category")
        .eq("id", dependencyId)
        .maybeSingle()
    : { data: null, error: null };
  if (dependency.error) return Response.json({ error: "preflight_unavailable" }, { status: 503 });
  const run = runResult.data;
  const findingsQuery = run
    ? await auth.client
        .from("preflight_findings")
        .select(
          "id,repository_id,commit_sha,file_path,line_start,line_end,finding_type,affected_entity,confidence,verification,explanation,evidence_fingerprint,observed_at,repositories(owner,name)",
        )
        .eq("preflight_run_id", run.id)
        .order("file_path")
        .limit(200)
    : { data: [], error: null };
  if (findingsQuery.error)
    return Response.json({ error: "preflight_unavailable" }, { status: 503 });
  return Response.json({
    status: run?.status ?? "not_started",
    verifiedImpact: run?.verified_impact ?? null,
    confidence: run?.confidence ?? null,
    dependency: dependency.data ?? null,
    impact: {
      relevant: assessment.relevant,
      severity: assessment.severity,
      summary: assessment.impact_summary,
      whyItMatters: assessment.why_it_matters,
      recommendedAction: assessment.recommended_action,
      assessedAt: assessment.assessed_at,
    },
    change: classificationResult.data
      ? {
          summary: classificationResult.data.summary,
          category: classificationResult.data.category,
          affectedEntities: classificationResult.data.affected_entities,
          evidence: classificationResult.data.evidence,
        }
      : null,
    effectiveAt: run?.effective_at ?? null,
    announcedAt: run?.announced_at ?? null,
    deadline: run?.deadline ?? null,
    daysRemaining: run?.days_remaining ?? null,
    repositoriesScanned: run?.repositories_scanned ?? 0,
    findings: findingsQuery.data ?? [],
    complexity: run?.complexity ?? "unknown",
    recommendedRemediation: run?.recommended_remediation ?? null,
    remediationAvailable: run?.status === "completed" && run?.verified_impact === "verified",
    preflightRunId: run?.id ?? null,
  });
}
