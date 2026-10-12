import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const { data: run, error: runError } = await auth.client
    .from("preflight_runs")
    .select(
      "id,workspace_id,impact_assessment_id,protected_product_id,preflight_mode,status,verified_impact,confidence,complexity,recommended_remediation,effective_at,announced_at,deadline,days_remaining,repositories_scanned,preflight_version,created_at,completed_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (runError) return Response.json({ error: "preflight_unavailable" }, { status: 503 });
  if (!run) return Response.json({ error: "not_found" }, { status: 404 });
  const { data: findings, error: findingsError } = await auth.client
    .from("preflight_findings")
    .select(
      "id,repository_id,commit_sha,file_path,line_start,line_end,finding_type,affected_entity,confidence,verification,explanation,evidence_fingerprint,observed_at,repositories(owner,name)",
    )
    .eq("preflight_run_id", id)
    .order("file_path")
    .limit(200);
  if (findingsError) return Response.json({ error: "preflight_unavailable" }, { status: 503 });
  const { data: baselineEvidence, error: baselineEvidenceError } =
    run.preflight_mode === "baseline"
      ? await auth.client
          .from("baseline_preflight_evidence")
          .select(
            "id,repository_id,provider,external_repository_id,repository_owner,repository_name,default_branch,commit_sha,verification_state,observed_at",
          )
          .eq("workspace_id", run.workspace_id)
          .eq("preflight_run_id", id)
          .order("observed_at")
          .limit(100)
      : { data: [], error: null };
  if (baselineEvidenceError)
    return Response.json({ error: "preflight_unavailable" }, { status: 503 });
  return Response.json({
    mode: run.preflight_mode,
    productId: run.protected_product_id,
    status: run.status,
    verifiedImpact: run.verified_impact,
    confidence: run.confidence,
    effectiveAt: run.effective_at,
    announcedAt: run.announced_at,
    deadline: run.deadline,
    daysRemaining: run.days_remaining,
    repositoriesScanned: run.repositories_scanned,
    complexity: run.complexity,
    recommendedRemediation: run.recommended_remediation,
    remediationAvailable:
      run.preflight_mode === "change" &&
      run.status === "completed" &&
      run.verified_impact === "verified",
    findings: findings ?? [],
    baselineEvidence: baselineEvidence ?? [],
    createdAt: run.created_at,
    completedAt: run.completed_at,
  });
}
