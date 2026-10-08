import { z } from "zod";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { getWorkspaceRole, resolveWorkspaceEntitlementsForMember } from "@/lib/billing/server";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const requestedId = new URL(request.url).searchParams.get("workspaceId");
  if (!requestedId) {
    const { data, error } = await auth.client
      .from("workspace_members")
      .select("workspace_id,role")
      .eq("user_id", auth.user.id)
      .order("created_at", { ascending: true });
    if (error)
      return Response.json(
        { error: "account_state_unavailable" },
        { status: 503, headers: PRIVATE_NO_STORE },
      );
    const memberships = data ?? [];
    if (memberships.length === 0)
      return Response.json({ workspaces: [] }, { headers: PRIVATE_NO_STORE });

    const { data: workspaceRows, error: workspaceError } = await auth.client
      .from("workspaces")
      .select("id,name")
      .in(
        "id",
        memberships.map((membership) => membership.workspace_id),
      );
    if (workspaceError)
      return Response.json(
        { error: "account_state_unavailable" },
        { status: 503, headers: PRIVATE_NO_STORE },
      );

    const workspaceNames = new Map(
      (workspaceRows ?? []).map((workspace) => [workspace.id, workspace.name]),
    );
    if (memberships.some((membership) => !workspaceNames.has(membership.workspace_id)))
      return Response.json(
        { error: "account_state_unavailable" },
        { status: 503, headers: PRIVATE_NO_STORE },
      );

    return Response.json(
      {
        workspaces: memberships.map((membership) => ({
          ...membership,
          workspace_name: workspaceNames.get(membership.workspace_id),
        })),
      },
      { headers: PRIVATE_NO_STORE },
    );
  }
  const parsed = z.string().uuid().safeParse(requestedId);
  if (!parsed.success) return Response.json({ error: "invalid_workspace_id" }, { status: 400 });
  try {
    const role = await getWorkspaceRole(auth.client, parsed.data, auth.user.id);
    if (!role) return Response.json({ error: "forbidden" }, { status: 403 });
    const [
      { data: onboarding, error: onboardingError },
      entitlements,
      { data: initialAssessment, error: assessmentError },
    ] = await Promise.all([
      auth.client.rpc("get_onboarding_status", { p_workspace_id: parsed.data }),
      resolveWorkspaceEntitlementsForMember(auth.client, parsed.data),
      auth.client
        .from("workspace_initial_assessments")
        .select(
          "activated_at,dependencies_confirmed,authoritative_sources_available,current_global_baselines,material_changes_evaluated,relevant_changes,verified_repository_exposures,remediation_available,created_at",
        )
        .eq("workspace_id", parsed.data)
        .maybeSingle(),
    ]);
    if (onboardingError || assessmentError)
      return Response.json({ error: "account_state_unavailable" }, { status: 503 });
    return Response.json(
      {
        user: { id: auth.user.id, email: auth.user.email },
        role,
        onboarding,
        entitlements,
        initialAssessment: initialAssessment
          ? {
              activatedAt: initialAssessment.activated_at,
              dependenciesConfirmed: initialAssessment.dependencies_confirmed,
              authoritativeSourcesAvailable: initialAssessment.authoritative_sources_available,
              snapshotsObservedAtActivation: initialAssessment.current_global_baselines,
              materialChangesEvaluated: initialAssessment.material_changes_evaluated,
              relevantChanges: initialAssessment.relevant_changes,
              verifiedRepositoryExposures: initialAssessment.verified_repository_exposures,
              remediationsAvailable: initialAssessment.remediation_available,
            }
          : null,
      },
      { headers: PRIVATE_NO_STORE },
    );
  } catch {
    return Response.json({ error: "account_state_unavailable" }, { status: 503 });
  }
}
