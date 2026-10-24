import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { loadInstallation, getFreshProviderCredentials } from "@/lib/connectors/service";
import {
  getVercelConfiguration,
  getVercelProjectDeploymentSnapshot,
} from "@/lib/deployments/vercel";
import type {
  ProductionAnalysisRequest,
  ProductionBinding,
  ProductionGraph,
} from "./production-analysis";

const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{40,64}$/i);
const seedSchema = z.object({
  id: uuid,
  workspace_id: uuid,
  product_id: uuid,
  repository_id: uuid,
  route_intent_id: uuid,
});
const surfaceSchema = z.object({
  id: uuid,
  installation_id: uuid,
  external_project_id: z.string().min(1).max(200),
  current_production_deployment_id: z.string().nullable(),
  last_attempt_status: z.string().nullable(),
});
const repositorySchema = z.object({
  id: uuid,
  owner: z.string(),
  name: z.string(),
  connection_id: uuid,
});
const observationSchema = z.object({
  id: uuid,
  commit_sha: sha,
  environment_type: z.literal("production"),
  deployment_state: z.literal("ready"),
});
const evidenceSchema = z.object({
  id: uuid,
  verified_commit_sha: sha,
  verification_state: z.literal("production_verified"),
});
const syncSchema = z.object({
  id: uuid,
  status: z.literal("succeeded"),
  completed_at: z.string().datetime({ offset: true }),
});
const graphSchema = seedSchema.extend({
  commit_sha: sha,
  status: z.enum(["queued", "building", "completed", "failed"]),
  assessment_state: z.enum([
    "evidence_present",
    "absence_observed",
    "unknown_incomplete",
    "failed",
  ]),
  analysis_profile: z.string(),
  coverage_state: z.enum(["complete", "partial", "unsupported", "failed"]),
});

