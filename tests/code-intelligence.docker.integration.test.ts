import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { applyIntelligencePolicy } from "@/lib/intelligence/policy";
import { buildIntelligenceEvidence } from "@/lib/intelligence/evidence";
import {
  ACTIVE_ROUTING_READINESS,
  ACTIVE_THRESHOLD_VERSION,
  CALIBRATION_CORPUS_VERSION,
  CALIBRATED_ACTIVE_THRESHOLDS,
  CALIBRATION_FIXTURE_COUNT,
  CALIBRATION_HOLDOUT_METRICS,
  CALIBRATION_VERSION,
  INTELLIGENCE_ACTIVE_POLICY_VERSION,
  activeThresholdFingerprint,
} from "@/lib/intelligence/calibration";
import type { ClassificationChange } from "@/lib/monitoring/classification";
import type { JevJudgment, IntelligenceRoute } from "@/lib/intelligence/taxonomy";
import { analyzeCodeSnapshot, type SnapshotFile } from "@/lib/code-intelligence/analyzer";
import {
  claimCodeAnalysisRun,
  failCodeAnalysisRun,
  persistCodeAnalysis,
} from "@/lib/code-intelligence/service";
import { buildImpactGraph } from "@/lib/impact-graph/repository";
import { queryImpactGraph } from "@/lib/impact-graph/query";

const enabled = process.env.AUTERIM_M1576_DOCKER_ACCEPTANCE === "1";
const url = process.env.AUTERIM_M1576_EXPECTED_URL ?? "";
const serviceKey = process.env.AUTERIM_M1576_SERVICE_KEY ?? "";
const anonKey = process.env.AUTERIM_M1576_ANON_KEY ?? "";
const commitSha = process.env.AUTERIM_M1576_FIXTURE_COMMIT_SHA ?? "";
const previousCommitSha = process.env.AUTERIM_M1576_PREVIOUS_COMMIT_SHA ?? "";
const admin =
  enabled && url && serviceKey
    ? createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
    : null;

function requireAdmin(): SupabaseClient {
  if (!admin) throw new Error("m1576_docker_acceptance_guard_required");
  return admin;
}

async function write<T>(query: PromiseLike<{ data: T | null; error: { message: string } | null }>) {
  const result = await query;
  if (result.error || result.data === null) throw new Error("m1576_local_fixture_write_failed");
  return result.data;
}

async function writeNoResult(query: PromiseLike<{ error: { message: string } | null }>) {
  const result = await query;
  if (result.error) throw new Error("m1576_local_fixture_write_failed");
}

async function exactCount(table: string, analysisRunId: string) {
  const { count, error } = await requireAdmin()
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("analysis_run_id", analysisRunId);
  if (error || count === null) throw new Error("m1576_persisted_count_read_failed");
  return count;
}

async function readAll<T>(
  fetchPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
) {
  const rows: T[] = [];
  for (let offset = 0; offset < 50_001; offset += 1_000) {
    const page = await write(fetchPage(offset, offset + 999));
    rows.push(...page);
    if (page.length < 1_000) return rows;
  }
  throw new Error("m1576_readback_row_bound_exceeded");
}

function snapshotAt(sha: string): SnapshotFile[] {
  const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", sha], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
  const relevant = tracked.filter(
    (file) =>
      file === "package.json" ||
      file === "package-lock.json" ||
      file === "pnpm-lock.yaml" ||
      file === "yarn.lock" ||
      /\.(?:js|jsx|cjs|mjs|ts|tsx|cts|mts)$/i.test(file),
  );
  return relevant.map((file) => {
    const bytes = execFileSync("git", ["show", `${sha}:${file}`], { maxBuffer: 12 * 1024 * 1024 });
    const text = bytes.toString("utf8");
    return {
      path: file,
      text: text.includes("\uFFFD") ? "" : text,
      size: bytes.byteLength,
      binary: text.includes("\uFFFD"),
    };
  });
}

async function createProtectedRepoFixture(client: SupabaseClient) {
  const nonce = randomUUID();
  const password = `M15.76-local-${randomUUID()}`;
  const authUser = await client.auth.admin.createUser({
    email: `m1576-${nonce}@auterim.local`,
    password,
    email_confirm: true,
    user_metadata: { fixture: "m1576-docker-acceptance" },
  });
  if (authUser.error || !authUser.data.user) throw new Error("m1576_local_auth_fixture_failed");
  const userId = authUser.data.user.id;
  const workspace = await write<{ id: string }>(
    client
      .from("workspaces")
      .insert({ name: `M15.76 QA ${nonce.slice(0, 8)}`, created_by: userId })
      .select("id")
      .single(),
  );
  await writeNoResult(
    client.from("workspace_members").insert({
      workspace_id: workspace.id,
      user_id: userId,
      role: "owner",
    }),
  );
  const product = await write<{ id: string }>(
    client
      .from("workspace_products")
      .insert({
        workspace_id: workspace.id,
        name: "M15.76 protected fixture",
        slug: `m1576-${nonce.slice(0, 16)}`,
        status: "protected",
        protected_at: new Date().toISOString(),
        created_by: userId,
      })
      .select("id")
      .single(),
  );
  const connection = await write<{ id: string }>(
    client
      .from("repository_connections")
      .insert({
        workspace_id: workspace.id,
        provider: "github",
        installation_id: 1_000_000 + Math.floor(Math.random() * 1_000_000),
        account_login: "michelpronkk-oss",
        status: "connected",
        connected_by: userId,
      })
      .select("id")
      .single(),
  );
  const repository = await write<{ id: string }>(
    client
      .from("repositories")
      .insert({
        workspace_id: workspace.id,
        connection_id: connection.id,
        external_id: 2_000_000 + Math.floor(Math.random() * 1_000_000),
        owner: "michelpronkk-oss",
        name: "auterim",
        default_branch: "main",
        private: true,
        selected_for_protection: true,
        status: "available",
      })
      .select("id")
      .single(),
  );
  await writeNoResult(
    client.from("workspace_product_repositories").insert({
      workspace_id: workspace.id,
      protected_product_id: product.id,
      repository_id: repository.id,
      status: "active",
      provenance: "user_selected",
      created_by: userId,
    }),
  );
  return {
    workspaceId: workspace.id,
    productId: product.id,
    repositoryId: repository.id,
    userId,
    email: `m1576-${nonce}@auterim.local`,
    password,
  };
}

