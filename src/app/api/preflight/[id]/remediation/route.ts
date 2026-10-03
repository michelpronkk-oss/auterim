import { authenticateOnboardingRequest, onboardingError } from "@/lib/onboarding/auth";
import { buildRemediationGuidance } from "@/lib/preflight/remediation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveWorkspaceEntitlementsForMember } from "@/lib/billing/server";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const { data: run, error: runError } = await auth.client
    .from("preflight_runs")
    .select(
      "id,workspace_id,status,verified_impact,confidence,complexity,recommended_remediation,effective_at,announced_at,deadline,days_remaining,repositories_scanned",
    )
    .eq("id", id)
    .maybeSingle();
  if (runError) return Response.json({ error: "preflight_unavailable" }, { status: 503 });
  if (!run) return Response.json({ error: "not_found" }, { status: 404 });
  try {
    const entitlements = await resolveWorkspaceEntitlementsForMember(auth.client, run.workspace_id);
    if (!entitlements.capabilities.generateFix)
      return Response.json({ error: "pro_plan_required" }, { status: 402 });
    if (entitlements.usage.remediationRuns >= entitlements.limits.remediationRuns)
      return Response.json({ error: "plan_usage_limit_reached" }, { status: 429 });
  } catch {
    return Response.json({ error: "billing_state_unavailable" }, { status: 503 });
  }
  if (run.status !== "completed" || run.verified_impact !== "verified") {
    return Response.json({ error: "verified_impact_required" }, { status: 409 });
  }
  const { data: findings, error: findingsError } = await auth.client
    .from("preflight_findings")
    .select(
      "repository_id,commit_sha,file_path,line_start,line_end,finding_type,affected_entity,confidence,verification,explanation,evidence_fingerprint",
    )
    .eq("preflight_run_id", id)
    .eq("verification", "verified")
    .limit(20);
  if (findingsError) return Response.json({ error: "preflight_unavailable" }, { status: 503 });
  const result = {
    status: run.status,
    verifiedImpact: run.verified_impact,
    confidence: Number(run.confidence),
    repositoriesScanned: run.repositories_scanned,
    findings: (findings ?? []).map((item) => ({
      repositoryId: item.repository_id,
      repository: "",
      commitSha: item.commit_sha,
      path: item.file_path,
      lineStart: item.line_start,
      lineEnd: item.line_end,
      findingType: item.finding_type,
      affectedEntity: item.affected_entity,
      confidence: Number(item.confidence),
      verification: item.verification,
      explanation: item.explanation,
      evidenceFingerprint: item.evidence_fingerprint,
    })),
    affectedAreas: [],
    complexity: run.complexity,
    recommendedRemediation: run.recommended_remediation,
    effectiveAt: run.effective_at,
    announcedAt: run.announced_at,
    deadline: run.deadline,
    daysRemaining: run.days_remaining,
  } as const;
  let proposal;
  try {
    proposal = buildRemediationGuidance({
      preflightRunId: run.id,
      result: result as never,
      findings: result.findings as never,
    });
  } catch (error) {
    return onboardingError(error);
  }
  const service = createSupabaseServerClient();
  const { data: saved, error: saveError } = await service
    .from("remediation_proposals")
    .upsert(
      {
        workspace_id: run.workspace_id,
        preflight_run_id: run.id,
        proposal_kind: proposal.proposalKind,
        proposal_fingerprint: proposal.fingerprint,
        rationale: proposal.rationale,
        migration_notes: proposal.migrationNotes,
        validation_requirements: proposal.validationRequirements,
        affected_files: proposal.affectedFiles,
        patch: null,
        base_commit_sha: result.findings[0]?.commitSha,
        created_by: auth.user.id,
      },
      { onConflict: "preflight_run_id,proposal_fingerprint", ignoreDuplicates: true },
    )
    .select(
      "id,status,proposal_kind,rationale,migration_notes,validation_requirements,affected_files,created_at",
    )
    .maybeSingle();
  if (saveError) return Response.json({ error: "remediation_save_failed" }, { status: 503 });
  let response = saved;
  if (!response) {
    const existing = await service
      .from("remediation_proposals")
      .select(
        "id,status,proposal_kind,rationale,migration_notes,validation_requirements,affected_files,created_at",
      )
      .eq("preflight_run_id", run.id)
      .eq("proposal_fingerprint", proposal.fingerprint)
      .single();
    if (existing.error) return Response.json({ error: "remediation_save_failed" }, { status: 503 });
    response = existing.data;
  }
  await service.from("protection_value_events").upsert(
    {
      workspace_id: run.workspace_id,
      event_kind: "remediation_generated",
      impact_assessment_id: (
        await service
          .from("preflight_runs")
          .select("impact_assessment_id")
          .eq("id", run.id)
          .single()
      ).data?.impact_assessment_id,
      preflight_run_id: run.id,
      remediation_proposal_id: response.id,
      dedupe_key: proposal.fingerprint,
    },
    { onConflict: "workspace_id,event_kind,dedupe_key", ignoreDuplicates: true },
  );
  return Response.json(
    { ...response, patchPrepared: false, draftPullRequestAvailable: false },
    { status: 201 },
  );
}
