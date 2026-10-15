import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ProductProtectionReadError } from "@/lib/protection/read-stage";

type RepositoryIdentity = {
  id: string;
  owner: string;
  name: string;
  status: string;
  selectedForProtection: boolean;
  mappingStatus: string;
  mappingProvenance: string | null;
};

type ProductRepositoryContext = {
  productStatus: string;
  repositories: RepositoryIdentity[];
};

type DeploymentSurfaceRow = {
  id: string;
  installation_id: string;
  provider: string;
  external_project_id: string;
  project_name: string;
  environment_scope: string;
  current_production_deployment_id: string | null;
  last_successful_sync_at: string | null;
  last_attempt_at: string | null;
  last_attempt_status: string | null;
};

type InstallationRow = { id: string; lifecycle_state: string; health_state: string };
type DeploymentObservationRow = {
  id: string;
  deployment_surface_id: string;
  external_deployment_id: string;
  environment_type: string;
  deployment_state: string;
  commit_sha: string | null;
  source_repository_owner: string | null;
  source_repository_name: string | null;
  source_branch: string | null;
  deployment_url: string | null;
  provider_created_at: string | null;
  provider_ready_at: string | null;
  observed_at: string;
  provenance: string;
};
type DeploymentEvidenceRow = {
  deployment_observation_id: string;
  repository_id: string;
  preflight_finding_id: string | null;
  baseline_preflight_evidence_id: string | null;
  verification_state: string;
  verified_commit_sha: string | null;
  observed_at: string;
  safe_metadata: Record<string, unknown> | null;
};
type BaselineEvidenceRow = {
  id: string;
  preflight_run_id: string;
  protected_product_id: string;
  repository_id: string;
  commit_sha: string;
  verification_state: string;
};
type PreflightFindingRow = {
  id: string;
  preflight_run_id: string;
  repository_id: string;
  commit_sha: string;
  verification: string;
};
type PreflightRunProofRow = {
  id: string;
  protected_product_id: string;
  preflight_mode: string;
  status: string;
};

const MAX_SURFACES = 100;
const MAX_OBSERVATIONS = 200;
const MAX_SURFACE_OBSERVATIONS = 20;

function normalize(value: string | null | undefined) {
  return value?.toLowerCase() ?? "";
}

function isCurrentProductionEvidence(input: {
  productId: string;
  pointerMatches: boolean;
  syncSucceeded: boolean;
  connectorHealthy: boolean;
  productProtected: boolean;
  verificationCapabilityAvailable: boolean;
  repositoryMapped: boolean;
  repositoryAvailable: boolean;
  repositorySelected: boolean;
  observation: DeploymentObservationRow;
  evidence: DeploymentEvidenceRow | undefined;
  baseline: BaselineEvidenceRow | undefined;
  baselineRun: PreflightRunProofRow | undefined;
  finding: PreflightFindingRow | undefined;
  findingRun: PreflightRunProofRow | undefined;
  repository: RepositoryIdentity | undefined;
}) {
  const {
    productId,
    observation,
    evidence,
    baseline,
    baselineRun,
    finding,
    findingRun,
    repository,
  } = input;
  const baselineProofCurrent = Boolean(
    evidence?.baseline_preflight_evidence_id &&
    baseline?.id === evidence.baseline_preflight_evidence_id &&
    baseline.protected_product_id &&
    baseline.repository_id === repository?.id &&
    baseline.verification_state === "verified" &&
    baselineRun?.id === baseline.preflight_run_id &&
    baselineRun.protected_product_id === productId &&
    baselineRun.preflight_mode === "baseline" &&
    baselineRun.status === "completed",
  );
  const findingProofCurrent = Boolean(
    evidence?.preflight_finding_id &&
    finding?.id === evidence.preflight_finding_id &&
    finding.repository_id === repository?.id &&
    finding.verification === "verified" &&
    findingRun?.id === finding.preflight_run_id &&
    findingRun.protected_product_id === productId &&
    findingRun.status === "completed",
  );
  const proofCurrent = baselineProofCurrent || findingProofCurrent;
  const proofShaMatches = baselineProofCurrent
    ? normalize(observation.commit_sha) === normalize(baseline?.commit_sha)
    : findingProofCurrent && normalize(observation.commit_sha) === normalize(finding?.commit_sha);
  const exactSha =
    Boolean(observation.commit_sha) &&
    normalize(observation.commit_sha) === normalize(evidence?.verified_commit_sha) &&
    proofShaMatches;
  const exactRepository =
    normalize(observation.source_repository_owner) === normalize(repository?.owner) &&
    normalize(observation.source_repository_name) === normalize(repository?.name);

  return Boolean(
    input.pointerMatches &&
    input.syncSucceeded &&
    input.connectorHealthy &&
    input.productProtected &&
    input.verificationCapabilityAvailable &&
    input.repositoryMapped &&
    input.repositoryAvailable &&
    input.repositorySelected &&
    observation.environment_type === "production" &&
    observation.deployment_state === "ready" &&
    observation.provenance === "vercel_rest_api" &&
    evidence?.verification_state === "production_verified" &&
    evidence.safe_metadata?.exactCommitMatch === true &&
    proofCurrent &&
    evidence.repository_id === repository?.id &&
    exactSha &&
    exactRepository,
  );
}

