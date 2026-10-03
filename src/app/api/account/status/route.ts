import { z } from "zod";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { getWorkspaceRole, resolveWorkspaceEntitlementsForMember } from "@/lib/billing/server";

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
    if (error) return Response.json({ error: "account_state_unavailable" }, { status: 503 });
    return Response.json({ workspaces: data ?? [] });
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
    return Response.json({
      user: { id: auth.user.id, email: auth.user.email },
      role,
      onboarding,
      entitlements,
      initialAssessment,
    });
  } catch {
    return Response.json({ error: "account_state_unavailable" }, { status: 503 });
  }
}
