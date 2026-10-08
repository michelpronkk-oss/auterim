import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  latestDependencyScan,
  latestObservationOutcome,
  latestPreflightRuns,
  monitoredCatalogDependencyIds,
  monitoringEvidenceState,
} from "@/lib/protection/read-model-helpers";
import { getProductRepositoryProtection } from "@/lib/repositories/product-protection-read-model";

const MAX_DEPENDENCIES = 50;
const MAX_SOURCES = 500;
const MAX_EVIDENCE_ROWS = 500;

type DependencyRow = {
  id: string;
  dependency_id: string;
  origin: string;
  monitoring_enabled: boolean;
  created_at: string;
  dependency_catalog:
    | { name: string; slug: string; category: string }
    | Array<{ name: string; slug: string; category: string }>
    | null;
  dependency_context:
    | {
        criticality: string;
        production_critical: boolean;
        used_for: string[];
      }
    | Array<{ criticality: string; production_critical: boolean; used_for: string[] }>
    | null;
};

type SourceRow = {
  id: string;
  dependency_id: string;
  source_type: string;
};

type ObservationRow = {
  source_id: string;
  snapshot_id: string | null;
  observed_at: string | null;
  scan_status: string | null;
  scan_finished_at: string | null;
};
type ImpactRow = {
  id: string;
  workspace_dependency_id: string;
  source_change_classification_id: string;
  relevant: boolean;
  severity: string;
  assessed_at: string;
};
type ClassificationRow = { id: string; material: boolean; status: string; change_id: string };
type RunRow = {
  id: string;
  impact_assessment_id: string;
  status: string;
  verified_impact: string | null;
  completed_at: string | null;
  created_at: string;
  repository_set_fingerprint: string;
};
type FindingRow = {
  id: string;
  preflight_run_id: string;
  repository_id: string;
  commit_sha: string;
  verification: string;
  observed_at: string;
};

