import "server-only";
import { getEnvironment } from "@/lib/env/schema";
import {
  decryptStoredCredentialValue,
  getFreshProviderCredentials,
  loadInstallation,
  serverConnectors,
} from "@/lib/connectors/service";
import { ConnectorError } from "@/lib/connectors/model";
import { loadProductDeploymentProtectionGraph } from "@/lib/protection/deployment-graph";
import { GitHubAppRepositoryProvider } from "@/lib/preflight/github-provider";
import type { RepositoryTarget } from "@/lib/preflight/preflight";
import {
  getVercelConfiguration,
  getVercelProjectDeploymentSnapshot,
} from "@/lib/deployments/vercel";
import { syncSelectedVercelProject } from "@/lib/deployments/service";
import type { ProviderCredentials } from "@/lib/connectors/providers";
import { M157_FIXED_TARGET as TARGET } from "../../../scripts/m157-deployment-acceptance.ts";
import { isM157AcceptanceComplete, withM157AcceptanceStage } from "./acceptance-completion";

type QueryError = { message?: string } | null;
type DeploymentSurfaceRow = {
  id: string;
  installation_id: string;
  external_project_id: string;
  environment_scope: string;
  current_production_deployment_id: string | null;
  last_attempt_status: string | null;
};
type ProductSurfaceMappingRow = { id: string; repository_id: string; provenance: string };
type DeploymentObservationRow = {
  id: string;
  environment_type: string;
  deployment_state: string;
  commit_sha: string | null;
  source_repository_owner: string | null;
  source_repository_name: string | null;
  provenance: Record<string, unknown> | null;
};
type ProductDeploymentEvidenceRow = {
  id: string;
  baseline_preflight_evidence_id: string | null;
  preflight_finding_id: string | null;
  verification_state: string;
  verified_commit_sha: string | null;
  safe_metadata: Record<string, unknown> | null;
  deployment_observation_id: string;
  repository_id: string;
};
type WorkspaceRow = { id: string; name: string };
type ProductRow = { id: string; workspace_id: string; status: string };
type ConnectorResourceRow = {
  id: string;
  workspace_id: string;
  installation_id: string;
  external_resource_id: string;
  resource_type: string;
  selected: boolean;
  access_state: string;
};
type RepositoryRow = {
  id: string;
  workspace_id: string;
  connection_id: string;
  external_id: string | number;
  owner: string;
  name: string;
  default_branch: string;
  status: string;
  selected_for_protection: boolean;
};
type RepositoryConnectionRow = {
  id: string;
  workspace_id: string;
  provider: string;
  installation_id: string | number;
  account_login: string;
  status: string;
};
type ProductRepositoryRow = {
  repository_id: string;
  protected_product_id: string;
  status: string;
};
type CredentialMetadataRow = {
  key_version: number;
  access_expires_at: string | null;
  credential_version: number;
};
type StoredCredentialMetadataRow = CredentialMetadataRow & {
  ciphertext: string;
  nonce: string;
  authentication_tag: string;
};
type CredentialVersionRow = { key_version: number; credential_version: number };
type BaselineRunRow = { id: string; preflight_mode: string; status: string; created_at: string };

function requireCondition(condition: unknown, stage: string): asserts condition {
  if (!condition) throw new Error(`m157_acceptance_${stage}`);
}

function requireQuery<T>(
  data: T | null | undefined,
  error: QueryError,
  stage: string,
): NonNullable<T> {
  if (error || data === null || data === undefined) throw new Error(`m157_acceptance_${stage}`);
  return data as NonNullable<T>;
}

function safeFailureCategory(error: unknown) {
  if (error instanceof ConnectorError) return error.category.toLowerCase();
  if (error instanceof Error && /^m157_acceptance_[a-z0-9_]+$/.test(error.message))
    return error.message.slice("m157_acceptance_".length);
  return "unknown_safe";
}

async function runSync(input: {
  phase: "first" | "second";
  service: ReturnType<typeof serverConnectors>;
  installation: Awaited<ReturnType<typeof loadInstallation>>;
  credentials: ProviderCredentials;
}) {
  try {
    return await syncSelectedVercelProject({
      service: input.service,
      workspaceId: TARGET.workspaceId,
      productId: TARGET.productId,
      installation: input.installation,
      credentials: input.credentials,
      externalProjectId: TARGET.externalProjectId,
    });
  } catch (error) {
    if (error instanceof Error && /^m157_acceptance_[a-z0-9_]+$/.test(error.message)) throw error;
    if (error instanceof ConnectorError)
      throw new Error(`m157_acceptance_${input.phase}_sync_${error.category.toLowerCase()}`);
    throw new Error(`m157_acceptance_${input.phase}_sync_unavailable`);
  }
}

async function requiredRow<T>(
  query: PromiseLike<{ data: T | null; error: QueryError }>,
  stage: string,
): Promise<T> {
  const { data, error } = await query;
  return requireQuery(data, error, stage);
}

async function optionalRow<T>(
  query: PromiseLike<{ data: T | null; error: QueryError }>,
  stage: string,
): Promise<T | null> {
  const { data, error } = await query;
  if (error) throw new Error(`m157_acceptance_${stage}`);
  return data;
}

function countRows<T>(result: { data: T[] | null; error: QueryError }, stage: string) {
  return requireQuery(result.data, result.error, stage);
}

