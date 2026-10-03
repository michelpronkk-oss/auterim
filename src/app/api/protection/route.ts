import { z } from "zod";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { getWorkspaceRole, resolveWorkspaceEntitlementsForMember } from "@/lib/billing/server";
import {
  getActionsOverview,
  getChangesOverview,
  getDependenciesOverview,
  getUpcomingDeadlines,
  getProtectionSummary,
} from "@/lib/protection/read-models";

const periodDays = z.coerce.number().int().min(1).max(366).default(7);

export async function GET(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const search = new URL(request.url).searchParams;
  const workspaceId = z.string().uuid().safeParse(search.get("workspaceId"));
  const view = z
    .enum(["today", "dependencies", "changes", "actions", "report"])
    .safeParse(search.get("view") ?? "today");
  const days = periodDays.safeParse(search.get("days") ?? 7);
  if (!workspaceId.success || !view.success || !days.success) {
    return Response.json({ error: "invalid_protection_query" }, { status: 400 });
  }
  try {
    const role = await getWorkspaceRole(auth.client, workspaceId.data, auth.user.id);
    if (!role) return Response.json({ error: "forbidden" }, { status: 403 });
    if (view.data === "dependencies") {
      return Response.json(
        await getDependenciesOverview(auth.client, workspaceId.data, search.get("cursor")),
      );
    }
    if (view.data === "changes") {
      const relevantOnly = search.get("relevant") === "true";
      const verifiedOnly = search.get("verified") === "true";
      const unresolvedOnly = search.get("unresolved") === "true";
      return Response.json(
        await getChangesOverview(auth.client, workspaceId.data, {
          cursor: search.get("cursor"),
          relevantOnly,
          verifiedOnly,
          unresolvedOnly,
        }),
      );
    }
    if (view.data === "actions") {
      const entitlements = await resolveWorkspaceEntitlementsForMember(
        auth.client,
        workspaceId.data,
      );
      return Response.json(
        await getActionsOverview(
          auth.client,
          workspaceId.data,
          entitlements.capabilities.automaticPreflight,
        ),
      );
    }
    const entitlements = await resolveWorkspaceEntitlementsForMember(auth.client, workspaceId.data);
    const [summary, coverageResult, actions, changes, deadlines, assessment, onboarding] =
      await Promise.all([
        getProtectionSummary(auth.client, workspaceId.data, days.data),
        auth.client.rpc("get_protection_coverage", { p_workspace_id: workspaceId.data }),
        getActionsOverview(
          auth.client,
          workspaceId.data,
          entitlements.capabilities.automaticPreflight,
        ),
        getChangesOverview(auth.client, workspaceId.data, { relevantOnly: true }),
        getUpcomingDeadlines(auth.client, workspaceId.data),
        auth.client
          .from("workspace_initial_assessments")
          .select(
            "activated_at,dependencies_confirmed,authoritative_sources_available,current_global_baselines,material_changes_evaluated,relevant_changes,verified_repository_exposures,remediation_available",
          )
          .eq("workspace_id", workspaceId.data)
          .maybeSingle(),
        auth.client
          .from("workspace_onboarding")
          .select("state,activated_at")
          .eq("workspace_id", workspaceId.data)
          .maybeSingle(),
      ]);
    if (assessment.error || onboarding.error || coverageResult.error)
      throw new Error("protection_read_model_unavailable");
    const coverage = coverageResult.data as Record<string, number | string>;
    const dependenciesProtected = Number(coverage.dependenciesProtected ?? 0);
    const sources = Number(coverage.authoritativeSourcesCovered ?? 0);
    const baselineStatus = String(coverage.baselineStatus ?? "partial");
    const unresolvedRisks = Number(summary.unresolvedRisks ?? 0);
    const status =
      onboarding.data?.state !== "active"
        ? "setup_incomplete"
        : actions.items.length || unresolvedRisks
          ? "attention_required"
          : "all_protected";
    const initial = assessment.data
      ? {
          activatedAt: assessment.data.activated_at,
          dependenciesConfirmed: assessment.data.dependencies_confirmed,
          authoritativeSourcesAvailable: assessment.data.authoritative_sources_available,
          snapshotsObservedAtActivation: assessment.data.current_global_baselines,
          customerImpactAssessmentsAtActivation: assessment.data.material_changes_evaluated,
          relevantChanges: assessment.data.relevant_changes,
          verifiedRepositoryExposures: assessment.data.verified_repository_exposures,
          remediationsAvailable: assessment.data.remediation_available,
        }
      : null;
    const result = {
      status,
      currentStep: onboarding.data?.state ?? null,
      protection: {
        ...coverage,
        dependenciesProtected,
        authoritativeSourcesCovered: sources,
        baselineStatus,
      },
      attention: actions.items.slice(0, 10),
      upcomingDeadlines: deadlines.slice(0, 10),
      recentRelevantChanges: changes.items.slice(0, 10),
      pendingActions: actions.items,
      protectionSummary: summary,
      initialAssessment: initial,
      periodDays: days.data,
    };
    return Response.json(view.data === "report" ? { report: result } : result);
  } catch {
    return Response.json({ error: "protection_read_model_unavailable" }, { status: 503 });
  }
}
