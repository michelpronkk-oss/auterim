import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { setConnectorHealth, type ConnectorInstallationRow } from "@/lib/connectors/service";
import { ConnectorError } from "@/lib/connectors/model";
import { decideDeploymentEvidence, type DeploymentObservation } from "./model";
import {
  getVercelConfiguration,
  getVercelProjectDeploymentSnapshot,
  type VercelProjectDeploymentSnapshot,
} from "./vercel";
import type { ProviderCredentials } from "@/lib/connectors/providers";

const MAX_MAPPINGS = 100;

function fail(message: string): never {
  throw new Error(message);
}

async function repositoryEvidence(
  service: SupabaseClient,
  workspaceId: string,
  productId: string,
  repositoryId: string,
  commitSha: string | null,
) {
  if (!commitSha) return null;
  const { data: dependencies, error: dependencyError } = await service
    .from("workspace_dependencies")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("protected_product_id", productId)
    .eq("monitoring_enabled", true)
    .limit(100);
  if (dependencyError) fail("deployment_evidence_unavailable");
  const dependencyIds = (dependencies ?? []).map((row) => row.id as string);
  if (!dependencyIds.length) return null;
  const { data: access, error: accessError } = await service
    .from("workspace_repository_access")
    .select("workspace_dependency_id")
    .eq("workspace_id", workspaceId)
    .eq("repository_id", repositoryId)
    .in("workspace_dependency_id", dependencyIds)
    .limit(100);
  if (accessError) fail("deployment_evidence_unavailable");
  const attributed = [
    ...new Set((access ?? []).map((row) => row.workspace_dependency_id as string)),
  ];
  if (!attributed.length) return null;
  const { data: impacts, error: impactError } = await service
    .from("impact_assessments")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("relevant", true)
    .in("workspace_dependency_id", attributed)
    .limit(200);
  if (impactError) fail("deployment_evidence_unavailable");
  const impactIds = [...new Set((impacts ?? []).map((row) => row.id as string))];
  if (!impactIds.length) return null;
  const { data: runs, error: runError } = await service
    .from("preflight_runs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("verified_impact", "verified")
    .in("status", ["completed", "partial"])
    .in("impact_assessment_id", impactIds)
    .order("created_at", { ascending: false })
    .limit(200);
  if (runError) fail("deployment_evidence_unavailable");
  const runIds = (runs ?? []).map((row) => row.id as string);
  if (!runIds.length) return null;
  const { data: findings, error: findingError } = await service
    .from("preflight_findings")
    .select("id,commit_sha,preflight_run_id")
    .eq("workspace_id", workspaceId)
    .eq("repository_id", repositoryId)
    .eq("verification", "verified")
    .eq("commit_sha", commitSha)
    .in("preflight_run_id", runIds)
    .order("observed_at", { ascending: false })
    .limit(1);
  if (findingError) fail("deployment_evidence_unavailable");
  const finding = findings?.[0];
  return finding ? { id: finding.id as string, commitSha: finding.commit_sha as string } : null;
}

async function upsertObservation(
  service: SupabaseClient,
  workspaceId: string,
  surfaceId: string,
  observation: DeploymentObservation,
) {
  const { data, error } = await service
    .from("deployment_observations")
    .upsert(
      {
        workspace_id: workspaceId,
        deployment_surface_id: surfaceId,
        external_deployment_id: observation.providerDeploymentId,
        environment_type: observation.environment,
        deployment_state: observation.state,
        commit_sha: observation.commitSha,
        source_repository_owner: observation.sourceRepository?.owner ?? null,
        source_repository_name: observation.sourceRepository?.name ?? null,
        source_branch: observation.branch,
        deployment_url: observation.url,
        provider_created_at: observation.createdAt,
        provider_ready_at: observation.readyAt,
        observed_at: observation.observedAt,
        provenance: "vercel_rest_api",
        verification_state: "observed",
        safe_metadata: {},
      },
      { onConflict: "deployment_surface_id,external_deployment_id" },
    )
    .select("id")
    .single();
  if (error || !data) fail("deployment_observation_persist_failed");
  return data.id as string;
}

async function persistProductEvidence(
  service: SupabaseClient,
  input: {
    workspaceId: string;
    productId: string;
    surfaceId: string;
    observationId: string;
    repositoryId: string;
    repositoryOwner: string;
    repositoryName: string;
    observation: DeploymentObservation;
    currentProductionDeploymentId: string | null;
  },
) {
  const proof = await repositoryEvidence(
    service,
    input.workspaceId,
    input.productId,
    input.repositoryId,
    input.observation.commitSha,
  );
  const decision = decideDeploymentEvidence({
    repositoryEvidence: proof
      ? {
          workspaceId: input.workspaceId,
          productId: input.productId,
          repositoryId: input.repositoryId,
          commitSha: proof.commitSha,
          verified: true,
        }
      : null,
    mappedWorkspaceId: input.workspaceId,
    mappedProductId: input.productId,
    mappedRepositoryId: input.repositoryId,
    mappedRepositoryIdentity: { owner: input.repositoryOwner, name: input.repositoryName },
    observation: {
      ...input.observation,
      isCurrentProduction:
        input.observation.providerDeploymentId === input.currentProductionDeploymentId,
    },
  });
  const state = proof ? decision.state : "mapped";
  const { error } = await service.from("product_deployment_evidence").upsert(
    {
      workspace_id: input.workspaceId,
      protected_product_id: input.productId,
      deployment_surface_id: input.surfaceId,
      deployment_observation_id: input.observationId,
      repository_id: input.repositoryId,
      preflight_finding_id: proof?.id ?? null,
      verification_state: state,
      verified_commit_sha: proof?.commitSha ?? null,
      observed_at: input.observation.observedAt,
      safe_metadata: { exactCommitMatch: decision.exactCommitMatch },
    },
    { onConflict: "protected_product_id,deployment_observation_id,repository_id" },
  );
  if (error) fail("deployment_evidence_persist_failed");
}

export async function syncSelectedVercelProject(input: {
  service: SupabaseClient;
  workspaceId: string;
  productId: string;
  installation: ConnectorInstallationRow;
  credentials: ProviderCredentials;
  externalProjectId: string;
}): Promise<{
  observed: number;
  mappedProducts: number;
  currentProductionDeploymentId: string | null;
}> {
  const teamId =
    typeof input.credentials.providerMetadata?.teamId === "string"
      ? input.credentials.providerMetadata.teamId
      : null;
  const { data: resource, error: resourceError } = await input.service
    .from("connector_resources")
    .select("display_name,safe_metadata,selected,access_state,resource_type")
    .eq("workspace_id", input.workspaceId)
    .eq("installation_id", input.installation.id)
    .eq("external_resource_id", input.externalProjectId)
    .maybeSingle();
  if (
    resourceError ||
    !resource ||
    resource.resource_type !== "project" ||
    !resource.selected ||
    resource.access_state !== "available"
  )
    fail("vercel_project_not_authorized");
  const { data: surface, error: surfaceError } = await input.service
    .from("deployment_surfaces")
    .upsert(
      {
        workspace_id: input.workspaceId,
        installation_id: input.installation.id,
        provider: "vercel",
        external_project_id: input.externalProjectId,
        project_name: resource.display_name,
        environment_scope: "all",
        safe_metadata: resource.safe_metadata,
      },
      { onConflict: "installation_id,external_project_id,environment_scope" },
    )
    .select("id")
    .single();
  if (surfaceError || !surface) fail("deployment_surface_persist_failed");
  const surfaceId = surface.id as string;
  const { data: syncAttempt, error: attemptError } = await input.service
    .from("deployment_sync_attempts")
    .insert({
      workspace_id: input.workspaceId,
      deployment_surface_id: surfaceId,
      status: "running",
    })
    .select("id,started_at")
    .single();
  if (attemptError || !syncAttempt) fail("deployment_sync_attempt_persist_failed");
  const startedAt = syncAttempt.started_at as string;
  await input.service
    .from("deployment_surfaces")
    .update({ last_attempt_at: startedAt, last_attempt_status: null, updated_at: startedAt })
    .eq("id", surfaceId)
    .eq("workspace_id", input.workspaceId)
    .or(`last_attempt_at.is.null,last_attempt_at.lt.${startedAt}`);

  let persistedObservationCount = 0;
  try {
    const configuration = await getVercelConfiguration(input.credentials);
    if (
      configuration.projectSelection === "selected" &&
      !configuration.projects.includes(input.externalProjectId)
    )
      throw new ConnectorError(
        "PERMISSION_MISSING",
        false,
        "vercel",
        "The selected Vercel project is no longer authorized.",
      );
    const snapshot: VercelProjectDeploymentSnapshot = await getVercelProjectDeploymentSnapshot(
      input.credentials,
      input.externalProjectId,
      teamId,
    );
    const { data: repositories, error: repositoriesError } = await input.service
      .from("repositories")
      .select("id,owner,name,status,selected_for_protection")
      .eq("workspace_id", input.workspaceId)
      .eq("status", "available")
      .eq("selected_for_protection", true)
      .limit(200);
    if (repositoriesError) fail("deployment_repository_mapping_unavailable");
    const repository = (repositories ?? []).find(
      (row) =>
        row.owner.toLowerCase() === snapshot.project.repository?.owner &&
        row.name.toLowerCase() === snapshot.project.repository?.name,
    );
    const mappings = repository
      ? await input.service
          .from("workspace_product_repositories")
          .select("protected_product_id")
          .eq("workspace_id", input.workspaceId)
          .eq("repository_id", repository.id)
          .eq("status", "active")
          .limit(MAX_MAPPINGS)
      : { data: [], error: null };
    if (mappings.error) fail("deployment_product_mapping_unavailable");
    const productIds = [
      ...new Set((mappings.data ?? []).map((row) => row.protected_product_id as string)),
    ];
    const { data: products, error: productsError } = productIds.length
      ? await input.service
          .from("workspace_products")
          .select("id,status")
          .eq("workspace_id", input.workspaceId)
          .eq("status", "protected")
          .in("id", productIds)
          .limit(MAX_MAPPINGS)
      : { data: [], error: null };
    if (productsError) fail("deployment_product_mapping_unavailable");
    const protectedProducts = (products ?? []).map((row) => row.id as string);
    const { error: projectUpdateError } = await input.service
      .from("deployment_surfaces")
      .update({
        project_name: snapshot.project.name,
        safe_metadata: snapshot.project.safeMetadata,
      })
      .eq("id", surfaceId)
      .eq("workspace_id", input.workspaceId);
    if (projectUpdateError) fail("deployment_surface_persist_failed");
    const mappedProductIds = repository ? protectedProducts : [];
    for (const mappedProductId of mappedProductIds) {
      const { error: mappingError } = await input.service
        .from("workspace_product_deployment_surfaces")
        .upsert(
          {
            workspace_id: input.workspaceId,
            protected_product_id: mappedProductId,
            deployment_surface_id: surfaceId,
            repository_id: repository!.id,
            provenance: "protected_repository_identity",
          },
          { onConflict: "protected_product_id,deployment_surface_id", ignoreDuplicates: true },
        );
      if (mappingError) fail("deployment_product_mapping_persist_failed");
    }

    // A newer alias target retires prior current Production claims without deleting history.
    if (snapshot.currentProductionDeploymentId) {
      const { data: oldCurrent, error: oldCurrentError } = await input.service
        .from("product_deployment_evidence")
        .select("deployment_observation_id")
        .eq("workspace_id", input.workspaceId)
        .eq("deployment_surface_id", surfaceId)
        .eq("verification_state", "production_verified")
        .limit(100);
      if (oldCurrentError) fail("deployment_history_unavailable");
      const oldIds = [
        ...new Set((oldCurrent ?? []).map((row) => row.deployment_observation_id as string)),
      ];
      if (oldIds.length) {
        const { error } = await input.service
          .from("product_deployment_evidence")
          .update({ verification_state: "historical" })
          .eq("workspace_id", input.workspaceId)
          .in("deployment_observation_id", oldIds)
          .eq("verification_state", "production_verified");
        if (error) fail("deployment_history_update_failed");
      }
    }

    for (const observation of snapshot.observations) {
      const observationId = await upsertObservation(
        input.service,
        input.workspaceId,
        surfaceId,
        observation,
      );
      persistedObservationCount += 1;
      if (repository) {
        for (const mappedProductId of mappedProductIds) {
          await persistProductEvidence(input.service, {
            workspaceId: input.workspaceId,
            productId: mappedProductId,
            surfaceId,
            observationId,
            repositoryId: repository.id as string,
            repositoryOwner: repository.owner as string,
            repositoryName: repository.name as string,
            observation,
            currentProductionDeploymentId: snapshot.currentProductionDeploymentId,
          });
        }
      }
    }
    const { data: currentAttemptSurface, error: surfaceUpdateError } = await input.service
      .from("deployment_surfaces")
      .update({
        current_production_deployment_id: snapshot.currentProductionDeploymentId,
        last_successful_sync_at: startedAt,
        last_attempt_at: startedAt,
        last_attempt_status: "succeeded",
        updated_at: new Date().toISOString(),
      })
      .eq("id", surfaceId)
      .eq("workspace_id", input.workspaceId)
      .eq("last_attempt_at", startedAt)
      .select("id")
      .maybeSingle();
    if (surfaceUpdateError) fail("deployment_surface_persist_failed");
    const completedAt = new Date().toISOString();
    const { error: finishError } = await input.service
      .from("deployment_sync_attempts")
      .update({
        status: "succeeded",
        completed_at: completedAt,
        observed_count: snapshot.observations.length,
      })
      .eq("id", syncAttempt.id)
      .eq("workspace_id", input.workspaceId);
    if (finishError) fail("deployment_sync_attempt_persist_failed");
    return {
      observed: snapshot.observations.length,
      mappedProducts: mappedProductIds.length,
      currentProductionDeploymentId: currentAttemptSurface
        ? snapshot.currentProductionDeploymentId
        : null,
    };
  } catch (error) {
    const category = error instanceof ConnectorError ? error.category : "UNKNOWN_SAFE";
    const safeCategory =
      category === "AUTH_REQUIRED"
        ? "auth_required"
        : category === "PERMISSION_MISSING"
          ? "permission_missing"
          : category === "RESOURCE_NOT_FOUND"
            ? "resource_missing"
            : category === "RATE_LIMITED"
              ? "rate_limited"
              : category === "PROVIDER_UNAVAILABLE" || category === "TRANSIENT"
                ? "provider_unavailable"
                : "unknown_safe";
    await input.service
      .from("deployment_sync_attempts")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        observed_count: persistedObservationCount,
        error_category: safeCategory,
      })
      .eq("id", syncAttempt.id)
      .eq("workspace_id", input.workspaceId);
    await input.service
      .from("deployment_surfaces")
      .update({ last_attempt_status: "failed", updated_at: new Date().toISOString() })
      .eq("id", surfaceId)
      .eq("workspace_id", input.workspaceId)
      .eq("last_attempt_at", startedAt);
    if (error instanceof ConnectorError) {
      const health =
        error.category === "AUTH_REQUIRED"
          ? {
              lifecycle: "reauth_required" as const,
              health: "reauth_required" as const,
              event: "reauth_required",
            }
          : error.category === "PERMISSION_MISSING"
            ? {
                lifecycle: "degraded" as const,
                health: "permission_missing" as const,
                event: "permission_lost",
              }
            : error.category === "RESOURCE_NOT_FOUND"
              ? {
                  lifecycle: "degraded" as const,
                  health: "resource_missing" as const,
                  event: undefined,
                }
              : {
                  lifecycle: "degraded" as const,
                  health: "provider_unavailable" as const,
                  event: undefined,
                };
      await setConnectorHealth(
        input.service,
        input.installation,
        health.lifecycle,
        health.health,
        health.event,
      ).catch(() => undefined);
    }
    throw error;
  }
}