async function currentRepoQuota(service: ReturnType<typeof serverConnectors>) {
  const repositories = await service
    .from("repositories")
    .select("id")
    .eq("workspace_id", TARGET.workspaceId)
    .eq("status", "available")
    .eq("selected_for_protection", true);
  const mappings = await service
    .from("workspace_product_repositories")
    .select("repository_id")
    .eq("workspace_id", TARGET.workspaceId)
    .eq("protected_product_id", TARGET.productId)
    .eq("status", "active");
  return {
    selectedRepositories: countRows(repositories, "repository_quota_unavailable").length,
    productRepositoryMappings: countRows(mappings, "repository_mapping_unavailable").length,
  };
}

async function graphEvidence(service: ReturnType<typeof serverConnectors>, externalId: string) {
  const graph = await loadProductDeploymentProtectionGraph(service, {
    workspaceId: TARGET.workspaceId,
    productId: TARGET.productId,
    verificationCapabilityAvailable: true,
  });
  requireCondition(graph, "protection_graph_missing");
  const surface = graph.surfaces.find(
    (item) => item.provider === "vercel" && item.projectId === TARGET.externalProjectId,
  );
  requireCondition(surface, "protection_graph_surface_missing");
  const observation = surface.observations.find((item) => item.providerDeploymentId === externalId);
  requireCondition(observation, "protection_graph_observation_missing");
  requireCondition(
    observation.verification.state === "production_verified" &&
      observation.verification.exactCommitMatch &&
      observation.verification.baselinePreflightEvidenceId !== null &&
      observation.currentProduction,
    "protection_graph_evidence_mismatch",
  );
  return {
    surfaceId: surface.id,
    mappingProvenance: surface.mappingProvenance,
    repository: surface.repository,
    deploymentId: observation.providerDeploymentId,
    currentProduction: observation.currentProduction,
    verificationState: observation.verification.state,
    exactCommitMatch: observation.verification.exactCommitMatch,
  };
}

async function persistedState(input: {
  service: ReturnType<typeof serverConnectors>;
  repositoryId: string;
  deploymentId: string;
  sha: string;
  baselineEvidenceId: string;
}) {
  const { service } = input;
  const surface = await requiredRow<DeploymentSurfaceRow>(
    service
      .from("deployment_surfaces")
      .select(
        "id,installation_id,external_project_id,environment_scope,current_production_deployment_id,last_attempt_status",
      )
      .eq("workspace_id", TARGET.workspaceId)
      .eq("installation_id", TARGET.installationId)
      .eq("provider", "vercel")
      .eq("external_project_id", TARGET.externalProjectId)
      .eq("environment_scope", "all")
      .maybeSingle(),
    "deployment_surface_missing",
  );
  requireCondition(
    surface.current_production_deployment_id === input.deploymentId &&
      surface.last_attempt_status === "succeeded",
    "deployment_surface_currentness_mismatch",
  );

  const mapping = await requiredRow<ProductSurfaceMappingRow>(
    service
      .from("workspace_product_deployment_surfaces")
      .select("id,repository_id,provenance")
      .eq("workspace_id", TARGET.workspaceId)
      .eq("protected_product_id", TARGET.productId)
      .eq("deployment_surface_id", surface.id)
      .eq("repository_id", input.repositoryId)
      .maybeSingle(),
    "product_surface_mapping_missing",
  );

  const observation = await requiredRow<DeploymentObservationRow>(
    service
      .from("deployment_observations")
      .select(
        "id,environment_type,deployment_state,commit_sha,source_repository_owner,source_repository_name,provenance",
      )
      .eq("workspace_id", TARGET.workspaceId)
      .eq("deployment_surface_id", surface.id)
      .eq("external_deployment_id", input.deploymentId)
      .maybeSingle(),
    "deployment_observation_missing",
  );
  requireCondition(
    observation.environment_type === "production" &&
      observation.deployment_state === "ready" &&
      observation.commit_sha?.toLowerCase() === input.sha.toLowerCase() &&
      observation.source_repository_owner?.toLowerCase() === TARGET.repositoryOwner &&
      observation.source_repository_name?.toLowerCase() === TARGET.repositoryName,
    "deployment_observation_mismatch",
  );

  const evidence = await requiredRow<ProductDeploymentEvidenceRow>(
    service
      .from("product_deployment_evidence")
      .select(
        "id,baseline_preflight_evidence_id,preflight_finding_id,verification_state,verified_commit_sha,safe_metadata,deployment_observation_id,repository_id",
      )
      .eq("workspace_id", TARGET.workspaceId)
      .eq("protected_product_id", TARGET.productId)
      .eq("deployment_surface_id", surface.id)
      .eq("deployment_observation_id", observation.id)
      .eq("repository_id", input.repositoryId)
      .maybeSingle(),
    "product_deployment_evidence_missing",
  );
  requireCondition(
    evidence.baseline_preflight_evidence_id === input.baselineEvidenceId &&
      evidence.preflight_finding_id === null &&
      evidence.verification_state === "production_verified" &&
      evidence.verified_commit_sha?.toLowerCase() === input.sha.toLowerCase() &&
      evidence.safe_metadata?.exactCommitMatch === true,
    "product_deployment_evidence_mismatch",
  );

  const attempts = countRows(
    await service
      .from("deployment_sync_attempts")
      .select("id,status,observed_count,started_at,completed_at")
      .eq("workspace_id", TARGET.workspaceId)
      .eq("deployment_surface_id", surface.id)
      .order("started_at", { ascending: false })
      .limit(100),
    "deployment_sync_attempts_unavailable",
  );
  requireCondition(attempts[0]?.status === "succeeded", "latest_sync_attempt_not_successful");
  const failures = attempts
    .filter((item) => item.status === "failed")
    .map((item) => item.id)
    .sort();
  return {
    surfaceId: surface.id as string,
    mappingId: mapping.id as string,
    observationId: observation.id as string,
    evidenceId: evidence.id as string,
    attemptId: attempts[0]!.id as string,
    attemptCount: attempts.length,
    failedAttemptIds: failures,
    observedCount: attempts[0]!.observed_count as number,
  };
}