/** All queries are exact scoped lookups; no unbounded histories, arbitrary graph/tenant joins or writes. */
export async function readProductionBinding(
  client: SupabaseClient,
  request: ProductionAnalysisRequest,
  now = new Date(),
): Promise<ProductionBinding | null> {
  const workspace = request.workspaceId;
  const results = await Promise.all([
    client
      .from("workspace_products")
      .select("id")
      .eq("id", request.productId)
      .eq("workspace_id", workspace)
      .eq("status", "protected")
      .abortSignal(AbortSignal.timeout(15_000))
      .maybeSingle(),
    client
      .from("workspace_product_repositories")
      .select("id")
      .eq("workspace_id", workspace)
      .eq("protected_product_id", request.productId)
      .eq("repository_id", request.repositoryId)
      .eq("status", "active")
      .abortSignal(AbortSignal.timeout(15_000))
      .maybeSingle(),
    client
      .from("workspace_product_deployment_surfaces")
      .select("deployment_surface_id")
      .eq("workspace_id", workspace)
      .eq("protected_product_id", request.productId)
      .eq("repository_id", request.repositoryId)
      .eq("deployment_surface_id", request.surfaceId)
      .abortSignal(AbortSignal.timeout(15_000))
      .maybeSingle(),
    client
      .from("repositories")
      .select("id,owner,name,connection_id")
      .eq("workspace_id", workspace)
      .eq("id", request.repositoryId)
      .eq("status", "available")
      .eq("archived", false)
      .abortSignal(AbortSignal.timeout(15_000))
      .maybeSingle(),
    client
      .from("deployment_surfaces")
      .select(
        "id,installation_id,external_project_id,current_production_deployment_id,last_attempt_status",
      )
      .eq("workspace_id", workspace)
      .eq("id", request.surfaceId)
      .eq("provider", "vercel")
      .abortSignal(AbortSignal.timeout(15_000))
      .maybeSingle(),
    client
      .from("impact_graph_builds")
      .select("id,workspace_id,product_id,repository_id,route_intent_id")
      .eq("id", request.seedGraphBuildId)
      .eq("workspace_id", workspace)
      .eq("product_id", request.productId)
      .eq("repository_id", request.repositoryId)
      .abortSignal(AbortSignal.timeout(15_000))
      .maybeSingle(),
  ]);
  if (results.some((r) => r.error)) throw new Error("production_analysis_scope_read_failed");
  if (results.some((r) => !r.data)) return null;
  const repository = repositorySchema.parse(results[3].data);
  const surface = surfaceSchema.parse(results[4].data);
  const seed = seedSchema.parse(results[5].data);
  if (!surface.current_production_deployment_id || surface.last_attempt_status !== "succeeded")
    return null;
  const authorized = await Promise.all([
    client
      .from("repository_connections")
      .select("id")
      .eq("workspace_id", workspace)
      .eq("id", repository.connection_id)
      .eq("provider", "github")
      .eq("status", "connected")
      .abortSignal(AbortSignal.timeout(15_000))
      .maybeSingle(),
    client
      .from("connector_resources")
      .select("id")
      .eq("workspace_id", workspace)
      .eq("installation_id", surface.installation_id)
      .eq("external_resource_id", surface.external_project_id)
      .eq("resource_type", "project")
      .eq("selected", true)
      .eq("access_state", "available")
      .abortSignal(AbortSignal.timeout(15_000))
      .maybeSingle(),
    client
      .from("deployment_sync_attempts")
      .select("id,status,completed_at")
      .eq("workspace_id", workspace)
      .eq("deployment_surface_id", request.surfaceId)
      .in("status", ["succeeded", "failed"])
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .abortSignal(AbortSignal.timeout(15_000))
      .maybeSingle(),
    client
      .from("deployment_sync_attempts")
      .select("id")
      .eq("workspace_id", workspace)
      .eq("deployment_surface_id", request.surfaceId)
      .eq("status", "running")
      .limit(1)
      .abortSignal(AbortSignal.timeout(15_000)),
  ]);
  if (authorized.some((r) => r.error))
    throw new Error("production_analysis_authorization_read_failed");
  if (authorized.slice(0, 3).some((r) => !r.data) || (authorized[3].data as unknown[]).length)
    return null;
  const sync = syncSchema.safeParse(authorized[2].data);
  if (
    !sync.success ||
    Date.parse(sync.data.completed_at) > now.getTime() ||
    now.getTime() - Date.parse(sync.data.completed_at) >= 86_400_000
  )
    return null;
  const installation = await loadInstallation(client, workspace, surface.installation_id, "vercel");
  const credentials = await getFreshProviderCredentials(client, installation);
  const configuration = await getVercelConfiguration(credentials);
  if (
    configuration.projectSelection === "selected" &&
    !configuration.projects.includes(surface.external_project_id)
  )
    return null;
  const teamId =
    typeof credentials.providerMetadata?.teamId === "string"
      ? credentials.providerMetadata.teamId
      : null;
  // Use the existing bounded adapter: alias resolution, ready Production target and exact SHA.
  const live = await getVercelProjectDeploymentSnapshot(
    credentials,
    surface.external_project_id,
    teamId,
    now.toISOString(),
    { requireCompleteAliases: true },
  );
  const current = live.observations.filter(
    (o) => o.providerDeploymentId === live.currentProductionDeploymentId,
  );
  if (
    current.length !== 1 ||
    live.currentProductionDeploymentId !== surface.current_production_deployment_id
  )
    return null;
  const target = current[0];
  if (
    !target.isCurrentProduction ||
    target.environment !== "production" ||
    target.state !== "ready" ||
    !target.commitSha ||
    target.sourceRepository?.owner !== repository.owner.toLowerCase() ||
    target.sourceRepository.name !== repository.name.toLowerCase() ||
    live.project.repository?.owner !== repository.owner.toLowerCase() ||
    live.project.repository.name !== repository.name.toLowerCase()
  )
    return null;
  const { data: observationData, error: observationError } = await client
    .from("deployment_observations")
    .select("id,commit_sha,environment_type,deployment_state")
    .eq("workspace_id", workspace)
    .eq("deployment_surface_id", request.surfaceId)
    .eq("external_deployment_id", live.currentProductionDeploymentId)
    .abortSignal(AbortSignal.timeout(15_000))
    .maybeSingle();
  if (observationError) throw new Error("production_analysis_observation_read_failed");
  const observation = observationSchema.safeParse(observationData);
  if (!observation.success || observation.data.commit_sha.toLowerCase() !== target.commitSha)
    return null;
  const { data: evidenceData, error: evidenceError } = await client
    .from("product_deployment_evidence")
    .select("id,verified_commit_sha,verification_state")
    .eq("workspace_id", workspace)
    .eq("protected_product_id", request.productId)
    .eq("deployment_surface_id", request.surfaceId)
    .eq("repository_id", request.repositoryId)
    .eq("deployment_observation_id", observation.data.id)
    .abortSignal(AbortSignal.timeout(15_000))
    .maybeSingle();
  if (evidenceError) throw new Error("production_analysis_evidence_read_failed");
  const evidence = evidenceSchema.safeParse(evidenceData);
  if (!evidence.success || evidence.data.verified_commit_sha.toLowerCase() !== target.commitSha)
    return null;
  return {
    ...request,
    routeIntentId: seed.route_intent_id,
    deploymentId: live.currentProductionDeploymentId!,
    commitSha: target.commitSha,
    observationId: observation.data.id,
    evidenceId: evidence.data.id,
    syncAttemptId: sync.data.id,
    syncCompletedAt: sync.data.completed_at,
    observedAt: now.toISOString(),
  };
}

export async function readProductionGraph(
  client: SupabaseClient,
  binding: ProductionBinding,
  graphBuildId: string,
  analysisRunId: string,
): Promise<ProductionGraph> {
  const { data, error } = await client
    .from("impact_graph_builds")
    .select(
      "id,workspace_id,product_id,repository_id,route_intent_id,commit_sha,status,assessment_state,analysis_profile,coverage_state",
    )
    .eq("id", graphBuildId)
    .eq("workspace_id", binding.workspaceId)
    .eq("product_id", binding.productId)
    .eq("repository_id", binding.repositoryId)
    .eq("route_intent_id", binding.routeIntentId)
    .eq("analysis_run_id", analysisRunId)
    .eq("commit_sha", binding.commitSha)
    .abortSignal(AbortSignal.timeout(15_000))
    .maybeSingle();
  if (error || !data) throw new Error("production_analysis_graph_read_failed");
  const graph = graphSchema.parse(data);
  return {
    id: graph.id,
    workspaceId: graph.workspace_id,
    productId: graph.product_id,
    repositoryId: graph.repository_id,
    routeIntentId: graph.route_intent_id,
    commitSha: graph.commit_sha,
    status: graph.status,
    assessmentState: graph.assessment_state,
    analysisProfile: graph.analysis_profile,
    coverageState: graph.coverage_state,
  };
}