async function createCanonicalRouteIntent(
  client: SupabaseClient,
  route: IntelligenceRoute,
  fixture: Awaited<ReturnType<typeof createProtectedRepoFixture>>,
  dependencyIdentity?: { slug: string; name: string; websiteUrl: string },
  reviewRequired = false,
) {
  const nonce = randomUUID();
  const dependencySlug = dependencyIdentity?.slug ?? `m1576-${nonce.slice(0, 16)}`;
  const existingDependency = dependencyIdentity
    ? await client.from("dependency_catalog").select("id").eq("slug", dependencySlug).maybeSingle()
    : { data: null, error: null };
  if (existingDependency.error) throw new Error("m1576_local_fixture_dependency_read_failed");
  const dependency =
    existingDependency.data ??
    (await write<{ id: string }>(
      client
        .from("dependency_catalog")
        .insert({
          slug: dependencySlug,
          name: dependencyIdentity?.name ?? "M15.76 local fixture dependency",
          category: "developer-tools",
          website_url: dependencyIdentity?.websiteUrl ?? "https://fixture.invalid",
        })
        .select("id")
        .single(),
    ));
  await writeNoResult(
    client.from("workspace_dependencies").insert({
      workspace_id: fixture.workspaceId,
      protected_product_id: fixture.productId,
      dependency_id: dependency.id,
      selected_by: fixture.userId,
      origin: "manual",
      monitoring_enabled: true,
      protection_started_at: new Date(Date.now() - 60_000).toISOString(),
    }),
  );
  const source = await write<{ id: string }>(
    client
      .from("source_catalog")
      .insert({
        dependency_id: dependency.id,
        name: `M15.76 fixture ${nonce.slice(0, 8)}`,
        source_type: "changelog",
        url: "https://fixture.invalid/changelog",
        default_interval_seconds: 86_400,
      })
      .select("id")
      .single(),
  );
  const oldText = "Provider SDK before change";
  const newText = "Provider SDK exposes an updated API";
  const oldRunId = randomUUID();
  const runId = randomUUID();
  const oldSnapshotId = randomUUID();
  const newSnapshotId = randomUUID();
  const oldHash = createHash("sha256").update(oldText).digest("hex");
  const newHash = createHash("sha256").update(newText).digest("hex");
  for (const [id, attempt] of [
    [oldRunId, 1],
    [runId, 2],
  ] as const) {
    await writeNoResult(
      client.from("scan_runs").insert({
        id,
        source_id: source.id,
        trigger_run_id: `m1576-${nonce}-${attempt}`,
        attempt_number: 1,
        status: "success",
        finished_at: new Date().toISOString(),
      }),
    );
  }
  await writeNoResult(
    client.from("source_snapshots").insert([
      {
        id: oldSnapshotId,
        source_id: source.id,
        scan_run_id: oldRunId,
        version: 1,
        content_hash: oldHash,
        normalized_content: oldText,
        normalized_bytes: Buffer.byteLength(oldText),
        content_bytes: Buffer.byteLength(oldText),
      },
      {
        id: newSnapshotId,
        source_id: source.id,
        scan_run_id: runId,
        previous_snapshot_id: oldSnapshotId,
        version: 2,
        content_hash: newHash,
        normalized_content: newText,
        normalized_bytes: Buffer.byteLength(newText),
        content_bytes: Buffer.byteLength(newText),
      },
    ]),
  );
  const change = await write<{ id: string }>(
    client
      .from("source_changes")
      .insert({
        source_id: source.id,
        scan_run_id: runId,
        previous_snapshot_id: oldSnapshotId,
        new_snapshot_id: newSnapshotId,
        diff_text: `-${oldText}\n+${newText}`,
        added_lines: 1,
        removed_lines: 1,
        previous_bytes: Buffer.byteLength(oldText),
        new_bytes: Buffer.byteLength(newText),
      })
      .select("id")
      .single(),
  );

  const triggerRunId = `m1576-shadow-${nonce}`;
  const begun = await write<Record<string, unknown>>(
    client.rpc("begin_source_change_intelligence", {
      p_source_change_id: change.id,
      p_trigger_run_id: triggerRunId,
      p_attempt_number: 1,
    }),
  );
  if (begun.status !== "processing" || !begun.change)
    throw new Error("m1576_canonical_decision_not_claimed");
  const evidence = buildIntelligenceEvidence({
    ...(begun.change as Record<string, unknown>),
    sourceUrl: "https://fixture.invalid/changelog",
  } as ClassificationChange);
  const judgment: JevJudgment = {
    route,
    confidence: 1,
    probabilities: {
      material: 1,
      criticalChange: reviewRequired ? 0.96 : 0,
      evidenceSufficient: 1,
      docsNoise: 0,
      requiresEscalation: reviewRequired ? 0.89 : 0,
      route: Object.fromEntries(
        [
          "docs_noise",
          "deprecation",
          "breaking_api_change",
          "auth_or_security_change",
          "schema_or_contract_change",
          "pricing_change",
          "limits_or_quota_change",
          "sdk_change",
          "webhook_or_event_change",
          "feature_change",
          "availability_or_runtime_change",
          "terms_or_policy_change",
          "uncertain",
        ].map((name) => [name, name === route ? 1 : 0]),
      ) as JevJudgment["probabilities"]["route"],
    },
    latencyMs: 1,
    inputTokens: 10,
    outputTokens: 2,
    costUsd: 0,
    responseModel: "typesafe/jev-1.14-20261014",
  };
  const policy = applyIntelligencePolicy({
    classifier: {
      material: true,
      category: "unmapped_fixture",
      confidence: 1,
      decisionStatus: "classified",
    },
    judgment,
    evidenceQuality: evidence.quality,
    thresholds: CALIBRATED_ACTIVE_THRESHOLDS,
  });
  const recorded = await write<Record<string, unknown>>(
    client.rpc("record_source_change_intelligence_v4", {
      p_source_change_id: change.id,
      p_evidence_fingerprint: begun.evidenceFingerprint,
      p_trigger_run_id: triggerRunId,
      p_attempt_number: 1,
      p_route: policy.route,
      p_probabilities: judgment.probabilities,
      p_confidence: judgment.confidence,
      p_evidence_quality: evidence.quality,
      p_proposed_policy_state: policy.state,
      p_policy_reason: policy.reason,
      p_review_disposition: policy.reviewDisposition,
      p_review_reason: policy.reviewReason,
      p_response_model: judgment.responseModel,
      p_policy_mode: "active_calibrated",
      p_active_policy_version: INTELLIGENCE_ACTIVE_POLICY_VERSION,
      p_threshold_version: ACTIVE_THRESHOLD_VERSION,
      p_calibration_corpus_version: CALIBRATION_CORPUS_VERSION,
      p_calibration_version: CALIBRATION_VERSION,
      p_calibration_fixture_count: CALIBRATION_FIXTURE_COUNT,
      p_threshold_fingerprint: activeThresholdFingerprint(),
      p_policy_thresholds: CALIBRATED_ACTIVE_THRESHOLDS,
      p_readiness_metadata: ACTIVE_ROUTING_READINESS,
      p_holdout_metrics: CALIBRATION_HOLDOUT_METRICS,
      p_latency_ms: judgment.latencyMs,
      p_input_tokens: judgment.inputTokens,
      p_output_tokens: judgment.outputTokens,
      p_cost_usd: judgment.costUsd,
    }),
  );
  if (recorded.status !== "completed") throw new Error("m1576_canonical_decision_not_persisted");
  const routeIntent = await write<Record<string, unknown>>(
    client.rpc("persist_intelligence_route_intent", {
      p_source_change_id: change.id,
      p_router_version: "intelligence-router-v1",
    }),
  );
  if (routeIntent.routeStatus !== "pending") throw new Error("m1576_canonical_route_not_pending");
  return { ...routeIntent, sourceChangeId: change.id } as {
    id: string;
    routeTarget: string;
    routeStatus: string;
    sourceChangeId: string;
  };
}