async function runM157DeploymentAcceptanceInternal(input?: {
  freshBaseline?: {
    preflightRunId: string;
    mode: "baseline";
    evidenceId: string;
    repositoryId: string;
    repository: string;
    verifiedCommitSha: string;
    verificationState: "verified";
    observedAt: string;
    replayed: boolean;
  };
}) {
  let environment: ReturnType<typeof getEnvironment>;
  try {
    environment = getEnvironment();
  } catch {
    throw new Error("m157_acceptance_environment_invalid");
  }
  let supabaseUrl: URL;
  try {
    supabaseUrl = new URL(environment.NEXT_PUBLIC_SUPABASE_URL ?? "");
  } catch {
    throw new Error("m157_acceptance_supabase_project_unavailable");
  }
  requireCondition(
    supabaseUrl.hostname === `${TARGET.supabaseProjectRef}.supabase.co`,
    "supabase_project_mismatch",
  );

  const service = serverConnectors();
  const workspace = await requiredRow<WorkspaceRow>(
    service.from("workspaces").select("id,name").eq("id", TARGET.workspaceId).maybeSingle(),
    "workspace_missing",
  );
  requireCondition(workspace.name === "Test", "workspace_identity_mismatch");

  const product = await requiredRow<ProductRow>(
    service
      .from("workspace_products")
      .select("id,workspace_id,status")
      .eq("workspace_id", TARGET.workspaceId)
      .eq("id", TARGET.productId)
      .maybeSingle(),
    "product_missing",
  );
  requireCondition(product.status === "protected", "product_not_protected");

  const installation = await loadInstallation(
    service,
    TARGET.workspaceId,
    TARGET.installationId,
    "vercel",
  );
  requireCondition(
    installation.id === TARGET.installationId &&
      installation.workspace_id === TARGET.workspaceId &&
      installation.provider === "vercel" &&
      installation.lifecycle_state === "connected" &&
      installation.health_state === "healthy",
    "vercel_installation_invariant_failed",
  );

  const resource = await requiredRow<ConnectorResourceRow>(
    service
      .from("connector_resources")
      .select(
        "id,workspace_id,installation_id,external_resource_id,resource_type,selected,access_state",
      )
      .eq("workspace_id", TARGET.workspaceId)
      .eq("installation_id", TARGET.installationId)
      .eq("id", TARGET.resourceId)
      .maybeSingle(),
    "vercel_resource_missing",
  );
  requireCondition(
    resource.external_resource_id === TARGET.externalProjectId &&
      resource.resource_type === "project" &&
      resource.selected === true &&
      resource.access_state === "available",
    "vercel_resource_invariant_failed",
  );

  const repository = await requiredRow<RepositoryRow>(
    service
      .from("repositories")
      .select(
        "id,workspace_id,connection_id,external_id,owner,name,default_branch,status,selected_for_protection",
      )
      .eq("workspace_id", TARGET.workspaceId)
      .eq("owner", TARGET.repositoryOwner)
      .eq("name", TARGET.repositoryName)
      .eq("status", "available")
      .eq("selected_for_protection", true)
      .maybeSingle(),
    "protected_repository_missing",
  );
  const repositoryConnection = await requiredRow<RepositoryConnectionRow>(
    service
      .from("repository_connections")
      .select("id,workspace_id,provider,installation_id,account_login,status")
      .eq("workspace_id", TARGET.workspaceId)
      .eq("id", repository.connection_id)
      .maybeSingle(),
    "github_connection_missing",
  );
  requireCondition(
    repositoryConnection.provider === "github" &&
      repositoryConnection.status === "connected" &&
      repositoryConnection.account_login.toLowerCase() === TARGET.repositoryOwner,
    "github_connection_identity_mismatch",
  );
  const productRepository = await requiredRow<ProductRepositoryRow>(
    service
      .from("workspace_product_repositories")
      .select("repository_id,protected_product_id,status")
      .eq("workspace_id", TARGET.workspaceId)
      .eq("protected_product_id", TARGET.productId)
      .eq("repository_id", repository.id)
      .eq("status", "active")
      .maybeSingle(),
    "product_repository_mapping_missing",
  );
  requireCondition(
    productRepository.repository_id === repository.id &&
      productRepository.protected_product_id === TARGET.productId,
    "product_repository_mapping_mismatch",
  );

  const credentialMetadata = await requiredRow<CredentialMetadataRow>(
    service
      .from("connector_credentials")
      .select("key_version,access_expires_at,credential_version")
      .eq("workspace_id", TARGET.workspaceId)
      .eq("installation_id", TARGET.installationId)
      .maybeSingle(),
    "vercel_credential_missing",
  );
  requireCondition(credentialMetadata.key_version === 1, "credential_key_version_mismatch");
  const expiresAt = credentialMetadata.access_expires_at
    ? Date.parse(credentialMetadata.access_expires_at)
    : Number.POSITIVE_INFINITY;
  requireCondition(
    Number.isFinite(expiresAt) || expiresAt === Number.POSITIVE_INFINITY,
    "credential_expiry_invalid",
  );
  requireCondition(expiresAt > Date.now() + 120_000, "credential_not_healthy_for_no_refresh_check");

  let credentials: ProviderCredentials;
  try {
    credentials = await getFreshProviderCredentials(service, installation);
  } catch (error) {
    throw new Error(`m157_acceptance_credential_${safeFailureCategory(error)}`);
  }
  requireCondition(
    typeof credentials.accessToken === "string" && credentials.accessToken.length > 0,
    "credential_decryption_failed",
  );
  const credentialMetadataAfterDecrypt = await requiredRow<CredentialVersionRow>(
    service
      .from("connector_credentials")
      .select("key_version,credential_version")
      .eq("workspace_id", TARGET.workspaceId)
      .eq("installation_id", TARGET.installationId)
      .maybeSingle(),
    "credential_state_after_decrypt_unavailable",
  );
  requireCondition(
    credentialMetadataAfterDecrypt.key_version === 1 &&
      credentialMetadataAfterDecrypt.credential_version === credentialMetadata.credential_version,
    "credential_refresh_unexpected",
  );

  let configuration;
  try {
    configuration = await getVercelConfiguration(credentials);
  } catch (error) {
    throw new Error(`m157_acceptance_vercel_configuration_${safeFailureCategory(error)}`);
  }
  requireCondition(
    configuration.id === installation.safe_metadata.configurationId &&
      configuration.teamId === TARGET.teamId &&
      configuration.projectSelection === "selected" &&
      configuration.projects.length === 1 &&
      configuration.projects[0] === TARGET.externalProjectId,
    "vercel_configuration_identity_mismatch",
  );
  const requiredScopes = [
    "integration-configuration:read",
    "project:read",
    "deployment:read",
    "domain:read",
    "team:read",
    "user:read",
  ];
  requireCondition(
    requiredScopes.every((scope) => configuration.scopes.includes(scope)) &&
      configuration.scopes.every((scope) => scope.endsWith(":read")) &&
      !configuration.scopes.some((scope) => /(write|create|delete|environment)/i.test(scope)),
    "vercel_scope_contract_mismatch",
  );

  const githubInstallationId = Number(repositoryConnection.installation_id);
  const externalRepositoryId = Number(repository.external_id);
  requireCondition(
    Number.isSafeInteger(githubInstallationId) &&
      githubInstallationId > 0 &&
      Number.isSafeInteger(externalRepositoryId) &&
      externalRepositoryId > 0 &&
      repository.default_branch === "main",
    "github_repository_metadata_invalid",
  );
  const repositoryTarget: RepositoryTarget = {
    id: repository.id,
    workspaceId: TARGET.workspaceId,
    owner: repository.owner,
    name: repository.name,
    defaultBranch: repository.default_branch,
    externalId: externalRepositoryId,
    installationId: githubInstallationId,
  };
  const github = new GitHubAppRepositoryProvider({
    appId: environment.GITHUB_APP_ID,
    privateKey: environment.GITHUB_APP_PRIVATE_KEY,
  });
  let githubMainSha: string;
  try {
    githubMainSha = await github.getHead(repositoryTarget);
  } catch (error) {
    throw new Error(`m157_acceptance_github_head_${safeFailureCategory(error)}`);
  }

  let snapshot: Awaited<ReturnType<typeof getVercelProjectDeploymentSnapshot>>;
  try {
    snapshot = await getVercelProjectDeploymentSnapshot(
      credentials,
      TARGET.externalProjectId,
      TARGET.teamId,
    );
  } catch (error) {
    throw new Error(`m157_acceptance_vercel_snapshot_${safeFailureCategory(error)}`);
  }
  requireCondition(
    snapshot.project.id === TARGET.externalProjectId &&
      snapshot.project.accountId === TARGET.teamId &&
      snapshot.project.repository?.owner === TARGET.repositoryOwner &&
      snapshot.project.repository?.name === TARGET.repositoryName,
    "vercel_project_repository_mismatch",
  );
  requireCondition(
    snapshot.currentProductionDeploymentId &&
      snapshot.currentProductionAliases.includes("auterim.com"),
    "authoritative_production_alias_missing",
  );
  const currentProductionDeploymentId = snapshot.currentProductionDeploymentId;
  const currentDeployment = snapshot.observations.find(
    (observation) => observation.providerDeploymentId === currentProductionDeploymentId,
  );
  requireCondition(
    currentDeployment?.environment === "production" &&
      currentDeployment.state === "ready" &&
      currentDeployment.sourceRepository?.owner === TARGET.repositoryOwner &&
      currentDeployment.sourceRepository?.name === TARGET.repositoryName &&
      currentDeployment.commitSha === githubMainSha,
    "current_production_deployment_mismatch",
  );
  let baselineQuery = service
    .from("baseline_preflight_evidence")
    .select(
      "id,workspace_id,protected_product_id,preflight_run_id,repository_id,commit_sha,verification_state,observed_at",
    )
    .eq("workspace_id", TARGET.workspaceId)
    .eq("protected_product_id", TARGET.productId)
    .eq("repository_id", repository.id)
    .eq("verification_state", "verified");
  if (input?.freshBaseline) {
    baselineQuery = baselineQuery.eq("id", input.freshBaseline.evidenceId);
  } else {
    baselineQuery = baselineQuery
      .eq("commit_sha", githubMainSha)
      .order("observed_at", { ascending: false })
      .limit(5);
  }
  const baselineRows = countRows(await baselineQuery, "baseline_evidence_unavailable");
  const baseline = baselineRows[0];
  requireCondition(baseline, "fresh_baseline_for_release_missing");
  if (input?.freshBaseline) {
    const deploymentReadyAt = currentDeployment.readyAt
      ? Date.parse(currentDeployment.readyAt)
      : NaN;
    requireCondition(
      input.freshBaseline.mode === "baseline" &&
        input.freshBaseline.verificationState === "verified" &&
        input.freshBaseline.repositoryId === repository.id &&
        input.freshBaseline.repository === `${TARGET.repositoryOwner}/${TARGET.repositoryName}` &&
        input.freshBaseline.evidenceId === baseline.id &&
        input.freshBaseline.preflightRunId === baseline.preflight_run_id &&
        input.freshBaseline.verifiedCommitSha.toLowerCase() === githubMainSha.toLowerCase() &&
        baseline.commit_sha.toLowerCase() === githubMainSha.toLowerCase() &&
        Number.isFinite(deploymentReadyAt) &&
        Date.parse(baseline.observed_at) >= deploymentReadyAt,
      "fresh_baseline_sha_mismatch",
    );
  } else if (githubMainSha === TARGET.initialReleaseSha) {
    requireCondition(
      baseline.id === TARGET.initialBaselineEvidenceId &&
        baseline.preflight_run_id === TARGET.initialBaselineRunId,
      "initial_baseline_identity_mismatch",
    );
  } else {
    const deploymentReadyAt = currentDeployment.readyAt
      ? Date.parse(currentDeployment.readyAt)
      : NaN;
    requireCondition(
      Number.isFinite(deploymentReadyAt) && Date.parse(baseline.observed_at) >= deploymentReadyAt,
      "new_release_baseline_not_fresh",
    );
  }
  const baselineRun = await requiredRow<BaselineRunRow>(
    service
      .from("preflight_runs")
      .select("id,preflight_mode,status,created_at")
      .eq("workspace_id", TARGET.workspaceId)
      .eq("id", baseline.preflight_run_id)
      .eq("protected_product_id", TARGET.productId)
      .maybeSingle(),
    "baseline_run_missing",
  );
  requireCondition(
    baselineRun.preflight_mode === "baseline" && baselineRun.status === "completed",
    "baseline_run_not_completed",
  );

  const quotaBefore = await currentRepoQuota(service);
  const existingSurface = await service
    .from("deployment_surfaces")
    .select("id")
    .eq("workspace_id", TARGET.workspaceId)
    .eq("installation_id", TARGET.installationId)
    .eq("external_project_id", TARGET.externalProjectId)
    .eq("environment_scope", "all");
  const surfacesBefore = countRows(
    existingSurface,
    "deployment_surface_history_unavailable",
  ).length;
  const evidenceHistoryBefore = await service
    .from("baseline_preflight_evidence")
    .select("id")
    .eq("workspace_id", TARGET.workspaceId)
    .eq("protected_product_id", TARGET.productId)
    .eq("repository_id", repository.id);
  const baselineCountBefore = countRows(
    evidenceHistoryBefore,
    "baseline_history_unavailable",
  ).length;

  const firstResult = await runSync({ phase: "first", service, installation, credentials });
  requireCondition(
    firstResult.observed > 0 &&
      firstResult.mappedProducts === 1 &&
      firstResult.currentProductionDeploymentId === currentProductionDeploymentId,
    "first_sync_result_mismatch",
  );
  const firstState = await withM157AcceptanceStage("first_persisted_state_unavailable", () =>
    persistedState({
      service,
      repositoryId: repository.id,
      deploymentId: currentProductionDeploymentId,
      sha: githubMainSha,
      baselineEvidenceId: baseline.id,
    }),
  );
  const firstGraph = await withM157AcceptanceStage("first_protection_graph_unavailable", () =>
    graphEvidence(service, currentProductionDeploymentId),
  );
  requireCondition(
    firstGraph.surfaceId === firstState.surfaceId &&
      firstGraph.mappingProvenance === "protected_repository_identity" &&
      firstGraph.repository?.id === repository.id,
    "first_protection_graph_mismatch",
  );

  const secondResult = await runSync({ phase: "second", service, installation, credentials });
  requireCondition(
    secondResult.observed === firstResult.observed &&
      secondResult.mappedProducts === 1 &&
      secondResult.currentProductionDeploymentId === currentProductionDeploymentId,
    "second_sync_result_mismatch",
  );
  const secondState = await withM157AcceptanceStage("second_persisted_state_unavailable", () =>
    persistedState({
      service,
      repositoryId: repository.id,
      deploymentId: currentProductionDeploymentId,
      sha: githubMainSha,
      baselineEvidenceId: baseline.id,
    }),
  );
  const secondGraph = await withM157AcceptanceStage("second_protection_graph_unavailable", () =>
    graphEvidence(service, currentProductionDeploymentId),
  );
  const quotaAfter = await withM157AcceptanceStage("quota_after_second_sync_unavailable", () =>
    currentRepoQuota(service),
  );
  const evidenceHistoryAfter = await withM157AcceptanceStage(
    "baseline_history_after_sync_unavailable",
    () =>
      service
        .from("baseline_preflight_evidence")
        .select("id")
        .eq("workspace_id", TARGET.workspaceId)
        .eq("protected_product_id", TARGET.productId)
        .eq("repository_id", repository.id),
  );
  const baselineCountAfter = countRows(
    evidenceHistoryAfter,
    "baseline_history_after_sync_unavailable",
  ).length;
  const surfacesAfter = await withM157AcceptanceStage(
    "deployment_surface_history_after_sync_unavailable",
    () =>
      service
        .from("deployment_surfaces")
        .select("id")
        .eq("workspace_id", TARGET.workspaceId)
        .eq("installation_id", TARGET.installationId)
        .eq("external_project_id", TARGET.externalProjectId)
        .eq("environment_scope", "all"),
  );
  const surfaceCountAfter = countRows(
    surfacesAfter,
    "deployment_surface_history_after_sync_unavailable",
  ).length;
  const healthAfter = await withM157AcceptanceStage("health_after_second_sync_unavailable", () =>
    loadInstallation(service, TARGET.workspaceId, TARGET.installationId, "vercel"),
  );

  requireCondition(
    secondState.surfaceId === firstState.surfaceId &&
      secondState.mappingId === firstState.mappingId &&
      secondState.observationId === firstState.observationId &&
      secondState.evidenceId === firstState.evidenceId &&
      secondState.attemptCount === firstState.attemptCount + 1 &&
      secondState.attemptId !== firstState.attemptId &&
      JSON.stringify(secondState.failedAttemptIds) ===
        JSON.stringify(firstState.failedAttemptIds) &&
      surfaceCountAfter === Math.max(1, surfacesBefore) &&
      baselineCountAfter === baselineCountBefore &&
      quotaAfter.selectedRepositories === quotaBefore.selectedRepositories &&
      quotaAfter.productRepositoryMappings === quotaBefore.productRepositoryMappings &&
      healthAfter.lifecycle_state === "connected" &&
      healthAfter.health_state === "healthy" &&
      secondGraph.surfaceId === firstGraph.surfaceId &&
      secondGraph.currentProduction &&
      secondGraph.verificationState === "production_verified",
    "idempotency_or_state_preservation_failed",
  );

  return {
    target: {
      workspaceId: TARGET.workspaceId,
      workspaceName: workspace.name,
      productId: TARGET.productId,
      repository: `${TARGET.repositoryOwner}/${TARGET.repositoryName}`,
      installationId: TARGET.installationId,
      resourceId: TARGET.resourceId,
      vercelProjectId: TARGET.externalProjectId,
      teamId: TARGET.teamId,
    },
    baseline: {
      runId: baseline.preflight_run_id,
      evidenceId: baseline.id,
      sha: baseline.commit_sha,
      mode: baselineRun.preflight_mode,
      state: baseline.verification_state,
      ...(input?.freshBaseline ? { replayed: input.freshBaseline.replayed } : {}),
    },
    credential: {
      keyVersion: 1,
      decrypt: "PASS",
      keyVersionNormalization: "PASS",
      authenticationTagNormalization: "PASS",
      refreshAttempted: false,
    },
    production: {
      deploymentId: currentProductionDeploymentId,
      ready: true,
      alias: "auterim.com",
      sha: currentDeployment.commitSha,
      githubMainSha,
      exactShaMatch: true,
    },
    firstSync: {
      status: "succeeded",
      observed: firstResult.observed,
      mappedProducts: firstResult.mappedProducts,
      surfaceId: firstState.surfaceId,
      mappingId: firstState.mappingId,
      observationId: firstState.observationId,
      attemptId: firstState.attemptId,
      evidenceId: firstState.evidenceId,
      verificationState: "production_verified",
      exactCommitMatch: true,
    },
    secondSync: {
      status: "succeeded",
      observed: secondResult.observed,
      mappedProducts: secondResult.mappedProducts,
      attemptId: secondState.attemptId,
    },
    evidence: {
      verificationState: "production_verified",
      baselineEvidenceId: baseline.id,
      preflightFindingId: null,
      verifiedCommitSha: githubMainSha,
      exactCommitMatch: true,
    },
    protectionGraph: {
      firstSync: firstGraph,
      secondSyncCurrent: secondGraph.currentProduction,
    },
    idempotency: {
      sameSurface: firstState.surfaceId === secondState.surfaceId,
      sameMapping: firstState.mappingId === secondState.mappingId,
      sameObservation: firstState.observationId === secondState.observationId,
      sameEvidence: firstState.evidenceId === secondState.evidenceId,
      oneNewSyncAttempt: secondState.attemptCount === firstState.attemptCount + 1,
    },
    history: {
      baselineCountBefore: baselineCountBefore,
      baselineCountAfter: baselineCountAfter,
      failedSyncAttemptIdsPreserved: firstState.failedAttemptIds,
    },
    quota: quotaAfter,
    billingTouched: false,
    workspaceScope: "Test-only",
  };
}

