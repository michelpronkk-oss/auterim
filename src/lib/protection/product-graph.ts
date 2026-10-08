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
const MAX_LOCAL_OBSERVATIONS = 500;

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
type CliScanRow = {
  id: string;
  scan_id: string;
  status: string;
  received_at: string;
  observation_count: number;
  project_name: string;
  project_identity: Record<string, unknown>;
};
type CliObservationRow = {
  id: string;
  scan_run_id: string;
  observation_id: string;
  evidence_family: string;
  normalized_identifier: string;
  reason_code: string;
  confidence: number;
  provider_state: string;
  safe_relative_path: string | null;
  subproject: string | null;
  safe_metadata: Record<string, unknown>;
  provider_id: string | null;
  workspace_dependency_id: string | null;
  dependency_catalog: { name: string; slug: string } | Array<{ name: string; slug: string }> | null;
};

export function cliScanComparisonState(input: {
  latest: { status: string; observationCount: number } | null;
  latestRows: number;
  previous: { status: string; observationCount: number } | null;
  previousRows: number;
}) {
  if (!input.previous) return "no_previous_scan" as const;
  if (
    !input.latest ||
    input.latest.status !== "complete" ||
    input.previous.status !== "complete" ||
    input.latest.observationCount > input.latestRows ||
    input.previous.observationCount > input.previousRows
  )
    return "incomplete" as const;
  return "complete" as const;
}

export function cliObservationChange(input: {
  comparisonState: "no_previous_scan" | "complete" | "incomplete";
  previousExists: boolean;
  changed: boolean;
}) {
  if (input.comparisonState === "incomplete") return "comparison_incomplete" as const;
  if (input.comparisonState === "no_previous_scan") return "first_observed" as const;
  if (!input.previousExists) return "added" as const;
  return input.changed ? ("changed" as const) : ("unchanged" as const);
}

export function cliCatalogCoverage(input: {
  providerId: string | null;
  sourceCounts: ReadonlyMap<string, number>;
  truncated: boolean;
}) {
  if (!input.providerId)
    return { authoritativeSourcesAvailable: null, state: "unknown_provider" as const };
  const count = input.sourceCounts.get(input.providerId);
  if (count === undefined && input.truncated)
    return { authoritativeSourcesAvailable: null, state: "not_evaluated_due_to_bound" as const };
  const available = count ?? 0;
  return {
    authoritativeSourcesAvailable: available,
    state: available > 0 ? ("catalog_sources_available" as const) : ("no_catalog_sources" as const),
  };
}