describe.skipIf(!enabled)("M15.76 isolated local Supabase acceptance", () => {
  beforeAll(() => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:57\d{3}$/);
    expect(serviceKey.length).toBeGreaterThan(20);
    expect(anonKey.length).toBeGreaterThan(20);
    expect(commitSha).toMatch(/^[a-f0-9]{40,64}$/);
    expect(previousCommitSha).toMatch(/^[a-f0-9]{40,64}$/);
  });

  it("M15.77 builds an exact-commit graph from canonical route and code-analysis evidence", async () => {
    const client = requireAdmin();
    const fixture = await createProtectedRepoFixture(client);
    const route = await createCanonicalRouteIntent(
      client,
      "sdk_change",
      fixture,
      {
        slug: "openai",
        name: "OpenAI",
        websiteUrl: "https://api.openai.com",
      },
      true,
    );
    const claim = await claimCodeAnalysisRun(
      { ...fixture, commitSha, routeIntentId: route.id },
      client,
    );
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed" || !claim.claimToken)
      throw new Error("m1577_analysis_claim_missing");
    const analysis = analyzeCodeSnapshot(snapshotAt(commitSha));
    await persistCodeAnalysis(
      {
        analysisRunId: claim.analysisRunId,
        ...fixture,
        commitSha,
        claimToken: claim.claimToken,
        result: analysis,
      },
      client,
    );

    const first = await buildImpactGraph({
      routeIntentId: route.id,
      analysisRunId: claim.analysisRunId,
      productId: fixture.productId,
      repositoryId: fixture.repositoryId,
    });
    expect(first.status).toBe("completed");
    expect(first.commitSha).toBe(commitSha);
    expect(first.nodeCount).toBeGreaterThan(0);
    expect(first.edgeCount).toBeGreaterThan(0);

    const graph = await write<{
      id: string;
      workspace_id: string;
      commit_sha: string;
      status: string;
      production_exposure_state: string;
      workspace_dependency_id: string;
      review_disposition: string;
      review_reason: string | null;
    }>(
      client
        .from("impact_graph_builds")
        .select(
          "id,workspace_id,commit_sha,status,production_exposure_state,workspace_dependency_id,review_disposition,review_reason",
        )
        .eq("id", first.graphBuildId)
        .single(),
    );
    expect(graph).toMatchObject({
      workspace_id: fixture.workspaceId,
      commit_sha: commitSha,
      status: "completed",
      production_exposure_state: "unknown",
      review_disposition: "review_required",
      review_reason: "critical_change",
    });
    const dependencyMapping = await write<{
      id: string;
      workspace_id: string;
      protected_product_id: string;
      dependency_id: string;
      monitoring_enabled: boolean;
    }>(
      client
        .from("workspace_dependencies")
        .select("id,workspace_id,protected_product_id,dependency_id,monitoring_enabled")
        .eq("id", graph.workspace_dependency_id)
        .single(),
    );
    expect(dependencyMapping).toMatchObject({
      workspace_id: fixture.workspaceId,
      protected_product_id: fixture.productId,
      monitoring_enabled: true,
    });
    const unrelatedFixture = await createProtectedRepoFixture(client);
    const rows = await write<
      Array<{ edge_type: string; edge_kind: string; evidence_type: string }>
    >(
      client
        .from("impact_graph_edges")
        .select("edge_type,edge_kind,evidence_type")
        .eq("graph_build_id", first.graphBuildId),
    );
    expect(
      rows.some(
        (edge) => edge.edge_type === "REFERENCES_EXTERNAL" && edge.edge_kind === "observed",
      ),
    ).toBe(true);
    const ownerClient = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const ownerSession = await ownerClient.auth.signInWithPassword({
      email: fixture.email,
      password: fixture.password,
    });
    expect(ownerSession.error).toBeNull();
    const ownerRequest = new Request("http://localhost/api/internal/impact-graph", {
      headers: { Authorization: `Bearer ${ownerSession.data.session!.access_token}` },
    });
    const graphRead = await queryImpactGraph(
      { workspaceId: fixture.workspaceId, sourceChangeId: route.sourceChangeId },
      ownerRequest,
    );
    expect(
      graphRead.builds.some(
        (build) =>
          build["id"] === first.graphBuildId &&
          build["workspace_id"] === fixture.workspaceId &&
          build["review_disposition"] === "review_required" &&
          build["review_reason"] === "critical_change",
      ),
    ).toBe(true);
    expect(graphRead.blastRadius.productionExposure).toBe("unknown");
    expect(graphRead.blastRadius.potentiallyAffectedProductCount).toBe(0);
    await expect(
      queryImpactGraph(
        { workspaceId: unrelatedFixture.workspaceId, sourceChangeId: route.sourceChangeId },
        ownerRequest,
      ),
    ).rejects.toThrow("impact_graph_forbidden");
    const unrelatedClient = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const unrelatedSession = await unrelatedClient.auth.signInWithPassword({
      email: unrelatedFixture.email,
      password: unrelatedFixture.password,
    });
    expect(unrelatedSession.error).toBeNull();
    const unrelatedRequest = new Request("http://localhost/api/internal/impact-graph", {
      headers: { Authorization: `Bearer ${unrelatedSession.data.session!.access_token}` },
    });
    const isolatedGraphRead = await queryImpactGraph(
      {
        workspaceId: unrelatedFixture.workspaceId,
        sourceChangeId: route.sourceChangeId,
      },
      unrelatedRequest,
    );
    expect(isolatedGraphRead.builds).toHaveLength(0);

    const replay = await buildImpactGraph({
      routeIntentId: route.id,
      analysisRunId: claim.analysisRunId,
      productId: fixture.productId,
      repositoryId: fixture.repositoryId,
    });
    expect(replay).toMatchObject({
      graphBuildId: first.graphBuildId,
      status: "completed",
      replayed: true,
    });

    const raceA = await write<Record<string, unknown>>(
      client.rpc("claim_impact_graph_build", {
        p_route_intent_id: route.id,
        p_analysis_run_id: claim.analysisRunId,
        p_product_id: fixture.productId,
        p_repository_id: fixture.repositoryId,
        p_graph_builder_version: "impact-graph-race-a",
      }),
    );
    const raceB = await write<Record<string, unknown>>(
      client.rpc("claim_impact_graph_build", {
        p_route_intent_id: route.id,
        p_analysis_run_id: claim.analysisRunId,
        p_product_id: fixture.productId,
        p_repository_id: fixture.repositoryId,
        p_graph_builder_version: "impact-graph-race-b",
      }),
    );
    expect(raceA.status).toBe("claimed");
    expect(raceB.status).toBe("claimed");
    const completedB = await client.rpc("complete_impact_graph_build", {
      p_graph_build_id: raceB.graphBuildId,
      p_claim_token: raceB.claimToken,
      p_expected_nodes: 0,
      p_expected_edges: 0,
      p_assessment_state: "unknown_incomplete",
    });
    expect(completedB.error).toBeNull();
    expect(completedB.data).toBe(true);

    const staleFrom = await write<{ id: string }>(
      client
        .from("impact_graph_nodes")
        .insert({
          graph_build_id: raceA.graphBuildId,
          workspace_id: fixture.workspaceId,
          node_type: "provider_change",
          identity_key: "1".repeat(64),
          normalized_label: "stale temporal fixture",
          analysis_run_id: claim.analysisRunId,
        })
        .select("id")
        .single(),
    );
    const staleTo = await write<{ id: string }>(
      client
        .from("impact_graph_nodes")
        .insert({
          graph_build_id: raceA.graphBuildId,
          workspace_id: fixture.workspaceId,
          node_type: "dependency",
          identity_key: "2".repeat(64),
          normalized_label: "stale dependency fixture",
          analysis_run_id: claim.analysisRunId,
        })
        .select("id")
        .single(),
    );
    await writeNoResult(
      client.from("impact_graph_edges").insert({
        graph_build_id: raceA.graphBuildId,
        workspace_id: fixture.workspaceId,
        analysis_run_id: claim.analysisRunId,
        source_change_id: route.sourceChangeId,
        product_id: fixture.productId,
        repository_id: fixture.repositoryId,
        commit_sha: commitSha,
        from_node_id: staleFrom.id,
        to_node_id: staleTo.id,
        edge_type: "CHANGE_AFFECTS_DEPENDENCY",
        edge_kind: "inferred",
        evidence_type: "dependency_mapping",
        evidence_chain: [{ type: "dependency_mapping", id: "temporal-race" }],
        policy_version: "test-policy",
        graph_builder_version: "impact-graph-race-a",
        confidence_class: "exact",
        edge_fingerprint: "3".repeat(64),
        valid_from: "2000-01-01T00:00:00.000Z",
      }),
    );
    const completedA = await client.rpc("complete_impact_graph_build", {
      p_graph_build_id: raceA.graphBuildId,
      p_claim_token: raceA.claimToken,
      p_expected_nodes: 2,
      p_expected_edges: 1,
      p_assessment_state: "evidence_present",
    });
    expect(completedA.error).toBeNull();
    expect(completedA.data).toBe(true);
    const [staleEdge, latestBuild, staleBuild] = await Promise.all([
      write<{ valid_from: string; valid_until: string | null }>(
        client
          .from("impact_graph_edges")
          .select("valid_from,valid_until")
          .eq("graph_build_id", raceA.graphBuildId)
          .single(),
      ),
      write<{ completed_at: string }>(
        client
          .from("impact_graph_builds")
          .select("completed_at")
          .eq("id", raceB.graphBuildId)
          .single(),
      ),
      write<{ created_at: string }>(
        client
          .from("impact_graph_builds")
          .select("created_at")
          .eq("id", raceA.graphBuildId)
          .single(),
      ),
    ]);
    expect(Date.parse(staleEdge.valid_from)).toBe(Date.parse(staleBuild.created_at));
    expect(Date.parse(staleEdge.valid_until ?? "")).toBe(Date.parse(latestBuild.completed_at));
    const activeStaleEdges = await write<Array<{ id: string }>>(
      client
        .from("impact_graph_edges")
        .select("id")
        .eq("graph_build_id", raceA.graphBuildId)
        .is("valid_until", null),
    );
    expect(activeStaleEdges).toHaveLength(0);
    const currentGraph = await queryImpactGraph(
      { workspaceId: fixture.workspaceId, sourceChangeId: route.sourceChangeId },
      ownerRequest,
    );
    expect(
      currentGraph.builds
        .flatMap((build) => build.edges)
        .some((edge) => edge.graph_build_id === raceA.graphBuildId),
    ).toBe(false);

    const disabled = await ownerClient.rpc("disable_workspace_dependency", {
      p_workspace_id: fixture.workspaceId,
      p_workspace_dependency_id: dependencyMapping.id,
    });
    expect(disabled.error).toBeNull();
    await expect(
      buildImpactGraph({
        routeIntentId: route.id,
        analysisRunId: claim.analysisRunId,
        productId: fixture.productId,
        repositoryId: fixture.repositoryId,
      }),
    ).rejects.toThrow("impact_graph_claim_failed");

    const anonymous = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const denied = await anonymous
      .from("impact_graph_builds")
      .select("id")
      .eq("id", first.graphBuildId);
    expect(denied.error).not.toBeNull();
    const secondWorkspace = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const secondSession = await secondWorkspace.auth.signInWithPassword({
      email: unrelatedFixture.email,
      password: unrelatedFixture.password,
    });
    expect(secondSession.error).toBeNull();
    const crossWorkspaceRead = await secondWorkspace
      .from("impact_graph_builds")
      .select("id")
      .eq("id", first.graphBuildId);
    expect(crossWorkspaceRead.error).not.toBeNull();
    const crossWorkspaceWrite = await secondWorkspace.from("impact_graph_nodes").insert({
      graph_build_id: first.graphBuildId,
      workspace_id: unrelatedFixture.workspaceId,
      node_type: "provider_change",
      identity_key: "a".repeat(64),
      normalized_label: "unauthorized fixture write",
      analysis_run_id: claim.analysisRunId,
    });
    expect(crossWorkspaceWrite.error).not.toBeNull();
  }, 180_000);

  it("persists canonical route handoffs and reusable exact-commit structural facts", async () => {
    const client = requireAdmin();
    const fixture = await createProtectedRepoFixture(client);
    const unrelatedFixture = await createProtectedRepoFixture(client);
    const firstRoute = await createCanonicalRouteIntent(client, "sdk_change", fixture);
    const secondRoute = await createCanonicalRouteIntent(client, "breaking_api_change", fixture);
    const firstTargets = await write<Array<Record<string, unknown>>>(
      client.rpc("list_code_intelligence_route_targets", {
        p_route_intent_id: firstRoute.id,
      }),
    );
    expect(firstTargets).toHaveLength(1);
    expect(firstTargets).toContainEqual(
      expect.objectContaining({
        workspace_id: fixture.workspaceId,
        product_id: fixture.productId,
        repository_id: fixture.repositoryId,
        owner: "michelpronkk-oss",
        name: "auterim",
      }),
    );
    expect(firstTargets).not.toContainEqual(
      expect.objectContaining({
        workspace_id: unrelatedFixture.workspaceId,
        product_id: unrelatedFixture.productId,
        repository_id: unrelatedFixture.repositoryId,
      }),
    );

    const firstClaim = await claimCodeAnalysisRun(
      {
        ...fixture,
        commitSha,
        routeIntentId: firstRoute.id,
      },
      client,
    );
    expect(firstClaim.status).toBe("claimed");
    if (firstClaim.status !== "claimed" || !firstClaim.claimToken)
      throw new Error("m1576_claim_missing");
    const analyzedFiles = snapshotAt(commitSha);
    const analyzed = analyzeCodeSnapshot(analyzedFiles);
    await persistCodeAnalysis(
      {
        analysisRunId: firstClaim.analysisRunId,
        ...fixture,
        commitSha,
        claimToken: firstClaim.claimToken,
        result: analyzed,
      },
      client,
    );

    const replay = await claimCodeAnalysisRun(
      {
        ...fixture,
        commitSha,
        routeIntentId: firstRoute.id,
      },
      client,
    );
    expect(replay).toMatchObject({
      status: "completed",
      analysisRunId: firstClaim.analysisRunId,
      replayed: true,
    });
    const secondHandoff = await claimCodeAnalysisRun(
      {
        ...fixture,
        commitSha,
        routeIntentId: secondRoute.id,
      },
      client,
    );
    expect(secondHandoff).toMatchObject({
      status: "completed",
      analysisRunId: firstClaim.analysisRunId,
      replayed: true,
    });

    const nextCommitClaim = await claimCodeAnalysisRun(
      {
        ...fixture,
        commitSha: previousCommitSha,
      },
      client,
    );
    expect(nextCommitClaim.status).toBe("claimed");
    if (nextCommitClaim.status !== "claimed" || !nextCommitClaim.claimToken)
      throw new Error("m1576_second_commit_claim_missing");
    const previousAnalysis = analyzeCodeSnapshot(snapshotAt(previousCommitSha));
    await persistCodeAnalysis(
      {
        analysisRunId: nextCommitClaim.analysisRunId,
        ...fixture,
        commitSha: previousCommitSha,
        claimToken: nextCommitClaim.claimToken,
        result: previousAnalysis,
      },
      client,
    );

    const runRows = await write<
      Array<{
        id: string;
        commit_sha: string;
        product_id: string | null;
        provider_repository_identity: string;
        coverage_state: string;
        files_discovered: number;
        files_analyzed: number;
        files_skipped: number;
        parse_failures: number;
        supported_files_discovered: number;
        supported_files_analyzed: number;
        supported_files_skipped_by_bound: number;
        unsupported_language_files: number;
        persisted_entity_count: number;
        persisted_relation_count: number;
        persisted_reference_count: number;
        persisted_skip_count: number;
      }>
    >(
      client
        .from("code_analysis_runs")
        .select(
          "id,commit_sha,product_id,provider_repository_identity,coverage_state,files_discovered,files_analyzed,files_skipped,parse_failures,supported_files_discovered,supported_files_analyzed,supported_files_skipped_by_bound,unsupported_language_files,persisted_entity_count,persisted_relation_count,persisted_reference_count,persisted_skip_count",
        )
        .eq("repository_id", fixture.repositoryId)
        .in("commit_sha", [commitSha, previousCommitSha]),
    );
    expect(runRows).toHaveLength(2);
    expect(runRows.map((row) => row.commit_sha).sort()).toEqual(
      [commitSha, previousCommitSha].sort(),
    );
    expect(runRows.every((row) => /^github:\d+$/.test(row.provider_repository_identity))).toBe(
      true,
    );
    expect(runRows.every((row) => row.product_id === null)).toBe(true);
    expect(runRows.every((row) => row.coverage_state !== "failed")).toBe(true);
    expect(runRows.every((row) => row.files_discovered >= row.files_analyzed)).toBe(true);
    expect(runRows.find((row) => row.commit_sha === commitSha)).toMatchObject({
      supported_files_discovered: analyzed.supportedFilesDiscovered,
      supported_files_analyzed: analyzed.supportedFilesAnalyzed,
      supported_files_skipped_by_bound: analyzed.supportedFilesSkippedByBound,
    });
    expect(runRows.find((row) => row.commit_sha === commitSha)).toMatchObject({
      coverage_state: "complete",
    });
    expect(runRows.find((row) => row.commit_sha === commitSha)?.files_skipped).toBe(0);

    const entityCount = await exactCount("code_entities", firstClaim.analysisRunId);
    const referenceRows = await readAll((from, to) =>
      client
        .from("code_external_references")
        .select("normalized_value,redacted,value_fingerprint")
        .eq("analysis_run_id", firstClaim.analysisRunId)
        .order("id")
        .range(from, to),
    );
    const relationCount = await exactCount("code_relations", firstClaim.analysisRunId);
    expect(entityCount).toBeGreaterThan(0);
    expect(relationCount).toBeGreaterThan(0);
    expect(referenceRows.length).toBeGreaterThan(0);
    const exactCounts = await Promise.all(
      [
        ["code_entities", "entities"],
        ["code_relations", "relations"],
        ["code_external_references", "references"],
        ["code_analysis_skipped_files", "skips"],
      ].map(async ([table, label]) => {
        const { count, error } = await client
          .from(table!)
          .select("id", { count: "exact", head: true })
          .eq("analysis_run_id", firstClaim.analysisRunId);
        if (error || count === null) throw new Error("m1576_persisted_count_read_failed");
        return [label!, count] as const;
      }),
    );
    const countMap = Object.fromEntries(exactCounts);
    const persistedRunCounts = await write<{
      persisted_entity_count: number;
      persisted_relation_count: number;
      persisted_reference_count: number;
      persisted_skip_count: number;
      coverage_reason_counts: Record<string, number>;
    }>(
      client
        .from("code_analysis_runs")
        .select(
          "persisted_entity_count,persisted_relation_count,persisted_reference_count,persisted_skip_count,coverage_reason_counts",
        )
        .eq("id", firstClaim.analysisRunId)
        .single(),
    );
    expect(countMap).toEqual({
      entities: persistedRunCounts.persisted_entity_count,
      relations: persistedRunCounts.persisted_relation_count,
      references: persistedRunCounts.persisted_reference_count,
      skips: persistedRunCounts.persisted_skip_count,
    });
    const missingRelationEvidence = await client
      .from("code_relations")
      .select("id", { count: "exact", head: true })
      .eq("analysis_run_id", firstClaim.analysisRunId)
      .is("evidence_path", null);
    expect(missingRelationEvidence.error).toBeNull();
    expect(missingRelationEvidence.count).toBe(0);
    for (const column of ["evidence_start_column", "evidence_end_column"] as const) {
      const missingCoordinate = await client
        .from("code_relations")
        .select("id", { count: "exact", head: true })
        .eq("analysis_run_id", firstClaim.analysisRunId)
        .is(column, null);
      expect(missingCoordinate.error).toBeNull();
      expect(missingCoordinate.count).toBe(0);
    }
    expect(
      referenceRows.every(
        (row) =>
          !row.redacted ||
          (row.normalized_value === "[redacted]" &&
            /^[a-f0-9]{64}$/.test(row.value_fingerprint ?? "")),
      ),
    ).toBe(true);
    expect(
      referenceRows.some((row) =>
        /(?:gh[pousr]_|github_pat_|sk_live_|-----BEGIN .*PRIVATE KEY-----)/i.test(
          row.normalized_value,
        ),
      ),
    ).toBe(false);

    expect(await exactCount("code_entities", firstClaim.analysisRunId)).toBe(entityCount);
    expect(await exactCount("code_relations", firstClaim.analysisRunId)).toBe(relationCount);
    expect(await exactCount("code_external_references", firstClaim.analysisRunId)).toBe(
      countMap.references,
    );
    const referencesMissingCoordinates = await requireAdmin()
      .from("code_external_references")
      .select("id", { count: "exact", head: true })
      .eq("analysis_run_id", firstClaim.analysisRunId)
      .neq("reference_type", "package")
      .or("start_column.is.null,end_column.is.null");
    expect(referencesMissingCoordinates.error).toBeNull();
    expect(referencesMissingCoordinates.count).toBe(0);
    expect(await exactCount("code_analysis_skipped_files", firstClaim.analysisRunId)).toBe(
      countMap.skips,
    );
    const handoffs = await write<Array<{ route_intent_id: string; status: string }>>(
      client
        .from("code_analysis_route_handoffs")
        .select("route_intent_id,status")
        .in("route_intent_id", [firstRoute.id, secondRoute.id]),
    );
    expect(handoffs).toHaveLength(2);
    expect(handoffs.every((handoff) => handoff.status === "completed")).toBe(true);

    const retryArgs = {
      p_workspace_id: fixture.workspaceId,
      p_product_id: fixture.productId,
      p_repository_id: fixture.repositoryId,
      p_commit_sha: commitSha,
      p_analyzer_version: "code-intelligence-retry-fixture-v1",
      p_language_profile: "javascript-typescript-v1",
      p_analysis_profile: "retry-fixture-profile-v1",
      p_idempotency_key: `retry-fixture:${fixture.repositoryId}:${commitSha}`,
      p_route_intent_id: null,
    };
    const firstRetryClaim = await write<Record<string, unknown>>(
      client.rpc("claim_code_analysis_run", retryArgs),
    );
    expect(firstRetryClaim.status).toBe("claimed");
    await expect(
      failCodeAnalysisRun(
        {
          analysisRunId: String(firstRetryClaim.analysisRunId),
          claimToken: "00000000-0000-4000-8000-000000000099",
          failureStage: "analysis_persistence",
          failureCategory: "fixture_terminal_failure",
          retryable: false,
        },
        client,
      ),
    ).rejects.toThrow("code_intelligence_failure_claim_mismatch");
    const afterClaimMismatch = await write<{ status: string; failure_stage: string | null }>(
      client
        .from("code_analysis_runs")
        .select("status,failure_stage")
        .eq("id", firstRetryClaim.analysisRunId)
        .single(),
    );
    expect(afterClaimMismatch).toEqual({ status: "running", failure_stage: null });
    await failCodeAnalysisRun(
      {
        analysisRunId: String(firstRetryClaim.analysisRunId),
        claimToken: String(firstRetryClaim.claimToken),
        failureStage: "analysis_persistence",
        failureCategory: "fixture_transient_failure",
        retryable: true,
      },
      client,
    );
    const retryableState = await write<{
      status: string;
      failure_stage: string | null;
      claim_token: string | null;
      lease_expires_at: string | null;
    }>(
      client
        .from("code_analysis_runs")
        .select("status,failure_stage,claim_token,lease_expires_at")
        .eq("id", firstRetryClaim.analysisRunId)
        .single(),
    );
    expect(retryableState).toMatchObject({
      status: "queued",
      failure_stage: "analysis_persistence",
      claim_token: null,
      lease_expires_at: null,
    });
    const retryClaim = await write<Record<string, unknown>>(
      client.rpc("claim_code_analysis_run", retryArgs),
    );
    expect(retryClaim.status).toBe("claimed");
    const newAttemptState = await write<{ failure_stage: string | null }>(
      client
        .from("code_analysis_runs")
        .select("failure_stage")
        .eq("id", firstRetryClaim.analysisRunId)
        .single(),
    );
    expect(newAttemptState.failure_stage).toBeNull();
    await failCodeAnalysisRun(
      {
        analysisRunId: String(retryClaim.analysisRunId),
        claimToken: String(retryClaim.claimToken),
        failureStage: "analysis_persistence",
        failureCategory: "fixture_terminal_failure",
        retryable: false,
      },
      client,
    );
    const failedReplay = await write<Record<string, unknown>>(
      client.rpc("claim_code_analysis_run", retryArgs),
    );
    expect(failedReplay).toMatchObject({
      status: "failed",
      analysisRunId: firstRetryClaim.analysisRunId,
      replayed: true,
    });
    const retryState = await write<{
      attempt_count: number;
      status: string;
      failure_stage: string | null;
      claim_token: string | null;
      lease_expires_at: string | null;
    }>(
      client
        .from("code_analysis_runs")
        .select("attempt_count,status,failure_stage,claim_token,lease_expires_at")
        .eq("id", firstRetryClaim.analysisRunId)
        .single(),
    );
    expect(retryState).toMatchObject({
      attempt_count: 2,
      status: "failed",
      failure_stage: "analysis_persistence",
      claim_token: null,
      lease_expires_at: null,
    });

    const cleanupArgs = {
      ...retryArgs,
      p_analyzer_version: "cleanup-failure-fixture-v1",
      p_analysis_profile: "cleanup-failure-fixture-v1",
      p_idempotency_key: `cleanup-fixture:${fixture.repositoryId}:${commitSha}`,
    };
    const cleanupClaim = await write<Record<string, unknown>>(
      client.rpc("claim_code_analysis_run", cleanupArgs),
    );
    expect(cleanupClaim.status).toBe("claimed");
    await failCodeAnalysisRun(
      {
        analysisRunId: String(cleanupClaim.analysisRunId),
        claimToken: String(cleanupClaim.claimToken),
        failureStage: null,
        failureCategory: "analysis_failed",
        retryable: false,
        cleanupFailureCategory: "cleanup_failed",
      },
      client,
    );
    const cleanupState = await write<{
      status: string;
      coverage_state: string;
      failure_stage: string | null;
      failure_category: string | null;
      cleanup_failure_category: string | null;
    }>(
      client
        .from("code_analysis_runs")
        .select("status,coverage_state,failure_stage,failure_category,cleanup_failure_category")
        .eq("id", cleanupClaim.analysisRunId)
        .single(),
    );
    expect(cleanupState).toEqual({
      status: "failed",
      coverage_state: "failed",
      failure_stage: null,
      failure_category: "analysis_failed",
      cleanup_failure_category: "cleanup_failed",
    });

    const anonymous = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const denied = await anonymous.from("code_analysis_runs").select("id").limit(1);
    expect(denied.error).not.toBeNull();
    expect(denied.data).toBeNull();
    const authenticated = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signedIn = await authenticated.auth.signInWithPassword({
      email: fixture.email,
      password: fixture.password,
    });
    expect(signedIn.error).toBeNull();
    const authenticatedDenied = await authenticated
      .from("code_analysis_runs")
      .select("id")
      .limit(1);
    expect(authenticatedDenied.error).not.toBeNull();
    expect(authenticatedDenied.data).toBeNull();
    const deniedRpc = await anonymous.rpc("claim_code_analysis_run", {
      p_workspace_id: fixture.workspaceId,
      p_product_id: fixture.productId,
      p_repository_id: fixture.repositoryId,
      p_commit_sha: "f".repeat(40),
      p_analyzer_version: "code-intelligence-v1",
      p_language_profile: "javascript-typescript-v1",
      p_analysis_profile: "javascript-typescript-v1",
      p_idempotency_key: "client-must-not-claim-code-analysis",
      p_route_intent_id: null,
    });
    expect(deniedRpc.error).not.toBeNull();
    const authenticatedDeniedRpc = await authenticated.rpc("claim_code_analysis_run", {
      p_workspace_id: fixture.workspaceId,
      p_product_id: fixture.productId,
      p_repository_id: fixture.repositoryId,
      p_commit_sha: "d".repeat(40),
      p_analyzer_version: "code-intelligence-v1",
      p_language_profile: "javascript-typescript-v1",
      p_analysis_profile: "javascript-typescript-v1",
      p_idempotency_key: "authenticated-client-must-not-claim",
      p_route_intent_id: null,
    });
    expect(authenticatedDeniedRpc.error).not.toBeNull();
    const authenticatedDeniedCompletion = await authenticated.rpc("complete_code_analysis_run_v2", {
      p_analysis_run_id: firstClaim.analysisRunId,
      p_claim_token: randomUUID(),
      p_coverage_state: "complete",
      p_files_discovered: 0,
      p_files_analyzed: 0,
      p_files_skipped: 0,
      p_parse_failures: 0,
      p_bytes_analyzed: 0,
      p_supported_files_discovered: 0,
      p_supported_files_analyzed: 0,
      p_supported_files_skipped_by_bound: 0,
      p_unsupported_language_files: 0,
      p_coverage_reason_counts: {},
      p_persisted_entity_count: 0,
      p_persisted_relation_count: 0,
      p_persisted_reference_count: 0,
      p_persisted_skip_count: 0,
    });
    expect(authenticatedDeniedCompletion.error).not.toBeNull();

    const crossWorkspace = await client.rpc("claim_code_analysis_run", {
      p_workspace_id: randomUUID(),
      p_product_id: fixture.productId,
      p_repository_id: fixture.repositoryId,
      p_commit_sha: "e".repeat(40),
      p_analyzer_version: "code-intelligence-v1",
      p_language_profile: "javascript-typescript-v1",
      p_analysis_profile: "javascript-typescript-v1",
      p_idempotency_key: "wrong-workspace-must-be-denied",
      p_route_intent_id: null,
    });
    expect(crossWorkspace.error).not.toBeNull();
  }, 120_000);

  it("persists every fact for a synthetic analysis exceeding the PostgREST row cap", async () => {
    const client = requireAdmin();
    const fixture = await createProtectedRepoFixture(client);
    const claim = await claimCodeAnalysisRun({ ...fixture, commitSha }, client);
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed" || !claim.claimToken)
      throw new Error("m1576_large_fixture_claim_missing");

    const files: SnapshotFile[] = Array.from({ length: 100 }, (_, fileIndex) => {
      const imports = Array.from(
        { length: 12 },
        (_, importIndex) =>
          `import { item${importIndex} as alias${importIndex} } from "@fixture/pkg-${fileIndex}-${importIndex}";`,
      );
      const functions = Array.from(
        { length: 10 },
        (_, index) => `export function file${fileIndex}Function${index}() { return ${index}; }`,
      );
      const text = [...imports, ...functions].join("\n");
      return {
        path: `src/large-${String(fileIndex).padStart(3, "0")}.ts`,
        text,
        size: Buffer.byteLength(text),
      };
    });
    const result = analyzeCodeSnapshot(files);
    expect(result.entities.length).toBeGreaterThan(1_000);
    expect(result.externalReferences.length).toBeGreaterThan(1_000);
    expect(result.relations.length).toBeGreaterThan(1_000);
    expect(result.coverageState).toBe("complete");

    await persistCodeAnalysis(
      {
        analysisRunId: claim.analysisRunId,
        ...fixture,
        commitSha,
        claimToken: claim.claimToken,
        result,
      },
      client,
    );

    const countRows = async (table: string) => {
      const { count, error } = await client
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("analysis_run_id", claim.analysisRunId);
      if (error || count === null) throw new Error("m1576_large_fixture_count_read_failed");
      return count;
    };
    const [entities, relations, references, skips] = await Promise.all([
      countRows("code_entities"),
      countRows("code_relations"),
      countRows("code_external_references"),
      countRows("code_analysis_skipped_files"),
    ]);
    expect({ entities, relations, references, skips }).toEqual({
      entities: result.entities.length,
      relations: result.relations.length,
      references: result.externalReferences.length,
      skips: result.skippedFiles.length,
    });
    const completed = await write<{
      status: string;
      persisted_entity_count: number;
      persisted_relation_count: number;
      persisted_reference_count: number;
      persisted_skip_count: number;
    }>(
      client
        .from("code_analysis_runs")
        .select(
          "status,persisted_entity_count,persisted_relation_count,persisted_reference_count,persisted_skip_count",
        )
        .eq("id", claim.analysisRunId)
        .single(),
    );
    expect(completed).toEqual({
      status: "completed",
      persisted_entity_count: entities,
      persisted_relation_count: relations,
      persisted_reference_count: references,
      persisted_skip_count: skips,
    });
    const replay = await claimCodeAnalysisRun({ ...fixture, commitSha }, client);
    expect(replay).toMatchObject({
      status: "completed",
      analysisRunId: claim.analysisRunId,
      replayed: true,
    });
  }, 120_000);

  it("fails closed when a selected relation references a missing entity", async () => {
    const client = requireAdmin();
    const fixture = await createProtectedRepoFixture(client);
    const claim = await claimCodeAnalysisRun({ ...fixture, commitSha }, client);
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed" || !claim.claimToken)
      throw new Error("m1576_integrity_fixture_claim_missing");
    const source = "export function first() {}\nexport function second() { first(); }";
    const valid = analyzeCodeSnapshot([
      { path: "src/integrity.ts", text: source, size: Buffer.byteLength(source) },
    ]);
    expect(valid.relations.length).toBeGreaterThan(0);
    const corrupted = {
      ...valid,
      relations: valid.relations.map((relation, index) =>
        index === 0 ? { ...relation, toEntityKey: "missing-entity-key" } : relation,
      ),
    };
    await expect(
      persistCodeAnalysis(
        {
          analysisRunId: claim.analysisRunId,
          ...fixture,
          commitSha,
          claimToken: claim.claimToken,
          result: corrupted,
        },
        client,
      ),
    ).rejects.toThrow("code_intelligence_relation_entity_missing");
    const beforeFailure = await write<{ status: string }>(
      client.from("code_analysis_runs").select("status").eq("id", claim.analysisRunId).single(),
    );
    expect(beforeFailure.status).toBe("running");
    const mismatchedComplete = await client.rpc("complete_code_analysis_run_v2", {
      p_analysis_run_id: claim.analysisRunId,
      p_claim_token: claim.claimToken,
      p_coverage_state: "complete",
      p_files_discovered: valid.filesDiscovered,
      p_files_analyzed: valid.filesAnalyzed,
      p_files_skipped: valid.filesSkipped,
      p_parse_failures: valid.parseFailures,
      p_bytes_analyzed: valid.bytesAnalyzed,
      p_supported_files_discovered: valid.supportedFilesDiscovered,
      p_supported_files_analyzed: valid.supportedFilesAnalyzed,
      p_supported_files_skipped_by_bound: valid.supportedFilesSkippedByBound,
      p_unsupported_language_files: valid.unsupportedLanguageFiles,
      p_coverage_reason_counts: valid.coverageReasonCounts,
      p_persisted_entity_count: 1,
      p_persisted_relation_count: 0,
      p_persisted_reference_count: 0,
      p_persisted_skip_count: 0,
    });
    expect(mismatchedComplete.error).not.toBeNull();
    const afterRejectedCompletion = await write<{ status: string }>(
      client.from("code_analysis_runs").select("status").eq("id", claim.analysisRunId).single(),
    );
    expect(afterRejectedCompletion.status).toBe("running");
    await failCodeAnalysisRun(
      {
        analysisRunId: claim.analysisRunId,
        claimToken: claim.claimToken,
        failureStage: "analysis_persistence",
        failureCategory: "analysis_persistence_failed",
        retryable: false,
      },
      client,
    );
    const afterFailure = await write<{ status: string; coverage_state: string }>(
      client
        .from("code_analysis_runs")
        .select("status,coverage_state")
        .eq("id", claim.analysisRunId)
        .single(),
    );
    expect(afterFailure).toEqual({ status: "failed", coverage_state: "failed" });
  }, 120_000);

  it("rejects completion when a v3 relation lacks source provenance", async () => {
    const client = requireAdmin();
    const fixture = await createProtectedRepoFixture(client);
    const claim = await claimCodeAnalysisRun({ ...fixture, commitSha }, client);
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed" || !claim.claimToken)
      throw new Error("m1576_provenance_fixture_claim_missing");
    const source = "export function first() {}\nexport function second() { first(); }";
    const valid = analyzeCodeSnapshot([
      { path: "src/provenance.ts", text: source, size: Buffer.byteLength(source) },
    ]);
    expect(valid.relations.length).toBeGreaterThan(0);
    const invalidProvenance = {
      ...valid,
      relations: valid.relations.map((relation, index) =>
        index === 0
          ? {
              ...relation,
              evidencePath: null as unknown as string,
              evidenceStartLine: null as unknown as number,
              evidenceEndLine: null as unknown as number,
              extractorType: null as unknown as string,
            }
          : relation,
      ),
    };
    await expect(
      persistCodeAnalysis(
        {
          analysisRunId: claim.analysisRunId,
          ...fixture,
          commitSha,
          claimToken: claim.claimToken,
          result: invalidProvenance,
        },
        client,
      ),
    ).rejects.toThrow("code_intelligence_persistence_failed");
    const afterRejectedCompletion = await write<{ status: string }>(
      client.from("code_analysis_runs").select("status").eq("id", claim.analysisRunId).single(),
    );
    expect(afterRejectedCompletion.status).toBe("running");
    await failCodeAnalysisRun(
      {
        analysisRunId: claim.analysisRunId,
        claimToken: claim.claimToken,
        failureStage: "analysis_persistence",
        failureCategory: "analysis_persistence_failed",
        retryable: false,
      },
      client,
    );
    const failed = await write<{ status: string; coverage_state: string }>(
      client
        .from("code_analysis_runs")
        .select("status,coverage_state")
        .eq("id", claim.analysisRunId)
        .single(),
    );
    expect(failed).toEqual({ status: "failed", coverage_state: "failed" });
  }, 120_000);

  it("rejects v3 completion when a source reference lacks occurrence columns", async () => {
    const client = requireAdmin();
    const fixture = await createProtectedRepoFixture(client);
    const claim = await claimCodeAnalysisRun({ ...fixture, commitSha }, client);
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed" || !claim.claimToken)
      throw new Error("m1576_reference_provenance_fixture_claim_missing");
    const source = 'import Stripe from "stripe";\nconst client = new Stripe("test");';
    const valid = analyzeCodeSnapshot([
      { path: "src/reference.ts", text: source, size: Buffer.byteLength(source) },
    ]);
    const sourceReferenceIndex = valid.externalReferences.findIndex(
      (reference) => reference.referenceType !== "package",
    );
    expect(sourceReferenceIndex).toBeGreaterThanOrEqual(0);
    const invalid = {
      ...valid,
      externalReferences: valid.externalReferences.map((reference, index) =>
        index === sourceReferenceIndex
          ? {
              ...reference,
              startColumn: null as unknown as number,
              endColumn: null as unknown as number,
            }
          : reference,
      ),
    };
    await expect(
      persistCodeAnalysis(
        {
          analysisRunId: claim.analysisRunId,
          ...fixture,
          commitSha,
          claimToken: claim.claimToken,
          result: invalid,
        },
        client,
      ),
    ).rejects.toThrow("code_intelligence_persistence_failed");
    const afterRejectedCompletion = await write<{ status: string }>(
      client.from("code_analysis_runs").select("status").eq("id", claim.analysisRunId).single(),
    );
    expect(afterRejectedCompletion.status).toBe("running");
    await failCodeAnalysisRun(
      {
        analysisRunId: claim.analysisRunId,
        claimToken: claim.claimToken,
        failureStage: "analysis_persistence",
        failureCategory: "analysis_persistence_failed",
        retryable: false,
      },
      client,
    );
  }, 120_000);
});