export async function runM157DeploymentAcceptance(
  input?: Parameters<typeof runM157DeploymentAcceptanceInternal>[0],
) {
  try {
    return await runM157DeploymentAcceptanceInternal(input);
  } catch (error) {
    if (error instanceof Error && /^m157_acceptance_[a-z0-9_]+$/.test(error.message)) throw error;
    if (error instanceof ConnectorError)
      throw new Error(`m157_acceptance_provider_${error.category.toLowerCase()}`);
    throw new Error("m157_acceptance_operation_unavailable");
  }
}

/**
 * Prevents a second pair of internal syncs after the exact current Production
 * commit already has verified evidence. This reads the provider's current
 * Production truth before checking persisted evidence; it never performs a sync.
 */
async function isM157CurrentAcceptanceCompleteInternal(): Promise<boolean> {
  let environment: ReturnType<typeof getEnvironment>;
  try {
    environment = getEnvironment();
  } catch {
    throw new Error("m157_acceptance_self_lock_environment_invalid");
  }
  let supabaseUrl: URL;
  try {
    supabaseUrl = new URL(environment.NEXT_PUBLIC_SUPABASE_URL ?? "");
  } catch {
    throw new Error("m157_acceptance_self_lock_supabase_project_unavailable");
  }
  requireCondition(
    supabaseUrl.hostname === `${TARGET.supabaseProjectRef}.supabase.co`,
    "self_lock_supabase_project_mismatch",
  );

  const service = serverConnectors();
  let installation: Awaited<ReturnType<typeof loadInstallation>>;
  try {
    installation = await loadInstallation(
      service,
      TARGET.workspaceId,
      TARGET.installationId,
      "vercel",
    );
  } catch {
    return false;
  }
  if (installation.lifecycle_state !== "connected" || installation.health_state !== "healthy")
    return false;

  const credentialMetadata = await optionalRow<StoredCredentialMetadataRow>(
    service
      .from("connector_credentials")
      .select(
        "key_version,access_expires_at,credential_version,ciphertext,nonce,authentication_tag",
      )
      .eq("workspace_id", TARGET.workspaceId)
      .eq("installation_id", TARGET.installationId)
      .maybeSingle(),
    "self_lock_credential_unavailable",
  );
  if (!credentialMetadata || credentialMetadata.key_version !== 1) return false;

  let credentials: ProviderCredentials;
  try {
    credentials = decryptStoredCredentialValue<ProviderCredentials>(
      credentialMetadata,
      TARGET.workspaceId,
      "vercel",
      installation.external_account_id,
    );
  } catch {
    throw new Error("m157_acceptance_self_lock_credential_unavailable");
  }

  let snapshot: Awaited<ReturnType<typeof getVercelProjectDeploymentSnapshot>>;
  try {
    snapshot = await getVercelProjectDeploymentSnapshot(
      credentials,
      TARGET.externalProjectId,
      TARGET.teamId,
    );
  } catch {
    throw new Error("m157_acceptance_self_lock_provider_unavailable");
  }
  if (
    snapshot.project.id !== TARGET.externalProjectId ||
    snapshot.project.accountId !== TARGET.teamId ||
    snapshot.project.repository?.owner !== TARGET.repositoryOwner ||
    snapshot.project.repository?.name !== TARGET.repositoryName ||
    !snapshot.currentProductionDeploymentId ||
    !snapshot.currentProductionAliases.includes("auterim.com")
  )
    return false;
  const current = snapshot.observations.find(
    (item) => item.providerDeploymentId === snapshot.currentProductionDeploymentId,
  );
  if (
    current?.environment !== "production" ||
    current.state !== "ready" ||
    current.sourceRepository?.owner !== TARGET.repositoryOwner ||
    current.sourceRepository?.name !== TARGET.repositoryName ||
    typeof current.commitSha !== "string" ||
    !/^[a-f0-9]{40}$/i.test(current.commitSha)
  )
    return false;

  const repository = await optionalRow<{ id: string }>(
    service
      .from("repositories")
      .select("id")
      .eq("workspace_id", TARGET.workspaceId)
      .eq("owner", TARGET.repositoryOwner)
      .eq("name", TARGET.repositoryName)
      .eq("status", "available")
      .eq("selected_for_protection", true)
      .maybeSingle(),
    "self_lock_repository_unavailable",
  );
  if (!repository) return false;
  const surface = await optionalRow<DeploymentSurfaceRow>(
    service
      .from("deployment_surfaces")
      .select(
        "id,installation_id,external_project_id,environment_scope,current_production_deployment_id,last_attempt_status",
      )
      .eq("workspace_id", TARGET.workspaceId)
      .eq("installation_id", TARGET.installationId)
      .eq("provider", "vercel")
      .eq("external_project_id", TARGET.externalProjectId)
      .eq("environment_scope", "all")
      .maybeSingle(),
    "self_lock_surface_unavailable",
  );
  if (!surface) return false;
  if (
    surface.current_production_deployment_id !== snapshot.currentProductionDeploymentId ||
    surface.last_attempt_status !== "succeeded"
  )
    return false;

  const mapping = await optionalRow<ProductSurfaceMappingRow>(
    service
      .from("workspace_product_deployment_surfaces")
      .select("id,repository_id,provenance")
      .eq("workspace_id", TARGET.workspaceId)
      .eq("protected_product_id", TARGET.productId)
      .eq("deployment_surface_id", surface.id)
      .eq("repository_id", repository.id)
      .eq("status", "active")
      .maybeSingle(),
    "self_lock_mapping_unavailable",
  );
  if (!mapping) return false;
  const observation = await optionalRow<DeploymentObservationRow>(
    service
      .from("deployment_observations")
      .select(
        "id,environment_type,deployment_state,commit_sha,source_repository_owner,source_repository_name,provenance",
      )
      .eq("workspace_id", TARGET.workspaceId)
      .eq("deployment_surface_id", surface.id)
      .eq("external_deployment_id", snapshot.currentProductionDeploymentId)
      .maybeSingle(),
    "self_lock_observation_unavailable",
  );
  if (!observation) return false;
  if (
    observation.environment_type !== "production" ||
    observation.deployment_state !== "ready" ||
    observation.commit_sha?.toLowerCase() !== current.commitSha.toLowerCase() ||
    observation.source_repository_owner?.toLowerCase() !== TARGET.repositoryOwner ||
    observation.source_repository_name?.toLowerCase() !== TARGET.repositoryName
  )
    return false;

  const evidence = await optionalRow<ProductDeploymentEvidenceRow>(
    service
      .from("product_deployment_evidence")
      .select(
        "id,baseline_preflight_evidence_id,preflight_finding_id,verification_state,verified_commit_sha,safe_metadata,deployment_observation_id,repository_id",
      )
      .eq("workspace_id", TARGET.workspaceId)
      .eq("protected_product_id", TARGET.productId)
      .eq("deployment_surface_id", surface.id)
      .eq("deployment_observation_id", observation.id)
      .eq("repository_id", repository.id)
      .maybeSingle(),
    "self_lock_evidence_unavailable",
  );
  if (!evidence) return false;
  if (
    evidence.verification_state !== "production_verified" ||
    evidence.verified_commit_sha?.toLowerCase() !== current.commitSha.toLowerCase() ||
    !evidence.baseline_preflight_evidence_id ||
    evidence.preflight_finding_id !== null
  )
    return false;

  const baseline = await optionalRow<{
    id: string;
    commit_sha: string;
    verification_state: string;
    observed_at: string;
    preflight_run_id: string;
  }>(
    service
      .from("baseline_preflight_evidence")
      .select("id,commit_sha,verification_state,preflight_run_id,observed_at")
      .eq("id", evidence.baseline_preflight_evidence_id)
      .eq("workspace_id", TARGET.workspaceId)
      .eq("protected_product_id", TARGET.productId)
      .eq("repository_id", repository.id)
      .maybeSingle(),
    "self_lock_baseline_unavailable",
  );
  if (!baseline) return false;
  if (
    baseline.commit_sha.toLowerCase() !== current.commitSha.toLowerCase() ||
    baseline.verification_state !== "verified"
  )
    return false;

  const baselineRun = await optionalRow<BaselineRunRow>(
    service
      .from("preflight_runs")
      .select("id,preflight_mode,status,created_at")
      .eq("workspace_id", TARGET.workspaceId)
      .eq("id", baseline.preflight_run_id)
      .eq("protected_product_id", TARGET.productId)
      .maybeSingle(),
    "self_lock_baseline_run_unavailable",
  );
  if (!baselineRun) return false;
  const syncAttempts = countRows(
    await withM157AcceptanceStage("self_lock_sync_attempts_unavailable", () =>
      service
        .from("deployment_sync_attempts")
        .select("id,status,started_at,completed_at")
        .eq("workspace_id", TARGET.workspaceId)
        .eq("deployment_surface_id", surface.id)
        .gte("started_at", baseline.observed_at)
        .order("started_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(2),
    ),
    "self_lock_sync_attempts_unavailable",
  );

  return isM157AcceptanceComplete({
    currentSha: current.commitSha,
    currentDeploymentId: current.providerDeploymentId,
    baseline: {
      id: baseline.id,
      commitSha: baseline.commit_sha,
      verificationState: baseline.verification_state,
      observedAt: baseline.observed_at,
      preflightRunId: baseline.preflight_run_id,
    },
    baselineRun: {
      id: baselineRun.id,
      mode: baselineRun.preflight_mode,
      status: baselineRun.status,
    },
    surface: {
      id: surface.id,
      currentProductionDeploymentId: surface.current_production_deployment_id,
      lastAttemptStatus: surface.last_attempt_status,
    },
    mapping: {
      id: mapping.id,
      repositoryId: mapping.repository_id,
      provenance: mapping.provenance,
    },
    repositoryId: repository.id,
    observation: {
      id: observation.id,
      deploymentId: current.providerDeploymentId,
      environment: observation.environment_type,
      state: observation.deployment_state,
      commitSha: observation.commit_sha,
      repositoryOwner: observation.source_repository_owner,
      repositoryName: observation.source_repository_name,
    },
    evidence: {
      id: evidence.id,
      baselineEvidenceId: evidence.baseline_preflight_evidence_id,
      preflightFindingId: evidence.preflight_finding_id,
      verificationState: evidence.verification_state,
      verifiedCommitSha: evidence.verified_commit_sha,
      exactCommitMatch: evidence.safe_metadata?.exactCommitMatch === true,
      deploymentObservationId: evidence.deployment_observation_id,
      repositoryId: evidence.repository_id,
    },
    attempts: syncAttempts,
    expectedRepositoryOwner: TARGET.repositoryOwner,
    expectedRepositoryName: TARGET.repositoryName,
  });
}

export async function isM157CurrentAcceptanceComplete(): Promise<boolean> {
  try {
    return await isM157CurrentAcceptanceCompleteInternal();
  } catch (error) {
    if (error instanceof Error && /^m157_acceptance_[a-z0-9_]+$/.test(error.message)) throw error;
    throw new Error("m157_acceptance_self_lock_state_unavailable");
  }
}
