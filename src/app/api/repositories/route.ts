import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";

export async function GET(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const workspaceId = new URL(request.url).searchParams.get("workspaceId");
  if (!workspaceId) return Response.json({ error: "workspace_id_required" }, { status: 400 });
  const membership = await auth.client
    .from("workspace_members")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (membership.error)
    return Response.json({ error: "workspace_access_unavailable" }, { status: 503 });
  if (!membership.data) return Response.json({ error: "forbidden" }, { status: 403 });
  const [
    { data: connections, error: connectionError },
    { data: repositories, error: repositoryError },
  ] = await Promise.all([
    auth.client
      .from("repository_connections")
      .select("id,provider,account_login,status,connected_at,revoked_at")
      .eq("workspace_id", workspaceId)
      .order("connected_at", { ascending: false }),
    auth.client
      .from("repositories")
      .select(
        "id,connection_id,owner,name,default_branch,private,archived,status,selected_for_protection,last_synced_at",
      )
      .eq("workspace_id", workspaceId)
      .order("owner")
      .order("name"),
  ]);
  if (connectionError || repositoryError)
    return Response.json({ error: "repositories_unavailable" }, { status: 503 });
  const repositoryIds = (repositories ?? []).map((repository) => repository.id);
  const { data: access, error: accessError } = repositoryIds.length
    ? await auth.client
        .from("workspace_repository_access")
        .select("repository_id,workspace_dependency_id")
        .eq("workspace_id", workspaceId)
        .in("repository_id", repositoryIds)
    : { data: [], error: null };
  if (accessError) return Response.json({ error: "repositories_unavailable" }, { status: 503 });
  const dependencyIds = [...new Set((access ?? []).map((item) => item.workspace_dependency_id))];
  const [dependenciesResult, mappingResult] = await Promise.all([
    dependencyIds.length
      ? auth.client
          .from("workspace_dependencies")
          .select("id,protected_product_id")
          .eq("workspace_id", workspaceId)
          .in("id", dependencyIds)
      : Promise.resolve({ data: [], error: null }),
    repositoryIds.length
      ? auth.client
          .from("workspace_product_repositories")
          .select("repository_id,protected_product_id,status")
          .eq("workspace_id", workspaceId)
          .in("repository_id", repositoryIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (dependenciesResult.error || mappingResult.error)
    return Response.json({ error: "repositories_unavailable" }, { status: 503 });
  const productByDependency = new Map(
    (dependenciesResult.data ?? []).map((dependency) => [
      dependency.id,
      dependency.protected_product_id,
    ]),
  );
  const productIdsByRepository = new Map<string, Set<string>>();
  for (const edge of access ?? []) {
    const productId = productByDependency.get(edge.workspace_dependency_id);
    if (!productId) continue;
    const productIds = productIdsByRepository.get(edge.repository_id) ?? new Set();
    productIds.add(productId);
    productIdsByRepository.set(edge.repository_id, productIds);
  }
  const mappingsByRepository = new Map<string, typeof mappingResult.data>();
  for (const mapping of mappingResult.data ?? []) {
    const mappings = mappingsByRepository.get(mapping.repository_id) ?? [];
    mappings.push(mapping);
    mappingsByRepository.set(mapping.repository_id, mappings);
  }
  return Response.json(
    {
      connections: connections ?? [],
      repositories: (repositories ?? []).map((repository) => {
        const productIds = [...(productIdsByRepository.get(repository.id) ?? [])];
        const mappings = mappingsByRepository.get(repository.id) ?? [];
        const legacyAttribution = mappings.length
          ? "explicit_mapping_history"
          : !repository.selected_for_protection
            ? "not_selected"
            : productIds.length === 1
              ? "unique_product"
              : productIds.length > 1
                ? "mapping_required"
                : "unattributed";
        return {
          ...repository,
          legacyAttribution,
          activeProductIds: mappings
            .filter((mapping) => mapping.status === "active")
            .map((mapping) => mapping.protected_product_id),
          protectedDependencyIds: (access ?? [])
            .filter((item) => item.repository_id === repository.id)
            .map((item) => item.workspace_dependency_id),
        };
      }),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