export function cliMonitoringState(input: {
  dependencyId: string | null;
  monitoringEnabled: boolean | undefined;
  dependenciesTruncated: boolean;
  enabledSources: number | null;
}) {
  if (!input.dependencyId) return "not_a_confirmed_dependency" as const;
  if (input.monitoringEnabled === undefined)
    return input.dependenciesTruncated
      ? ("not_evaluated_due_to_dependency_bound" as const)
      : ("confirmed_dependency_unavailable" as const);
  if (!input.monitoringEnabled) return "monitoring_disabled" as const;
  if (input.enabledSources === null) return "coverage_not_evaluated" as const;
  return input.enabledSources > 0
    ? ("monitoring_enabled_sources_available" as const)
    : ("no_enabled_authoritative_sources" as const);
}

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

  const [dependencyResult, repositoryGraph, cliRunResult] = await Promise.all([
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
    client
      .from("cli_scan_runs")
      .select("id,scan_id,status,received_at,observation_count,project_name,project_identity")
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId)
      .order("received_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(2),
  ]);
  if (dependencyResult.error || cliRunResult.error)
    throw new Error("product_protection_graph_unavailable");
  if (!repositoryGraph) return null;

  const rawDependencies = (dependencyResult.data ?? []) as DependencyRow[];
  const dependenciesTruncated = rawDependencies.length > MAX_DEPENDENCIES;
  const dependencies = rawDependencies.slice(0, MAX_DEPENDENCIES);
  const dependencyIds = dependencies.map((dependency) => dependency.id);
  const cliRuns = (cliRunResult.data ?? []) as CliScanRow[];
  const latestCliRun = cliRuns[0] ?? null;
  const previousCliRun = cliRuns[1] ?? null;
  const readCliObservations = (runId: string | null) =>
    runId
      ? client
          .from("cli_observations")
          .select(
            "id,scan_run_id,observation_id,evidence_family,normalized_identifier,reason_code,confidence,provider_state,safe_relative_path,subproject,safe_metadata,provider_id,workspace_dependency_id,dependency_catalog(name,slug)",
          )
          .eq("workspace_id", workspaceId)
          .eq("product_id", productId)
          .eq("scan_run_id", runId)
          .order("evidence_family")
          .order("normalized_identifier")
          .limit(MAX_LOCAL_OBSERVATIONS)
      : Promise.resolve({ data: [], error: null });
  const [latestCliObservationResult, previousCliObservationResult] = await Promise.all([
    readCliObservations(latestCliRun?.id ?? null),
    readCliObservations(previousCliRun?.id ?? null),
  ]);
  if (latestCliObservationResult.error || previousCliObservationResult.error)
    throw new Error("product_protection_graph_unavailable");
  const cliObservations = (latestCliObservationResult.data ?? []) as CliObservationRow[];
  const previousCliObservations = (previousCliObservationResult.data ?? []) as CliObservationRow[];
  const latestCliObservationsTruncated =
    (latestCliRun?.observation_count ?? 0) > cliObservations.length;
  const previousCliObservationsTruncated =
    (previousCliRun?.observation_count ?? 0) > previousCliObservations.length;
  const cliComparisonState = cliScanComparisonState({
    latest: latestCliRun
      ? { status: latestCliRun.status, observationCount: latestCliRun.observation_count }
      : null,
    latestRows: cliObservations.length,
    previous: previousCliRun
      ? { status: previousCliRun.status, observationCount: previousCliRun.observation_count }
      : null,
    previousRows: previousCliObservations.length,
  });
  const allCliObservations = [...cliObservations, ...previousCliObservations];
  const cliProviderIds = [
    ...new Set(allCliObservations.flatMap((row) => (row.provider_id ? [row.provider_id] : []))),
  ];
  const boundedCliProviderIds = cliProviderIds.slice(0, 500).sort();
  const cliCoverageResult = boundedCliProviderIds.length
    ? await client.rpc("get_cli_product_provider_coverage", {
        p_workspace_id: workspaceId,
        p_product_id: productId,
        p_provider_ids: boundedCliProviderIds,
      })
    : { data: [], error: null };
  if (cliCoverageResult.error) throw new Error("product_protection_graph_unavailable");
  const cliCoverageRows = (cliCoverageResult.data ?? []) as {
    provider_id: string;
    enabled_source_count: number | string;
  }[];
  const cliSourcesByProvider = new Map<string, number>(
    cliCoverageRows.map((row) => [row.provider_id, Number(row.enabled_source_count)]),
  );
  const cliCoverageTruncated = cliProviderIds.length > boundedCliProviderIds.length;
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
    localDiscovery: {
      semantics: "detected_locally_unconfirmed",
      latestScan: latestCliRun
        ? {
            scanId: latestCliRun.scan_id,
            status: latestCliRun.status,
            receivedAt: latestCliRun.received_at,
            projectName: latestCliRun.project_name,
            observationCount: latestCliRun.observation_count,
            projectIdentity: latestCliRun.project_identity,
          }
        : null,
      previousScan: cliRuns[1]
        ? {
            scanId: cliRuns[1].scan_id,
            status: cliRuns[1].status,
            receivedAt: cliRuns[1].received_at,
          }
        : null,
      observations: cliObservations.map((row) => {
        const catalog = Array.isArray(row.dependency_catalog)
          ? row.dependency_catalog[0]
          : row.dependency_catalog;
        const previous = previousCliObservations.find(
          (candidate) => candidate.observation_id === row.observation_id,
        );
        const changed =
          previous &&
          JSON.stringify({
            reason: previous.reason_code,
            confidence: previous.confidence,
            providerId: previous.provider_id,
            path: previous.safe_relative_path,
            subproject: previous.subproject,
            metadata: previous.safe_metadata,
          }) !==
            JSON.stringify({
              reason: row.reason_code,
              confidence: row.confidence,
              providerId: row.provider_id,
              path: row.safe_relative_path,
              subproject: row.subproject,
              metadata: row.safe_metadata,
            });
        return {
          id: row.observation_id,
          evidenceFamily: row.evidence_family,
          identifier: row.normalized_identifier,
          reason: row.reason_code,
          confidence: Number(row.confidence),
          identity: "observed_unconfirmed",
          changeSincePrevious: cliObservationChange({
            comparisonState: cliComparisonState,
            previousExists: Boolean(previous),
            changed: Boolean(changed),
          }),
          provider: catalog
            ? { id: row.provider_id, name: catalog.name, slug: catalog.slug }
            : null,
          confirmedDependencyId: row.workspace_dependency_id,
          productMonitoringState: cliMonitoringState({
            dependencyId: row.workspace_dependency_id,
            monitoringEnabled: dependencies.find(
              (dependency) => dependency.id === row.workspace_dependency_id,
            )?.monitoring_enabled,
            dependenciesTruncated,
            enabledSources: row.provider_id
              ? (cliSourcesByProvider.get(row.provider_id) ?? (cliCoverageTruncated ? null : 0))
              : null,
          }),
          ...(() => {
            const coverage = cliCatalogCoverage({
              providerId: row.provider_id,
              sourceCounts: cliSourcesByProvider,
              truncated: cliCoverageTruncated,
            });
            return {
              authoritativeSourcesAvailable: coverage.authoritativeSourcesAvailable,
              catalogCoverageState: coverage.state,
            };
          })(),
          safeRelativePath: row.safe_relative_path,
          subproject: row.subproject,
          metadata: row.safe_metadata,
        };
      }),
      comparisonState: cliComparisonState,
      previouslyObservedNotLatest: (cliComparisonState === "complete"
        ? previousCliObservations
        : []
      )
        .filter(
          (previous) =>
            !cliObservations.some((current) => current.observation_id === previous.observation_id),
        )
        .map((row) => ({
          id: row.observation_id,
          evidenceFamily: row.evidence_family,
          identifier: row.normalized_identifier,
          state: "not_observed_in_latest",
          lastObservedAt: previousCliRun?.received_at ?? null,
        })),
      truncated: latestCliObservationsTruncated,
      historyTruncated: previousCliObservationsTruncated,
      providerCoverageTruncated: cliCoverageTruncated,
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
