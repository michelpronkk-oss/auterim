import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

const REPOSITORY_PAGE_LIMIT = 200;

export async function getProductRepositoryProtection(
  client: SupabaseClient,
  input: { workspaceId: string; productId: string; verificationCapabilityAvailable: boolean },
) {
  const { workspaceId, productId } = input;
  const { data: product, error: productError } = await client
    .from("workspace_products")
    .select("id,name,status")
    .eq("id", productId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (productError) throw new Error("product_repository_graph_unavailable");
  if (!product) return null;

  const [repositoryResult, dependencyResult] = await Promise.all([
    client
      .from("repositories")
      .select(
        "id,connection_id,owner,name,default_branch,private,archived,status,selected_for_protection",
      )
      .eq("workspace_id", workspaceId)
      .order("owner")
      .order("name")
      .limit(REPOSITORY_PAGE_LIMIT + 1),
    client
      .from("workspace_dependencies")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("protected_product_id", productId),
  ]);
  if (repositoryResult.error || dependencyResult.error)
    throw new Error("product_repository_graph_unavailable");

  const repositories = repositoryResult.data ?? [];
  const truncated = repositories.length > REPOSITORY_PAGE_LIMIT;
  const boundedRepositories = repositories.slice(0, REPOSITORY_PAGE_LIMIT);
  const repositoryIds = boundedRepositories.map((repository) => repository.id);
  const dependencyIds = (dependencyResult.data ?? []).map((dependency) => dependency.id);
  const [mappingResult, connectionsResult, accessResult] = await Promise.all([
    repositoryIds.length
      ? client
          .from("workspace_product_repositories")
          .select("repository_id,protected_product_id,status,provenance,created_at")
          .eq("workspace_id", workspaceId)
          .in("repository_id", repositoryIds)
      : Promise.resolve({ data: [], error: null }),
    boundedRepositories.length
      ? client
          .from("repository_connections")
          .select("id,status")
          .eq("workspace_id", workspaceId)
          .in("id", [...new Set(boundedRepositories.map((repository) => repository.connection_id))])
      : Promise.resolve({ data: [], error: null }),
    dependencyIds.length && repositoryIds.length
      ? client
          .from("workspace_repository_access")
          .select("workspace_dependency_id,repository_id")
          .eq("workspace_id", workspaceId)
          .in("workspace_dependency_id", dependencyIds)
          .in("repository_id", repositoryIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (mappingResult.error || connectionsResult.error || accessResult.error)
    throw new Error("product_repository_graph_unavailable");

  const mappings = mappingResult.data ?? [];
  const mappingHistoryRepositoryIds = new Set(mappings.map((mapping) => mapping.repository_id));
  const activeProductMappings = new Map(
    mappings
      .filter(
        (mapping) =>
          mapping.protected_product_id === productId &&
          mapping.status === "active" &&
          mapping.repository_id &&
          mapping.provenance,
      )
      .map((mapping) => [mapping.repository_id, mapping]),
  );
  const legacyDependencyRepositoryIds = new Set(
    (accessResult.data ?? []).map((access) => access.repository_id),
  );
  const mappedRepositoryIds = new Set(activeProductMappings.keys());
  for (const repository of boundedRepositories) {
    if (
      repository.selected_for_protection &&
      !mappingHistoryRepositoryIds.has(repository.id) &&
      legacyDependencyRepositoryIds.has(repository.id)
    ) {
      mappedRepositoryIds.add(repository.id);
    }
  }

  const connectionHealth = new Map(
    (connectionsResult.data ?? []).map((connection) => [connection.id, connection.status]),
  );
  const mappedDependencyIds = (accessResult.data ?? []).map(
    (access) => access.workspace_dependency_id,
  );
  const impactResult = mappedDependencyIds.length
    ? await client
        .from("impact_assessments")
        .select("id")
        .eq("workspace_id", workspaceId)
        .in("workspace_dependency_id", mappedDependencyIds)
    : { data: [], error: null };
  if (impactResult.error) throw new Error("product_repository_graph_unavailable");
  const impactIds = (impactResult.data ?? []).map((impact) => impact.id);
  const runResult = impactIds.length
    ? await client
        .from("preflight_runs")
        .select("id")
        .eq("workspace_id", workspaceId)
        .in("impact_assessment_id", impactIds)
        .in("status", ["completed", "partial"])
    : { data: [], error: null };
  if (runResult.error) throw new Error("product_repository_graph_unavailable");
  const runIds = (runResult.data ?? []).map((run) => run.id);
  const findingResult =
    runIds.length && repositoryIds.length
      ? await client
          .from("preflight_findings")
          .select("repository_id")
          .eq("workspace_id", workspaceId)
          .in("preflight_run_id", runIds)
          .in("repository_id", repositoryIds)
      : { data: [], error: null };
  if (findingResult.error) throw new Error("product_repository_graph_unavailable");
  const repositoryIdsWithEvidence = new Set(
    (findingResult.data ?? []).map((finding) => finding.repository_id),
  );

  const summarize = (repository: (typeof boundedRepositories)[number]) => {
    const connectionStatus = connectionHealth.get(repository.connection_id) ?? "unknown";
    const isAvailable = repository.status === "available" && connectionStatus === "connected";
    const mapping = activeProductMappings.get(repository.id);
    const legacyMapping =
      !mapping &&
      !mappingHistoryRepositoryIds.has(repository.id) &&
      legacyDependencyRepositoryIds.has(repository.id);
    return {
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
      defaultBranch: repository.default_branch,
      isPrivate: repository.private,
      status: repository.status,
      mappingStatus: mapping?.status ?? (legacyMapping ? "legacy" : "unmapped"),
      mappingProvenance: mapping?.provenance ?? (legacyMapping ? "legacy_dependency_access" : null),
      connectionHealth:
        connectionStatus === "connected"
          ? "connected"
          : connectionStatus === "revoked"
            ? "revoked"
            : "unavailable",
      verificationAvailable: isAvailable && input.verificationCapabilityAvailable,
      verificationEvidencePresent: repositoryIdsWithEvidence.has(repository.id),
    };
  };
  const mappedRepositories = boundedRepositories
    .filter((repository) => mappedRepositoryIds.has(repository.id))
    .map(summarize);
  const accessibleUnmappedRepositories = boundedRepositories
    .filter((repository) => !mappedRepositoryIds.has(repository.id))
    .map(summarize);
  const inactiveMappings = mappings
    .filter(
      (mapping) =>
        mapping.protected_product_id === productId &&
        mapping.status === "inactive" &&
        mapping.repository_id,
    )
    .map((mapping) => ({ repositoryId: mapping.repository_id, provenance: mapping.provenance }));

  return {
    product: { id: product.id, name: product.name, status: product.status },
    mappedRepositories,
    accessibleUnmappedRepositories,
    inactiveMappings,
    accessibleRepositoryCount: boundedRepositories.length,
    accessibleRepositoriesTruncated: truncated,
  };
}
