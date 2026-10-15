import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { applyIntelligencePolicy } from "@/lib/intelligence/policy";
import { buildIntelligenceEvidence } from "@/lib/intelligence/evidence";
import { INITIAL_SHADOW_THRESHOLDS } from "@/lib/intelligence/decision";
import type { ClassificationChange } from "@/lib/monitoring/classification";
import type { JevJudgment, IntelligenceRoute } from "@/lib/intelligence/taxonomy";
import { analyzeCodeSnapshot, type SnapshotFile } from "@/lib/code-intelligence/analyzer";
import {
  claimCodeAnalysisRun,
  failCodeAnalysisRun,
  persistCodeAnalysis,
} from "@/lib/code-intelligence/service";

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
) {
  const nonce = randomUUID();
  const dependency = await write<{ id: string }>(
    client
      .from("dependency_catalog")
      .insert({
        slug: `m1576-${nonce.slice(0, 16)}`,
        name: "M15.76 local fixture dependency",
        category: "developer-tools",
        website_url: "https://fixture.invalid",
      })
      .select("id")
      .single(),
  );
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
      criticalChange: 0,
      evidenceSufficient: 1,
      docsNoise: 0,
      requiresEscalation: 0,
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
    thresholds: INITIAL_SHADOW_THRESHOLDS,
  });
  const recorded = await write<Record<string, unknown>>(
    client.rpc("record_source_change_intelligence_v2", {
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
      p_response_model: judgment.responseModel,
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
  return routeIntent as { id: string; routeTarget: string; routeStatus: string };
}

describe.skipIf(!enabled)("M15.76 isolated local Supabase acceptance", () => {
  beforeAll(() => {
    expect(url).toBe("http://127.0.0.1:57421");
    expect(serviceKey.length).toBeGreaterThan(20);
    expect(anonKey.length).toBeGreaterThan(20);
    expect(commitSha).toMatch(/^[a-f0-9]{40,64}$/);
    expect(previousCommitSha).toMatch(/^[a-f0-9]{40,64}$/);
  });

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
      }>
    >(
      client
        .from("code_analysis_runs")
        .select(
          "id,commit_sha,product_id,provider_repository_identity,coverage_state,files_discovered,files_analyzed,files_skipped,parse_failures",
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
      coverage_state: "partial",
    });
    expect(runRows.find((row) => row.commit_sha === commitSha)?.files_skipped).toBeGreaterThan(0);

    const entityCount = await write<Array<{ id: string }>>(
      client.from("code_entities").select("id").eq("analysis_run_id", firstClaim.analysisRunId),
    );
    const referenceRows = await write<
      Array<{ normalized_value: string; redacted: boolean; value_fingerprint: string | null }>
    >(
      client
        .from("code_external_references")
        .select("normalized_value,redacted,value_fingerprint")
        .eq("analysis_run_id", firstClaim.analysisRunId),
    );
    const relationCount = await write<Array<{ id: string }>>(
      client.from("code_relations").select("id").eq("analysis_run_id", firstClaim.analysisRunId),
    );
    expect(entityCount.length).toBeGreaterThan(0);
    expect(relationCount.length).toBeGreaterThan(0);
    expect(referenceRows.length).toBeGreaterThan(0);
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

    const factsAfterReplay = await write<Array<{ id: string }>>(
      client.from("code_entities").select("id").eq("analysis_run_id", firstClaim.analysisRunId),
    );
    expect(factsAfterReplay).toHaveLength(entityCount.length);
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
    await failCodeAnalysisRun(
      {
        analysisRunId: String(firstRetryClaim.analysisRunId),
        claimToken: String(firstRetryClaim.claimToken),
        failureCategory: "fixture_transient_failure",
        retryable: true,
      },
      client,
    );
    const retryClaim = await write<Record<string, unknown>>(
      client.rpc("claim_code_analysis_run", retryArgs),
    );
    expect(retryClaim.status).toBe("claimed");
    await failCodeAnalysisRun(
      {
        analysisRunId: String(retryClaim.analysisRunId),
        claimToken: String(retryClaim.claimToken),
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
    const retryState = await write<{ attempt_count: number; status: string }>(
      client
        .from("code_analysis_runs")
        .select("attempt_count,status")
        .eq("id", firstRetryClaim.analysisRunId)
        .single(),
    );
    expect(retryState).toEqual({ attempt_count: 2, status: "failed" });

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
});
