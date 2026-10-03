import { authenticateOnboardingRequest, parseJsonBody } from "@/lib/onboarding/auth";
import { getWorkspaceRole, resolveWorkspaceEntitlementsForMember } from "@/lib/billing/server";
import { z } from "zod";

const selectionSchema = z.object({
  selectedForProtection: z.boolean(),
  dependencyIds: z.array(z.string().uuid()).max(50).default([]),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  let input: z.infer<typeof selectionSchema>;
  try {
    input = selectionSchema.parse(await parseJsonBody(request));
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const { data: repository, error: repositoryError } = await auth.client
    .from("repositories")
    .select("id,workspace_id,status")
    .eq("id", id)
    .maybeSingle();
  if (repositoryError) return Response.json({ error: "repository_unavailable" }, { status: 503 });
  if (!repository) return Response.json({ error: "not_found" }, { status: 404 });
  const role = await getWorkspaceRole(auth.client, repository.workspace_id, auth.user.id);
  if (!role) return Response.json({ error: "forbidden" }, { status: 403 });
  if (input.selectedForProtection) {
    if (role !== "owner" && role !== "admin")
      return Response.json({ error: "forbidden" }, { status: 403 });
    try {
      const entitlements = await resolveWorkspaceEntitlementsForMember(
        auth.client,
        repository.workspace_id,
      );
      if (!entitlements.capabilities.automaticPreflight)
        return Response.json({ error: "pro_plan_required" }, { status: 402 });
    } catch {
      return Response.json({ error: "billing_state_unavailable" }, { status: 503 });
    }
  }
  if (
    input.selectedForProtection &&
    (repository.status !== "available" || input.dependencyIds.length === 0)
  ) {
    return Response.json(
      { error: "available_repository_and_dependency_required" },
      { status: 422 },
    );
  }
  if (!input.selectedForProtection && input.dependencyIds.length > 0)
    return Response.json({ error: "dependency_ids_require_selection" }, { status: 400 });
  if (input.dependencyIds.length > 0) {
    const { data: dependencies, error } = await auth.client
      .from("workspace_dependencies")
      .select("id")
      .eq("workspace_id", repository.workspace_id)
      .in("id", input.dependencyIds);
    if (error) return Response.json({ error: "dependencies_unavailable" }, { status: 503 });
    if ((dependencies ?? []).length !== new Set(input.dependencyIds).size)
      return Response.json({ error: "dependency_not_found" }, { status: 404 });
  }
  const { data, error } = await auth.client.rpc("set_repository_protection", {
    p_repository_id: id,
    p_selected: input.selectedForProtection,
    p_dependency_ids: input.dependencyIds,
  });
  if (error)
    return Response.json(
      { error: error.code === "42501" ? "forbidden" : "repository_update_failed" },
      { status: error.code === "42501" ? 403 : 422 },
    );
  return Response.json(data);
}
