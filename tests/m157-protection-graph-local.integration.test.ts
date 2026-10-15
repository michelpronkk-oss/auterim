import { randomUUID } from "node:crypto";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadProductDeploymentProtectionGraph } from "@/lib/protection/deployment-graph";
import { graphEvidence } from "@/lib/m15/deployment-acceptance";
import { describe, expect, it } from "vitest";

const enabled =
  process.env.AUTERIM_M15_LOCAL_INTEGRATION === "1" &&
  process.env.AUTERIM_M15_LOCAL_SUPABASE_URL === "http://127.0.0.1:65431" &&
  process.env.NEXT_PUBLIC_SUPABASE_URL === "http://127.0.0.1:65431";

describe.skipIf(!enabled)("M15.7 canonical deployment graph on local Docker Supabase", () => {
  it("loads production-shaped evidence at observation 7 and applies the exact acceptance assertions", async () => {
    const client = createSupabaseServerClient();
    const runId = randomUUID();
    const userId = randomUUID();
    const workspaceId = randomUUID();
    let productId = "";
    const repositoryConnectionId = randomUUID();
    const repositoryId = randomUUID();
    const installationId = randomUUID();
    const surfaceId = randomUUID();
    const deploymentMappingId = randomUUID();
    const preflightRunId = randomUUID();
    const baselineEvidenceId = randomUUID();
    const productDeploymentEvidenceId = randomUUID();
    const deploymentObservationIds = Array.from({ length: 20 }, () => randomUUID());
    const deploymentIds = Array.from(
      { length: 20 },
      (_, index) => `dpl_m157_local_${runId.replaceAll("-", "").slice(0, 12)}_${index + 1}`,
    );
    const currentIndex = 6;
    const currentDeploymentId = deploymentIds[currentIndex]!;
    const now = Date.now();
    const commitSha = "a".repeat(40);
    const target = () => ({
      workspaceId,
      productId,
      externalProjectId: "prj_m157_local_fixture",
      repositoryOwner: "michelpronkk-oss",
      repositoryName: "auterim",
    });
    let authUserCreated = false;

    const insert = async (table: string, row: Record<string, unknown>) => {
      const { error } = await client.from(table).insert(row);
      if (error) throw new Error(`fixture_insert_${table}_${error.code ?? "failed"}`);
    };
    const update = async (
      table: string,
      values: Record<string, unknown>,
      id: string,
      stage: string,
    ) => {
      const { error } = await client.from(table).update(values).eq("id", id);
      if (error) throw new Error(`${stage}_${error.code ?? "failed"}`);
    };
    const readCurrentness = async (deploymentId: string) => {
      const graph = await loadProductDeploymentProtectionGraph(client, {
        workspaceId,
        productId,
        verificationCapabilityAvailable: true,
      });
      const surface = graph?.surfaces.find(
        (item) => item.provider === "vercel" && item.projectId === target().externalProjectId,
      );
      const observation = surface?.observations.find(
        (item) => item.providerDeploymentId === deploymentId,
      );
      return {
        graph,
        surface,
        observation,
        currentProduction: observation?.currentProduction === true,
      };
    };

    try {
      const { error: userError } = await client.auth.admin.createUser({
        id: userId,
        email: `m157-local-graph-${runId}@auterim.invalid`,
        password: `${randomUUID()}aA9!`,
        email_confirm: true,
        user_metadata: { fixture: "m157_local_protection_graph" },
      });
      if (userError) throw new Error(`fixture_auth_user_${userError.code ?? "failed"}`);
      authUserCreated = true;

      await insert("workspaces", {
        id: workspaceId,
        name: `M15.7 local graph ${runId.slice(0, 8)}`,
        created_by: userId,
      });
      const { data: defaultProducts, error: defaultProductError } = await client
        .from("workspace_products")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("is_default", true)
        .limit(1);
      if (defaultProductError || defaultProducts?.length !== 1)
        throw new Error("fixture_default_product_missing");
      productId = defaultProducts[0]!.id;
      const { error: protectProductError } = await client
        .from("workspace_products")
        .update({ status: "protected", protected_at: new Date(now).toISOString() })
        .eq("workspace_id", workspaceId)
        .eq("id", productId);
      if (protectProductError)
        throw new Error(`fixture_protect_product_${protectProductError.code ?? "failed"}`);
      await insert("workspace_members", {
        workspace_id: workspaceId,
        user_id: userId,
        role: "owner",
      });
      await insert("repository_connections", {
        id: repositoryConnectionId,
        workspace_id: workspaceId,
        provider: "github",
        installation_id: Math.floor(now / 1000),
        account_login: "michelpronkk-oss",
        status: "connected",
        connected_by: userId,
      });
      await insert("repositories", {
        id: repositoryId,
        workspace_id: workspaceId,
        connection_id: repositoryConnectionId,
        external_id: Math.floor(now / 1000),
        owner: target().repositoryOwner,
        name: target().repositoryName,
        default_branch: "main",
        private: true,
        archived: false,
        selected_for_protection: true,
        status: "available",
      });
      await insert("workspace_product_repositories", {
        workspace_id: workspaceId,
        protected_product_id: productId,
        repository_id: repositoryId,
        status: "active",
        provenance: "user_selected",
        created_by: userId,
      });
      await insert("connector_installations", {
        id: installationId,
        workspace_id: workspaceId,
        provider: "vercel",
        external_account_id: "team_m157_local_fixture",
        account_name: "Auterim local fixture",
        lifecycle_state: "connected",
        health_state: "healthy",
        scopes: ["project:read", "deployment:read", "domain:read", "team:read"],
        safe_metadata: { fixture: "m157_local_protection_graph" },
        connected_by: userId,
      });
      await insert("deployment_surfaces", {
        id: surfaceId,
        workspace_id: workspaceId,
        installation_id: installationId,
        provider: "vercel",
        external_project_id: target().externalProjectId,
        project_name: "auterim",
        environment_scope: "all",
        current_production_deployment_id: currentDeploymentId,
        last_successful_sync_at: new Date(now).toISOString(),
        last_attempt_at: new Date(now).toISOString(),
        last_attempt_status: "succeeded",
      });
      await insert("workspace_product_deployment_surfaces", {
        id: deploymentMappingId,
        workspace_id: workspaceId,
        protected_product_id: productId,
        deployment_surface_id: surfaceId,
        repository_id: repositoryId,
        provenance: "protected_repository_identity",
        created_by: userId,
      });
      await insert("preflight_runs", {
        id: preflightRunId,
        workspace_id: workspaceId,
        protected_product_id: productId,
        impact_assessment_id: null,
        status: "completed",
        preflight_mode: "baseline",
        preflight_version: "m157-local-graph-v1",
        repository_set_fingerprint: "b".repeat(64),
        change_fingerprint: "c".repeat(64),
        repositories_scanned: 1,
        started_at: new Date(now - 2_000).toISOString(),
        completed_at: new Date(now - 1_000).toISOString(),
      });
      await insert("baseline_preflight_evidence", {
        id: baselineEvidenceId,
        workspace_id: workspaceId,
        protected_product_id: productId,
        preflight_run_id: preflightRunId,
        repository_id: repositoryId,
        provider: "github",
        external_repository_id: Math.floor(now / 1000),
        repository_owner: target().repositoryOwner,
        repository_name: target().repositoryName,
        default_branch: "main",
        commit_sha: commitSha,
        verification_state: "verified",
      });

      const observations = deploymentObservationIds.map((id, index) => ({
        id,
        workspace_id: workspaceId,
        deployment_surface_id: surfaceId,
        external_deployment_id: deploymentIds[index],
        environment_type: index === currentIndex ? "production" : "preview",
        deployment_state: "ready",
        commit_sha: index === currentIndex ? commitSha : "d".repeat(40),
        source_repository_owner: target().repositoryOwner,
        source_repository_name: target().repositoryName,
        source_branch: "main",
        deployment_url: `https://auterim-m157-local-${index + 1}.vercel.app`,
        provider_created_at: new Date(now - (index + 1) * 60_000).toISOString(),
        provider_ready_at: new Date(now - (index + 1) * 60_000 + 1_000).toISOString(),
        observed_at: new Date(now - index * 1_000).toISOString(),
        provenance: "vercel_rest_api",
        verification_state: "observed",
        safe_metadata: { fixture: "m157_local_protection_graph" },
      }));
      const { error: observationsError } = await client
        .from("deployment_observations")
        .insert(observations);
      if (observationsError)
        throw new Error(`fixture_insert_observations_${observationsError.code ?? "failed"}`);
      await insert("product_deployment_evidence", {
        id: productDeploymentEvidenceId,
        workspace_id: workspaceId,
        protected_product_id: productId,
        deployment_surface_id: surfaceId,
        deployment_observation_id: deploymentObservationIds[currentIndex],
        repository_id: repositoryId,
        preflight_finding_id: null,
        baseline_preflight_evidence_id: baselineEvidenceId,
        verification_state: "production_verified",
        verified_commit_sha: commitSha,
        safe_metadata: { exactCommitMatch: true },
      });

      const positive = await graphEvidence(client, currentDeploymentId, { target: target() });
      expect(positive).toMatchObject({
        surfaceId,
        mappingProvenance: "protected_repository_identity",
        repository: {
          id: repositoryId,
          owner: "michelpronkk-oss",
          name: "auterim",
        },
        deploymentId: currentDeploymentId,
        currentProduction: true,
        verificationState: "production_verified",
        exactCommitMatch: true,
      });
      expect(positive.surfaceId).not.toBe(deploymentMappingId);

      const rawGraph = await loadProductDeploymentProtectionGraph(client, {
        workspaceId,
        productId,
        verificationCapabilityAvailable: true,
      });
      const surface = rawGraph?.surfaces.find((item) => item.deploymentSurfaceId === surfaceId);
      expect(surface?.id).toBe(deploymentMappingId);
      expect(surface?.observations).toHaveLength(20);
      expect(surface).toMatchObject({
        provider: "vercel",
        projectId: target().externalProjectId,
        mappingProvenance: "protected_repository_identity",
        repository: {
          id: repositoryId,
          owner: "michelpronkk-oss",
          name: "auterim",
        },
      });
      expect(surface?.observations[6]).toMatchObject({
        providerDeploymentId: currentDeploymentId,
        environment: "production",
        state: "ready",
        verification: {
          state: "production_verified",
          exactCommitMatch: true,
          baselinePreflightEvidenceId: baselineEvidenceId,
        },
        currentProduction: true,
      });

      await update(
        "deployment_observations",
        { commit_sha: "e".repeat(40) },
        deploymentObservationIds[currentIndex]!,
        "fixture_mismatched_sha",
      );
      expect((await readCurrentness(currentDeploymentId)).currentProduction).toBe(false);
      await update(
        "deployment_observations",
        { commit_sha: commitSha },
        deploymentObservationIds[currentIndex]!,
        "fixture_restore_sha",
      );

      await update(
        "product_deployment_evidence",
        { verification_state: "historical" },
        productDeploymentEvidenceId,
        "fixture_historical_evidence",
      );
      expect((await readCurrentness(currentDeploymentId)).currentProduction).toBe(false);
      await update(
        "product_deployment_evidence",
        { verification_state: "production_verified" },
        productDeploymentEvidenceId,
        "fixture_restore_evidence",
      );

      await update(
        "deployment_surfaces",
        { current_production_deployment_id: deploymentIds[0] },
        surfaceId,
        "fixture_historical_pointer",
      );
      expect((await readCurrentness(currentDeploymentId)).currentProduction).toBe(false);
      await update(
        "deployment_surfaces",
        { current_production_deployment_id: currentDeploymentId },
        surfaceId,
        "fixture_restore_pointer",
      );

      await update(
        "connector_installations",
        { health_state: "degraded" },
        installationId,
        "fixture_unhealthy_connector",
      );
      expect((await readCurrentness(currentDeploymentId)).currentProduction).toBe(false);
      await update(
        "connector_installations",
        { health_state: "healthy" },
        installationId,
        "fixture_restore_health",
      );

      const { error: inactiveMappingError } = await client
        .from("workspace_product_repositories")
        .update({ status: "inactive" })
        .eq("workspace_id", workspaceId)
        .eq("protected_product_id", productId)
        .eq("repository_id", repositoryId);
      if (inactiveMappingError)
        throw new Error(`fixture_inactive_mapping_${inactiveMappingError.code ?? "failed"}`);
      expect((await readCurrentness(currentDeploymentId)).currentProduction).toBe(false);
      const { error: restoreMappingError } = await client
        .from("workspace_product_repositories")
        .update({ status: "active" })
        .eq("workspace_id", workspaceId)
        .eq("protected_product_id", productId)
        .eq("repository_id", repositoryId);
      if (restoreMappingError)
        throw new Error(`fixture_restore_mapping_${restoreMappingError.code ?? "failed"}`);

      const { error: missingBaselineError } = await client
        .from("product_deployment_evidence")
        .update({ baseline_preflight_evidence_id: null })
        .eq("workspace_id", workspaceId)
        .eq("protected_product_id", productId)
        .eq("deployment_observation_id", deploymentObservationIds[currentIndex]);
      if (missingBaselineError)
        throw new Error(`fixture_missing_baseline_${missingBaselineError.code ?? "failed"}`);
      expect((await readCurrentness(currentDeploymentId)).currentProduction).toBe(false);
    } finally {
      const { error: workspaceDeleteError } = await client
        .from("workspaces")
        .delete()
        .eq("id", workspaceId);
      if (workspaceDeleteError) throw new Error("fixture_workspace_cleanup_failed");
      if (authUserCreated) {
        const { error } = await client.auth.admin.deleteUser(userId);
        if (error) throw new Error("fixture_auth_user_cleanup_failed");
      }
    }
  });
});