export async function getProductProtectionGraph(
  client: SupabaseClient,
  input: {
    workspaceId: string;
    productId: string;
    verificationCapabilityAvailable: boolean;
  },
) {
  const { workspaceId, productId } = input;
  const { data: product, error: productError } = await client
    .from("workspace_products")
    .select("id,name,status,created_at,updated_at")
    .eq("id", productId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (productError) throw new Error("product_protection_graph_unavailable");
  if (!product) return null;

  const [dependencyResult, repositoryGraph] = await Promise.all([
    client
      .from("workspace_dependencies")
      .select(
        "id,dependency_id,origin,monitoring_enabled,created_at,dependency_catalog(name,slug,category),dependency_context(criticality,production_critical,used_for)",
        { count: "exact" },
      )
      .eq("workspace_id", workspaceId)
      .eq("protected_product_id", productId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(MAX_DEPENDENCIES + 1),
    getProductRepositoryProtection(client, input),
  ]);
  if (dependencyResult.error) throw new Error("product_protection_graph_unavailable");
  if (!repositoryGraph) return null;

  const rawDependencies = (dependencyResult.data ?? []) as DependencyRow[];
  const dependenciesTruncated = rawDependencies.length > MAX_DEPENDENCIES;
  const dependencies = rawDependencies.slice(0, MAX_DEPENDENCIES);
  const dependencyIds = dependencies.map((dependency) => dependency.id);
  // Product coverage counts only dependencies whose monitoring is enabled. Keep
  // disabled dependencies in the graph for transparency, but do not report
  // their catalog sources as protected coverage.
  const catalogDependencyIds = monitoredCatalogDependencyIds(dependencies);
  const repositoryIds = [
    ...new Set(
      [
        ...repositoryGraph.mappedRepositories,
        ...repositoryGraph.accessibleUnmappedRepositories,
      ].map((repository) => repository.id),
    ),
  ];

  const [sourceResult, accessResult, impactResult] = await Promise.all([
    catalogDependencyIds.length
      ? client
          .from("source_catalog")
          .select("id,dependency_id,source_type", { count: "exact" })
          .in("dependency_id", catalogDependencyIds)
          .eq("enabled", true)
          .order("id")
          .limit(MAX_SOURCES + 1)
      : Promise.resolve({ data: [], error: null, count: 0 }),
    dependencyIds.length && repositoryIds.length
      ? client
          .from("workspace_repository_access")
          .select("workspace_dependency_id,repository_id")
          .eq("workspace_id", workspaceId)
          .in("workspace_dependency_id", dependencyIds)
          .in("repository_id", repositoryIds)
          .limit(MAX_DEPENDENCIES * 200)
      : Promise.resolve({ data: [], error: null }),
    dependencyIds.length
      ? client
          .from("impact_assessments")
          .select(
            "id,workspace_dependency_id,source_change_classification_id,relevant,severity,assessed_at",
          )
          .eq("workspace_id", workspaceId)
          .in("workspace_dependency_id", dependencyIds)
          .eq("status", "assessed")
          .order("assessed_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(MAX_EVIDENCE_ROWS)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (sourceResult.error || accessResult.error || impactResult.error)
    throw new Error("product_protection_graph_unavailable");

  const sourceRows = (sourceResult.data ?? []) as SourceRow[];
  const sourcesTruncated = sourceRows.length > MAX_SOURCES;
  const boundedSources = sourceRows.slice(0, MAX_SOURCES);
  const sourceIds = boundedSources.map((source) => source.id);
  const impacts = (impactResult.data ?? []) as ImpactRow[];
  const assessmentIds = impacts.map((impact) => impact.id);
  const classificationIds = [
    ...new Set(impacts.map((impact) => impact.source_change_classification_id)),
  ];

  const [observationResult, classificationResult, mappingResult] = await Promise.all([
    sourceIds.length
      ? client.rpc("get_product_source_observation_states", {
          p_workspace_id: workspaceId,
          p_source_ids: sourceIds,
        })
      : Promise.resolve({ data: [], error: null, count: 0 }),
    classificationIds.length
      ? client
          .from("source_change_classifications")
          .select("id,material,status,change_id")
          .in("id", classificationIds)
      : Promise.resolve({ data: [], error: null }),
    repositoryIds.length
      ? client
          .from("workspace_product_repositories")
          .select("repository_id,protected_product_id,status,provenance,created_at")
          .eq("workspace_id", workspaceId)
          .in("repository_id", repositoryIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (observationResult.error || classificationResult.error || mappingResult.error)
    throw new Error("product_protection_graph_unavailable");

  const observations = (observationResult.data ?? []) as ObservationRow[];
  const observationsBySource = new Map(observations.map((item) => [item.source_id, item]));
  const classifications = (classificationResult.data ?? []) as ClassificationRow[];
  const mappings = mappingResult.data ?? [];
  const mappingsByRepository = new Map<string, typeof mappings>();
  for (const mapping of mappings) {
    const repositoryMappings = mappingsByRepository.get(mapping.repository_id) ?? [];
    repositoryMappings.push(mapping);
    mappingsByRepository.set(mapping.repository_id, repositoryMappings);
  }
  const mappedRepositoryIds = new Set(repositoryGraph.mappedRepositories.map((repo) => repo.id));
  const repositoryById = new Map(
    [...repositoryGraph.mappedRepositories, ...repositoryGraph.accessibleUnmappedRepositories].map(
      (repository) => [repository.id, repository],
    ),
  );

  const { data: runRows, error: runError } = assessmentIds.length
    ? await client
        .from("preflight_runs")
        .select(
          "id,impact_assessment_id,status,verified_impact,completed_at,created_at,repository_set_fingerprint",
        )
        .eq("workspace_id", workspaceId)
        .in("impact_assessment_id", assessmentIds)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(MAX_EVIDENCE_ROWS)
    : { data: [], error: null };
  if (runError) throw new Error("product_protection_graph_unavailable");
  const allRuns = (runRows ?? []) as RunRow[];
  const latestRuns = latestPreflightRuns(allRuns);
  const verifiedRuns = allRuns.filter(
    (run) =>
      (run.status === "completed" || run.status === "partial") &&
      run.verified_impact === "verified",
  );
  const relevantRunIds = [
    ...new Set([
      ...[...latestRuns.values()].map((run) => run.id),
      ...verifiedRuns.map((run) => run.id),
    ]),
  ];
  const { data: findingRows, error: findingError } =
    relevantRunIds.length && repositoryIds.length
      ? await client
          .from("preflight_findings")
          .select("id,preflight_run_id,repository_id,commit_sha,verification,observed_at")
          .eq("workspace_id", workspaceId)
          .in("preflight_run_id", relevantRunIds)
          .in("repository_id", repositoryIds)
          .order("observed_at", { ascending: false })
          .limit(MAX_EVIDENCE_ROWS)
      : { data: [], error: null };
  if (findingError) throw new Error("product_protection_graph_unavailable");
  const findings = (findingRows ?? []) as FindingRow[];
  const runById = new Map(allRuns.map((run) => [run.id, run]));
  const classificationById = new Map(classifications.map((row) => [row.id, row]));
  const impactsByDependency = new Map<string, ImpactRow[]>();
  for (const impact of impacts) {
    const list = impactsByDependency.get(impact.workspace_dependency_id) ?? [];
    list.push(impact);
    impactsByDependency.set(impact.workspace_dependency_id, list);
  }

  const dependencyNodes = dependencies.map((dependency) => {
    const provider = Array.isArray(dependency.dependency_catalog)
      ? dependency.dependency_catalog[0]
      : dependency.dependency_catalog;
    const rawContext = dependency.dependency_context;
    const context = Array.isArray(rawContext) ? rawContext[0] : rawContext;
    const enabledSources = boundedSources.filter(
      (source) => source.dependency_id === dependency.dependency_id,
    );
    const enabledSourceIds = new Set(enabledSources.map((source) => source.id));
    const sourceObservations = observations.filter((item) => enabledSourceIds.has(item.source_id));
    const latestScan = latestDependencyScan(
      sourceObservations.map((item) => ({
        source_id: item.source_id,
        status: item.scan_status,
        finished_at: item.scan_finished_at,
      })),
      enabledSourceIds,
    );
    const failedSourceScan = sourceObservations.some((scan) => scan.scan_status === "failed");
    const latestImpact = impactsByDependency.get(dependency.id)?.[0] ?? null;
    const classification = latestImpact
      ? (classificationById.get(latestImpact.source_change_classification_id) ?? null)
      : null;
    const monitoringState = monitoringEvidenceState({
      monitoringEnabled: dependency.monitoring_enabled,
      enabledSourceCount: enabledSources.length,
      sourcesWithBaseline: new Set(
        sourceObservations
          .filter((item) => item.snapshot_id !== null)
          .map((item) => item.source_id),
      ).size,
      latestScanStatus: failedSourceScan ? "failed" : (latestScan?.status ?? null),
    });
    const sourcesByType: Record<string, number> = {};
    for (const source of enabledSources)
      sourcesByType[source.source_type] = (sourcesByType[source.source_type] ?? 0) + 1;
    return {
      id: dependency.id,
      provider: provider
        ? {
            id: dependency.dependency_id,
            name: provider.name,
            slug: provider.slug,
            category: provider.category,
          }
        : {
            id: dependency.dependency_id,
            name: "Unknown catalog provider",
            slug: null,
            category: null,
          },
      identity: {
        state: "confirmed",
        origin: dependency.origin,
        confirmedAt: dependency.created_at,
      },
      criticality: context?.criticality ?? "normal",
      productionCritical: context?.production_critical ?? false,
      usedFor: context?.used_for ?? [],
      monitoring: {
        enabled: dependency.monitoring_enabled,
        state: monitoringState,
        authoritativeCoverageAvailable: enabledSources.length > 0,
        authoritativeSourcesAvailable: enabledSources.length,
        latestObservation: {
          sourcesObserved: sourceObservations.filter((item) => item.snapshot_id !== null).length,
          observedAt:
            sourceObservations
              .map((item) => item.observed_at)
              .filter((value): value is string => value !== null)
              .sort((left, right) => right.localeCompare(left))[0] ?? null,
        },
        latestScanOutcome: latestObservationOutcome(enabledSources.length, sourceObservations),
        sourcesByType,
        sources: enabledSources.slice(0, 100).map((source) => {
          const observation = observationsBySource.get(source.id);
          return {
            sourceId: source.id,
            sourceType: source.source_type,
            baseline: observation?.snapshot_id
              ? {
                  state: "observed",
                  snapshotId: observation.snapshot_id,
                  observedAt: observation.observed_at,
                }
              : { state: "not_observed", snapshotId: null, observedAt: null },
            latestScan: observation?.scan_status
              ? { status: observation.scan_status, finishedAt: observation.scan_finished_at }
              : { status: "not_scanned", finishedAt: null },
          };
        }),
        evidenceTruncated: sourcesTruncated,
        latestScanAt: latestScan?.finished_at ?? null,
      },
      customerImpact: latestImpact
        ? {
            assessmentId: latestImpact.id,
            relevant: latestImpact.relevant,
            severity: latestImpact.severity,
            assessedAt: latestImpact.assessed_at,
            classification: classification
              ? {
                  id: classification.id,
                  changeId: classification.change_id,
                  material: classification.material,
                  status: classification.status,
                }
              : null,
          }
        : null,
    };
  });

  const dependencyRepositoryEdges = (accessResult.data ?? []).map((access) => {
    const repository = repositoryById.get(access.repository_id);
    const dependency = dependencies.find((item) => item.id === access.workspace_dependency_id);
    const latestImpact = impactsByDependency.get(access.workspace_dependency_id)?.[0] ?? null;
    const latestAttempt = latestImpact ? (latestRuns.get(latestImpact.id) ?? null) : null;
    const lastVerifiedFinding = latestImpact
      ? (findings
          .filter(
            (finding) =>
              runById.get(finding.preflight_run_id)?.impact_assessment_id === latestImpact.id &&
              finding.repository_id === access.repository_id &&
              finding.verification === "verified",
          )
          .sort(
            (left, right) =>
              right.observed_at.localeCompare(left.observed_at) || right.id.localeCompare(left.id),
          )[0] ?? null)
      : null;
    const lastVerifiedRun = lastVerifiedFinding
      ? (runById.get(lastVerifiedFinding.preflight_run_id) ?? null)
      : null;
    const repositoryMappings = mappingsByRepository.get(access.repository_id) ?? [];
    const mapping = repositoryMappings.find(
      (candidate) => candidate.protected_product_id === productId,
    );
    return {
      workspaceDependencyId: access.workspace_dependency_id,
      repositoryId: access.repository_id,
      relation: mappedRepositoryIds.has(access.repository_id)
        ? "mapped_and_dependency_linked"
        : "dependency_linked_mapping_inactive_or_absent",
      mapping: mapping
        ? { state: mapping.status, provenance: mapping.provenance, createdAt: mapping.created_at }
        : repositoryMappings.length > 0
          ? { state: "mapped_to_other_product", provenance: null, createdAt: null }
          : {
              state: repository?.mappingStatus ?? "unmapped",
              provenance: repository?.mappingProvenance ?? null,
              createdAt: null,
            },
      verificationEligibility: {
        capabilityAvailable: input.verificationCapabilityAvailable,
        productProtected: product.status === "protected",
        dependencyMonitoringEnabled: dependency?.monitoring_enabled === true,
        repositoryAvailable: repository?.status === "available",
        connectionHealthy: repository?.connectionHealth === "connected",
        eligible:
          input.verificationCapabilityAvailable &&
          product.status === "protected" &&
          dependency?.monitoring_enabled === true &&
          mappedRepositoryIds.has(access.repository_id) &&
          repository?.status === "available" &&
          repository.connectionHealth === "connected",
      },
      preflight: {
        latestAttempt: latestAttempt
          ? {
              runId: latestAttempt.id,
              status: latestAttempt.status,
              result: latestAttempt.verified_impact,
              createdAt: latestAttempt.created_at,
              completedAt: latestAttempt.completed_at,
              repositorySetFingerprint: latestAttempt.repository_set_fingerprint,
              repositoryScope: "fingerprint_only_not_individually_resolved",
            }
          : null,
        lastVerifiedEvidence:
          lastVerifiedFinding && lastVerifiedRun
            ? {
                runId: lastVerifiedRun.id,
                verifiedAt: lastVerifiedRun.completed_at,
                findingId: lastVerifiedFinding.id,
                commitSha: lastVerifiedFinding.commit_sha,
                observedAt: lastVerifiedFinding.observed_at,
                currentness: "not_revalidated_against_live_repository_head",
                relativeToLatestAttempt:
                  latestAttempt && latestAttempt.id !== lastVerifiedRun.id
                    ? "historical_before_latest_attempt"
                    : "same_as_latest_attempt",
              }
            : null,
      },
    };
  });

  const sourcesTotal = sourceResult.count ?? boundedSources.length;
  const snapshotSources = new Set(
    observations.filter((item) => item.snapshot_id !== null).map((item) => item.source_id),
  );
  return {
    product: { id: product.id, name: product.name, state: product.status },
    identity: { state: "workspace_confirmed_dependencies_only" },
    coverage: {
      confirmedDependencies: dependencyResult.count ?? dependencies.length,
      authoritativeSourcesAvailable: sourcesTotal,
      sourcesByType: boundedSources.reduce<Record<string, number>>((counts, source) => {
        counts[source.source_type] = (counts[source.source_type] ?? 0) + 1;
        return counts;
      }, {}),
      sourcesWithObservedGlobalBaseline: snapshotSources.size,
      baselineObservation:
        sourcesTotal === 0
          ? "no_enabled_sources"
          : snapshotSources.size >= sourcesTotal
            ? "all_enabled_sources_have_snapshot"
            : snapshotSources.size > 0
              ? "some_sources_have_snapshot"
              : "no_global_baseline_observed",
      truncated: dependenciesTruncated || sourcesTruncated,
    },
    dependencies: dependencyNodes,
    repositories: repositoryGraph.mappedRepositories.map((repository) => ({
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
      status: repository.status,
      mappingState: repository.mappingStatus,
      mappingProvenance: repository.mappingProvenance,
      connectionHealth: repository.connectionHealth,
      verificationCapabilityAvailable: input.verificationCapabilityAvailable,
    })),
    dependencyRepositoryEdges,
    limits: {
      dependencies: MAX_DEPENDENCIES,
      sources: MAX_SOURCES,
      evidenceRows: MAX_EVIDENCE_ROWS,
      dependenciesTruncated,
      sourcesTruncated,
      repositoriesTruncated: repositoryGraph.accessibleRepositoriesTruncated,
    },
  };
}
