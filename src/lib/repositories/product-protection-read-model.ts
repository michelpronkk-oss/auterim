import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { latestPreflightRuns } from "@/lib/protection/read-model-helpers";
import { hasUniqueProductAttribution } from "@/lib/repositories/product-repository-protection";
import { ProductProtectionReadError } from "@/lib/protection/read-stage";

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
  if (productError) throw new ProductProtectionReadError("product");
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
  if (repositoryResult.error) throw new ProductProtectionReadError("repository_access");
  if (dependencyResult.error) throw new ProductProtectionReadError("dependencies");

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
    repositoryIds.length
      ? client
          .from("workspace_repository_access")
          .select("workspace_dependency_id,repository_id")
          .eq("workspace_id", workspaceId)
          .in("repository_id", repositoryIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (mappingResult.error) throw new ProductProtectionReadError("repository_mappings");
  if (connectionsResult.error || accessResult.error)
    throw new ProductProtectionReadError("repository_access");

  const attributedDependencyIds = [
    ...new Set((accessResult.data ?? []).map((access) => access.workspace_dependency_id)),
  ];
  const { data: attributedDependencies, error: attributedDependenciesError } =
    attributedDependencyIds.length
      ? await client
          .from("workspace_dependencies")
          .select("id,protected_product_id")
          .eq("workspace_id", workspaceId)
          .in("id", attributedDependencyIds)
      : { data: [], error: null };
  if (attributedDependenciesError) throw new ProductProtectionReadError("repository_access");

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
  const dependencyProductById = new Map(
    (attributedDependencies ?? []).map((dependency) => [
      dependency.id,
      dependency.protected_product_id,
    ]),
  );
  const dependencyProductIdsByRepository = new Map<string, Set<string>>();
  for (const access of accessResult.data ?? []) {
    const dependencyProductId = dependencyProductById.get(access.workspace_dependency_id);
    if (!dependencyProductId) continue;
    const productIds = dependencyProductIdsByRepository.get(access.repository_id) ?? new Set();
    productIds.add(dependencyProductId);
    dependencyProductIdsByRepository.set(access.repository_id, productIds);
  }
  const mappedRepositoryIds = new Set(activeProductMappings.keys());
  for (const repository of boundedRepositories) {
    const attributedProductIds = dependencyProductIdsByRepository.get(repository.id) ?? new Set();
    if (
      repository.selected_for_protection &&
      !mappingHistoryRepositoryIds.has(repository.id) &&
      hasUniqueProductAttribution([...attributedProductIds], productId)
    ) {
      mappedRepositoryIds.add(repository.id);
    }
  }

  const connectionHealth = new Map(
    (connectionsResult.data ?? []).map((connection) => [connection.id, connection.status]),
  );
  const currentProductDependencyIds = new Set(dependencyIds);
  const mappedDependencyIds = (accessResult.data ?? [])
    .filter((access) => currentProductDependencyIds.has(access.workspace_dependency_id))
    .map((access) => access.workspace_dependency_id);
  const impactResult = mappedDependencyIds.length
    ? await client
        .from("impact_assessments")
        .select("id")
        .eq("workspace_id", workspaceId)
        .in("workspace_dependency_id", mappedDependencyIds)
    : { data: [], error: null };
  if (impactResult.error) throw new ProductProtectionReadError("impact_assessments");
  const impactIds = (impactResult.data ?? []).map((impact) => impact.id);
  const runResult = impactIds.length
    ? await client
        .from("preflight_runs")
        .select("id,impact_assessment_id,status,verified_impact,created_at,completed_at")
        .eq("workspace_id", workspaceId)
        .in("impact_assessment_id", impactIds)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(500)
    : { data: [], error: null };
  if (runResult.error) throw new ProductProtectionReadError("preflight_runs");
  const latestRuns = latestPreflightRuns(
    (runResult.data ?? []) as Array<{
      id: string;
      impact_assessment_id: string;
      status: string;
      verified_impact: string | null;
      created_at: string;
      completed_at: string | null;
    }>,
  );
  const evidenceRuns = (
    (runResult.data ?? []) as Array<{
      id: string;
      impact_assessment_id: string;
      status: string;
      verified_impact: string | null;
      created_at: string;
      completed_at: string | null;
    }>
  ).filter(
    (run) =>
      (run.status === "completed" || run.status === "partial") &&
      run.verified_impact === "verified",
  );
  const runIds = evidenceRuns.map((run) => run.id);
  const findingResult =
    runIds.length && repositoryIds.length
      ? await client
          .from("preflight_findings")
          .select("id,preflight_run_id,repository_id,commit_sha,observed_at,verification")
          .eq("workspace_id", workspaceId)
          .in("preflight_run_id", runIds)
          .in("repository_id", repositoryIds)
          .eq("verification", "verified")
          .order("observed_at", { ascending: false })
          .limit(500)
      : { data: [], error: null };
  if (findingResult.error) throw new ProductProtectionReadError("preflight_findings");
  const evidenceByRepository = new Map<
    string,
    Array<{ finding: (typeof findingResult.data)[number]; run: (typeof evidenceRuns)[number] }>
  >();
  for (const finding of findingResult.data ?? []) {
    const run = evidenceRuns.find((candidate) => candidate.id === finding.preflight_run_id);
    if (!run) continue;
    const evidence = evidenceByRepository.get(finding.repository_id) ?? [];
    evidence.push({ finding, run });
    evidenceByRepository.set(finding.repository_id, evidence);
  }

  const mappedIds = [...mappedRepositoryIds];
  const baselineEvidenceResult = mappedIds.length
    ? await client
        .from("baseline_preflight_evidence")
        .select("id,preflight_run_id,repository_id,commit_sha,observed_at")
        .eq("workspace_id", workspaceId)
        .eq("protected_product_id", productId)
        .in("repository_id", mappedIds)
        .eq("verification_state", "verified")
        .order("observed_at", { ascending: false })
        .limit(500)
    : { data: [], error: null };
  if (baselineEvidenceResult.error) throw new ProductProtectionReadError("baseline_evidence");
  const baselineRunIds = [
    ...new Set((baselineEvidenceResult.data ?? []).map((row) => row.preflight_run_id)),
  ];
  const baselineRunsResult = baselineRunIds.length
    ? await client
        .from("preflight_runs")
        .select("id,created_at,completed_at,status,preflight_mode,protected_product_id")
        .eq("workspace_id", workspaceId)
        .eq("protected_product_id", productId)
        .eq("preflight_mode", "baseline")
        .eq("status", "completed")
        .in("id", baselineRunIds)
        .limit(500)
    : { data: [], error: null };
  if (baselineRunsResult.error) throw new ProductProtectionReadError("baseline_runs");
  const baselineRunById = new Map((baselineRunsResult.data ?? []).map((run) => [run.id, run]));
  const baselineEvidenceByRepository = new Map<
    string,
    Array<{ id: string; preflight_run_id: string; commit_sha: string; observed_at: string }>
  >();
  for (const evidence of baselineEvidenceResult.data ?? []) {
    if (!baselineRunById.has(evidence.preflight_run_id)) continue;
    const existing = baselineEvidenceByRepository.get(evidence.repository_id) ?? [];
    existing.push(evidence);
    baselineEvidenceByRepository.set(evidence.repository_id, existing);
  }

  const summarize = (repository: (typeof boundedRepositories)[number]) => {
    const connectionStatus = connectionHealth.get(repository.connection_id) ?? "unknown";
    const isAvailable = repository.status === "available" && connectionStatus === "connected";
    const mapping = activeProductMappings.get(repository.id);
    const attributedProductIds = dependencyProductIdsByRepository.get(repository.id) ?? new Set();
    const legacyMapping =
      !mapping &&
      !mappingHistoryRepositoryIds.has(repository.id) &&
      repository.selected_for_protection &&
      hasUniqueProductAttribution([...attributedProductIds], productId);
    const mappingRequired =
      !mapping &&
      !mappingHistoryRepositoryIds.has(repository.id) &&
      repository.selected_for_protection &&
      attributedProductIds.size > 1;
    return {
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
      defaultBranch: repository.default_branch,
      isPrivate: repository.private,
      status: repository.status,
      mappingStatus:
        mapping?.status ??
        (legacyMapping ? "legacy" : mappingRequired ? "mapping_required" : "unmapped"),
      mappingProvenance: mapping?.provenance ?? (legacyMapping ? "legacy_dependency_access" : null),
      connectionHealth:
        connectionStatus === "connected"
          ? "connected"
          : connectionStatus === "revoked"
            ? "revoked"
            : "unavailable",
      verificationAvailable: isAvailable && input.verificationCapabilityAvailable,
      verificationEvidencePresent: evidenceByRepository.has(repository.id),
      verificationEvidence: (evidenceByRepository.get(repository.id) ?? [])
        .sort(
          (left, right) =>
            right.run.created_at.localeCompare(left.run.created_at) ||
            right.finding.id.localeCompare(left.finding.id),
        )
        .slice(0, 5)
        .map(({ finding, run }) => ({
          runId: run.id,
          result: run.verified_impact,
          completedAt: run.completed_at,
          findingId: finding.id,
          commitSha: finding.commit_sha,
          observedAt: finding.observed_at,
          currentness: "not_revalidated_against_live_repository_head",
          relativeToLatestAttempt:
            latestRuns.get(run.impact_assessment_id)?.id === run.id
              ? "same_as_latest_attempt"
              : "historical_before_latest_attempt",
        })),
      baselineVerification: (baselineEvidenceByRepository.get(repository.id) ?? [])
        .slice(0, 5)
        .map((evidence) => {
          const run = baselineRunById.get(evidence.preflight_run_id);
          return {
            runId: evidence.preflight_run_id,
            evidenceId: evidence.id,
            mode: "baseline" as const,
            verificationState: "verified" as const,
            commitSha: evidence.commit_sha,
            verifiedAt: run?.completed_at ?? evidence.observed_at,
            observedAt: evidence.observed_at,
          };
        }),
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