/**
 * Loads the provider-neutral deployment portion of the Product Protection Graph.
 * Product and repository identity can be supplied by the full graph, or loaded
 * narrowly for callers such as M15.7 that do not need unrelated graph domains.
 */
export async function loadProductDeploymentProtectionGraph(
  client: SupabaseClient,
  input: {
    workspaceId: string;
    productId: string;
    verificationCapabilityAvailable: boolean;
    repositoryContext?: ProductRepositoryContext;
  },
) {
  const { workspaceId, productId } = input;
  let repositoryContext = input.repositoryContext;
  if (!repositoryContext) {
    const { data: product, error: productError } = await client
      .from("workspace_products")
      .select("id,status")
      .eq("workspace_id", workspaceId)
      .eq("id", productId)
      .maybeSingle();
    if (productError) throw new ProductProtectionReadError("product");
    if (!product) return null;

    const { data: mappings, error: mappingError } = await client
      .from("workspace_product_repositories")
      .select("repository_id,status,provenance")
      .eq("workspace_id", workspaceId)
      .eq("protected_product_id", productId)
      .eq("status", "active")
      .limit(MAX_SURFACES);
    if (mappingError) throw new ProductProtectionReadError("repository_mappings");
    const mappingRows = mappings ?? [];
    const repositoryIds = [...new Set(mappingRows.map((row) => row.repository_id as string))];
    const { data: repositories, error: repositoryError } = repositoryIds.length
      ? await client
          .from("repositories")
          .select("id,owner,name,status,selected_for_protection")
          .eq("workspace_id", workspaceId)
          .in("id", repositoryIds)
          .limit(MAX_SURFACES)
      : { data: [], error: null };
    if (repositoryError) throw new ProductProtectionReadError("repository_access");
    const mappingByRepository = new Map(mappingRows.map((row) => [row.repository_id, row]));
    repositoryContext = {
      productStatus: product.status,
      repositories: (repositories ?? []).map((repository) => {
        const mapping = mappingByRepository.get(repository.id);
        return {
          id: repository.id,
          owner: repository.owner,
          name: repository.name,
          status: repository.status,
          selectedForProtection: repository.selected_for_protection === true,
          mappingStatus: mapping?.status ?? "unmapped",
          mappingProvenance: mapping?.provenance ?? null,
        };
      }),
    };
  }

  const { data: deploymentMappings, error: deploymentMappingError } = await client
    .from("workspace_product_deployment_surfaces")
    .select("id,deployment_surface_id,repository_id,provenance,created_at")
    .eq("workspace_id", workspaceId)
    .eq("protected_product_id", productId)
    .order("created_at", { ascending: true })
    .limit(MAX_SURFACES);
  if (deploymentMappingError) throw new ProductProtectionReadError("deployment_surfaces");
  const surfaceIds = [
    ...new Set((deploymentMappings ?? []).map((row) => row.deployment_surface_id)),
  ];
  const { data: surfaces, error: surfaceError } = surfaceIds.length
    ? await client
        .from("deployment_surfaces")
        .select(
          "id,installation_id,provider,external_project_id,project_name,environment_scope,current_production_deployment_id,last_successful_sync_at,last_attempt_at,last_attempt_status",
        )
        .eq("workspace_id", workspaceId)
        .in("id", surfaceIds)
        .limit(MAX_SURFACES)
    : { data: [], error: null };
  if (surfaceError) throw new ProductProtectionReadError("deployment_surfaces");
  const surfaceRows = (surfaces ?? []) as DeploymentSurfaceRow[];
  const installationIds = [...new Set(surfaceRows.map((surface) => surface.installation_id))];
  const { data: installations, error: installationError } = installationIds.length
    ? await client
        .from("connector_installations")
        .select("id,lifecycle_state,health_state")
        .eq("workspace_id", workspaceId)
        .in("id", installationIds)
        .limit(MAX_SURFACES)
    : { data: [], error: null };
  if (installationError) throw new ProductProtectionReadError("deployment_surfaces");

  const { data: observations, error: observationError } = surfaceIds.length
    ? await client
        .from("deployment_observations")
        .select(
          "id,deployment_surface_id,external_deployment_id,environment_type,deployment_state,commit_sha,source_repository_owner,source_repository_name,source_branch,deployment_url,provider_created_at,provider_ready_at,observed_at,provenance",
        )
        .eq("workspace_id", workspaceId)
        .in("deployment_surface_id", surfaceIds)
        .order("observed_at", { ascending: false })
        .limit(MAX_OBSERVATIONS)
    : { data: [], error: null };
  if (observationError) throw new ProductProtectionReadError("deployment_observations");
  const observationRows = (observations ?? []) as DeploymentObservationRow[];
  const observationIds = observationRows.map((row) => row.id);
  const { data: evidence, error: evidenceError } = observationIds.length
    ? await client
        .from("product_deployment_evidence")
        .select(
          "deployment_observation_id,repository_id,preflight_finding_id,baseline_preflight_evidence_id,verification_state,verified_commit_sha,observed_at,safe_metadata",
        )
        .eq("workspace_id", workspaceId)
        .eq("protected_product_id", productId)
        .in("deployment_observation_id", observationIds)
        .limit(MAX_OBSERVATIONS)
    : { data: [], error: null };
  if (evidenceError) throw new ProductProtectionReadError("deployment_evidence");
  const evidenceRows = (evidence ?? []) as DeploymentEvidenceRow[];
  const baselineIds = [
    ...new Set(
      evidenceRows.flatMap((row) =>
        row.baseline_preflight_evidence_id ? [row.baseline_preflight_evidence_id] : [],
      ),
    ),
  ];
  const findingIds = [
    ...new Set(
      evidenceRows.flatMap((row) => (row.preflight_finding_id ? [row.preflight_finding_id] : [])),
    ),
  ];
  const { data: baselines, error: baselineError } = baselineIds.length
    ? await client
        .from("baseline_preflight_evidence")
        .select(
          "id,preflight_run_id,protected_product_id,repository_id,commit_sha,verification_state",
        )
        .eq("workspace_id", workspaceId)
        .eq("protected_product_id", productId)
        .in("id", baselineIds)
        .limit(MAX_OBSERVATIONS)
    : { data: [], error: null };
  if (baselineError) throw new ProductProtectionReadError("baseline_evidence");
  const { data: findings, error: findingError } = findingIds.length
    ? await client
        .from("preflight_findings")
        .select("id,preflight_run_id,repository_id,commit_sha,verification")
        .eq("workspace_id", workspaceId)
        .in("id", findingIds)
        .limit(MAX_OBSERVATIONS)
    : { data: [], error: null };
  if (findingError) throw new ProductProtectionReadError("preflight_findings");
  const proofRunIds = [
    ...new Set([
      ...((baselines ?? []) as BaselineEvidenceRow[]).map((row) => row.preflight_run_id),
      ...((findings ?? []) as PreflightFindingRow[]).map((row) => row.preflight_run_id),
    ]),
  ];
  const { data: proofRuns, error: proofRunError } = proofRunIds.length
    ? await client
        .from("preflight_runs")
        .select("id,protected_product_id,preflight_mode,status")
        .eq("workspace_id", workspaceId)
        .eq("protected_product_id", productId)
        .in("id", proofRunIds)
        .limit(MAX_OBSERVATIONS)
    : { data: [], error: null };
  if (proofRunError) throw new ProductProtectionReadError("preflight_runs");

  const repositoryById = new Map(repositoryContext.repositories.map((row) => [row.id, row]));
  const installationById = new Map(
    ((installations ?? []) as InstallationRow[]).map((row) => [row.id, row]),
  );
  const evidenceByObservation = new Map(
    evidenceRows.map((row) => [row.deployment_observation_id, row]),
  );
  const baselineById = new Map(
    ((baselines ?? []) as BaselineEvidenceRow[]).map((row) => [row.id, row]),
  );
  const findingById = new Map(
    ((findings ?? []) as PreflightFindingRow[]).map((row) => [row.id, row]),
  );
  const proofRunById = new Map(
    ((proofRuns ?? []) as PreflightRunProofRow[]).map((row) => [row.id, row]),
  );
  const deploymentSurfaces = (deploymentMappings ?? []).flatMap((mapping) => {
    const surface = surfaceRows.find((candidate) => candidate.id === mapping.deployment_surface_id);
    if (!surface) return [];
    const repository = repositoryById.get(mapping.repository_id);
    const installation = installationById.get(surface.installation_id);
    const connectorHealthy =
      installation?.lifecycle_state === "connected" && installation.health_state === "healthy";
    const repositoryMapped =
      repository?.mappingStatus === "active" || repository?.mappingStatus === "legacy";
    const repositoryAvailable = repository?.status === "available";
    const repositorySelected = repository?.selectedForProtection === true;
    const protectionMappingCurrent = Boolean(
      input.verificationCapabilityAvailable &&
      repositoryContext.productStatus === "protected" &&
      repositoryMapped &&
      repositoryAvailable,
    );
    const surfaceObservations = observationRows
      .filter((row) => row.deployment_surface_id === surface.id)
      .slice(0, MAX_SURFACE_OBSERVATIONS)
      .map((row) => {
        const rowEvidence = evidenceByObservation.get(row.id);
        const baseline = rowEvidence?.baseline_preflight_evidence_id
          ? baselineById.get(rowEvidence.baseline_preflight_evidence_id)
          : undefined;
        const baselineRun = baseline ? proofRunById.get(baseline.preflight_run_id) : undefined;
        const finding = rowEvidence?.preflight_finding_id
          ? findingById.get(rowEvidence.preflight_finding_id)
          : undefined;
        const findingRun = finding ? proofRunById.get(finding.preflight_run_id) : undefined;
        const pointerMatches =
          surface.current_production_deployment_id === row.external_deployment_id;
        const currentProduction = isCurrentProductionEvidence({
          productId,
          pointerMatches,
          syncSucceeded: surface.last_attempt_status === "succeeded",
          connectorHealthy,
          productProtected: repositoryContext.productStatus === "protected",
          verificationCapabilityAvailable: input.verificationCapabilityAvailable,
          repositoryMapped,
          repositoryAvailable,
          repositorySelected,
          observation: row,
          evidence: rowEvidence,
          baseline,
          baselineRun,
          finding,
          findingRun,
          repository,
        });
        const syncFreshness =
          surface.last_attempt_status === "succeeded"
            ? "latest_sync_succeeded"
            : surface.last_attempt_status === "failed"
              ? "latest_sync_failed"
              : "sync_not_yet_succeeded";
        return {
          id: row.id,
          providerDeploymentId: row.external_deployment_id,
          environment: row.environment_type,
          state: row.deployment_state,
          commitSha: row.commit_sha,
          sourceRepository:
            row.source_repository_owner && row.source_repository_name
              ? { owner: row.source_repository_owner, name: row.source_repository_name }
              : null,
          branch: row.source_branch,
          url: row.deployment_url,
          createdAt: row.provider_created_at,
          readyAt: row.provider_ready_at,
          observedAt: row.observed_at,
          provenance: row.provenance,
          verification: rowEvidence
            ? {
                state: rowEvidence.verification_state,
                verifiedCommitSha: rowEvidence.verified_commit_sha,
                preflightFindingId: rowEvidence.preflight_finding_id,
                baselinePreflightEvidenceId: rowEvidence.baseline_preflight_evidence_id,
                exactCommitMatch: rowEvidence.safe_metadata?.exactCommitMatch === true,
              }
            : {
                state: "observed",
                verifiedCommitSha: null,
                preflightFindingId: null,
                baselinePreflightEvidenceId: null,
                exactCommitMatch: false,
              },
          currentProduction,
          currentness: !protectionMappingCurrent
            ? "product_repository_mapping_inactive"
            : !connectorHealthy
              ? "connector_not_healthy"
              : !pointerMatches
                ? rowEvidence?.verification_state === "historical"
                  ? "historical"
                  : "not_current_production"
                : syncFreshness,
        };
      });
    return [
      {
        // `id` is the Product mapping identity. Consumers that address the provider surface use this separate ID.
        id: mapping.id,
        deploymentSurfaceId: surface.id,
        provider: surface.provider,
        projectId: surface.external_project_id,
        projectName: surface.project_name,
        environmentScope: surface.environment_scope,
        repository: repository
          ? { id: repository.id, owner: repository.owner, name: repository.name }
          : null,
        mappingProvenance: mapping.provenance,
        mappedAt: mapping.created_at,
        lastSuccessfulSyncAt: surface.last_successful_sync_at,
        lastAttemptAt: surface.last_attempt_at,
        lastAttemptStatus: surface.last_attempt_status,
        currentProductionDeploymentId: surface.current_production_deployment_id,
        observations: surfaceObservations,
      },
    ];
  });

  return {
    semantics: "provider_observed; product_mapping_requires_existing_protected_repository_identity",
    surfaces: deploymentSurfaces,
  };
}
