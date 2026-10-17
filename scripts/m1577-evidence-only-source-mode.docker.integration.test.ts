import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { persistInternalTestSourceChange } from "@/lib/monitoring/internal-test-source";
import { scanSource } from "@/lib/monitoring/scan";
import { classifySourceChange, type SemanticClassifier } from "@/lib/monitoring/classification";
import { evaluateSourceChangeIntelligence } from "@/lib/intelligence/decision";
import { SupabaseIntelligenceRouterRepository } from "@/lib/intelligence/router-repository";
import { customerImpactDispatchAllowed } from "@/lib/monitoring/source-mode";
import type { JevJudgment } from "@/lib/intelligence/taxonomy";
import { analyzeCodeSnapshot, type SnapshotFile } from "@/lib/code-intelligence/analyzer";
import { claimCodeAnalysisRun, persistCodeAnalysis } from "@/lib/code-intelligence/service";
import { buildImpactGraph } from "@/lib/impact-graph/repository";

const enabled = process.env.AUTERIM_M1577_POLICY_DOCKER_ACCEPTANCE === "1";
if (!enabled) throw new Error("m1577_evidence_mode_docker_guard_required");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey = process.env.AUTERIM_M15_LOCAL_SUPABASE_SECRET_KEY ?? "";
const commitSha = process.env.AUTERIM_M1576_FIXTURE_COMMIT_SHA ?? "";
const client =
  enabled && url && serviceKey
    ? createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
    : null;

const canonicalFixture = {
  workspaceId: "e140d48e-9dc0-4552-a9a4-a81fe3872422",
  productId: "de1f2a12-de3c-4644-8892-b6c2d458a300",
  dependencyId: "3cfb1bb7-1d76-4692-932b-24e94b66f346",
  workspaceDependencyId: "867eb92b-2ed2-4917-ac68-44a22773e369",
  repositoryId: "b2abf377-2dbc-4b9c-b546-b0604f3ee4fe",
  productRepositoryId: "ed0fa73d-3dd2-46b4-a8bd-a603919e01a0",
};

// The Supabase test client has no generated Database type here; fixture assertions validate each returned shape.
/* eslint-disable @typescript-eslint/no-explicit-any */
async function row(
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<any> {
  const result = await query;
  if (result.error || result.data === null) throw new Error("m1577_evidence_mode_fixture_failed");
  return result.data as any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function noError(query: PromiseLike<{ error: { message: string } | null }>) {
  const result = await query;
  if (result.error) throw new Error("m1577_evidence_mode_fixture_failed");
}

async function createTarget(
  db: SupabaseClient,
  dependencyId: string,
  label: string,
  identity?: typeof canonicalFixture,
) {
  const nonce = randomUUID();
  const user = await db.auth.admin.createUser({
    email: `m1577-evidence-${nonce}@auterim.local`,
    password: randomUUID(),
    email_confirm: true,
  });
  if (user.error || !user.data.user) throw new Error("m1577_evidence_mode_fixture_failed");
  const workspace = await row(
    db
      .from("workspaces")
      .insert({
        ...(identity ? { id: identity.workspaceId } : {}),
        name: `M15.77 evidence ${label}`,
        created_by: user.data.user.id,
      })
      .select("id")
      .single(),
  );
  await noError(
    db.from("workspace_members").insert({
      workspace_id: workspace.id,
      user_id: user.data.user.id,
      role: "owner",
    }),
  );
  const product = await row(
    db
      .from("workspace_products")
      .insert({
        ...(identity ? { id: identity.productId } : {}),
        workspace_id: workspace.id,
        name: `Evidence ${label}`,
        slug: `m1577-evidence-${nonce.slice(0, 10)}`,
        status: "protected",
        protected_at: new Date(Date.now() - 60_000).toISOString(),
        created_by: user.data.user.id,
      })
      .select("id")
      .single(),
  );
  const connection = await row(
    db
      .from("repository_connections")
      .insert({
        workspace_id: workspace.id,
        provider: "github",
        installation_id: 3_000_000 + Math.floor(Math.random() * 1_000_000),
        account_login: "fixture-owner",
        status: "connected",
        connected_by: user.data.user.id,
      })
      .select("id")
      .single(),
  );
  const repository = await row(
    db
      .from("repositories")
      .insert({
        ...(identity ? { id: identity.repositoryId } : {}),
        workspace_id: workspace.id,
        connection_id: connection.id,
        external_id: 4_000_000 + Math.floor(Math.random() * 1_000_000),
        owner: identity ? "michelpronkk-oss" : "fixture-owner",
        name: identity ? "auterim-m15-github-qa" : `repo-${label}`,
        default_branch: "main",
        private: true,
        selected_for_protection: true,
        status: "available",
      })
      .select("id")
      .single(),
  );
  await noError(
    db.from("workspace_product_repositories").insert({
      ...(identity ? { id: identity.productRepositoryId } : {}),
      workspace_id: workspace.id,
      protected_product_id: product.id,
      repository_id: repository.id,
      status: "active",
      provenance: "user_selected",
      created_by: user.data.user.id,
    }),
  );
  await noError(
    db.from("workspace_dependencies").insert({
      ...(identity ? { id: identity.workspaceDependencyId } : {}),
      workspace_id: workspace.id,
      protected_product_id: product.id,
      dependency_id: dependencyId,
      selected_by: user.data.user.id,
      origin: "manual",
      monitoring_enabled: true,
      protection_started_at: new Date(Date.now() - 60_000).toISOString(),
    }),
  );
  return { workspaceId: workspace.id as string, productId: product.id as string };
}

function controlledFetcher(body: string) {
  return async () => ({
    status: 200,
    body: Buffer.from(body),
    bytesRead: Buffer.byteLength(body),
    bodyTruncated: false,
    contentType: "text/plain",
    safeHeaders: {},
    etag: null,
    lastModified: null,
    finalUrl: "https://fixture.invalid/changelog",
  });
}

const classifier: SemanticClassifier = {
  providerId: "openai",
  modelId: "m1577-evidence-mode-fixture-v1",
  async classify(packet) {
    const excerpt = packet.currentEvidence.split("\n").at(-1) ?? "SDK compatibility change";
    return {
      classification: {
        material: true,
        category: "deprecation",
        affectedEntities: ["POST https://api.openai.com/v1/responses"],
        severityHint: "high",
        confidence: 0.99,
        summary: "A material endpoint deprecation.",
        evidence: [{ type: "added", excerpt: excerpt.slice(0, 280) }],
        reasoningSummary: "Bounded local acceptance fixture.",
      },
      inputTokens: 0,
      outputTokens: 0,
    };
  },
};

const judgment: JevJudgment = {
  route: "deprecation",
  confidence: 0.99,
  probabilities: {
    material: 0.99,
    criticalChange: 0.96,
    evidenceSufficient: 0.99,
    docsNoise: 0.01,
    requiresEscalation: 0.89,
    route: {
      docs_noise: 0.001,
      deprecation: 0.99,
      breaking_api_change: 0.001,
      auth_or_security_change: 0.001,
      schema_or_contract_change: 0.001,
      pricing_change: 0.001,
      limits_or_quota_change: 0.001,
      sdk_change: 0.001,
      webhook_or_event_change: 0.001,
      feature_change: 0.001,
      availability_or_runtime_change: 0.001,
      terms_or_policy_change: 0.001,
      uncertain: 0.001,
    },
  },
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  latencyMs: 0,
  responseModel: "m1577-evidence-mode-fixture-v1",
};

describe("M15.77 internal evidence-only source mode on local Docker Supabase", () => {
  it("keeps provider routing global while evidence-only routing and customer actions stay scoped off", async () => {
    if (!client) throw new Error("m1577_evidence_mode_docker_guard_required");
    expect(url).toBe(process.env.AUTERIM_M1578_EXPECTED_URL ?? "http://127.0.0.1:57521");
    expect(commitSha).toMatch(/^[a-f0-9]{40,64}$/);
    const existingDependency = await client
      .from("dependency_catalog")
      .select("id")
      .eq("id", canonicalFixture.dependencyId)
      .maybeSingle();
    if (existingDependency.error) throw new Error("m1577_openai_dependency_read_failed");
    let dependencyId: string;
    if (existingDependency.data) {
      dependencyId = existingDependency.data.id;
    } else {
      const inserted: { id: string } = await row(
        client
          .from("dependency_catalog")
          .insert({
            id: canonicalFixture.dependencyId,
            slug: "openai-m1577-canonical-fixture",
            name: "OpenAI",
            category: "developer-tools",
            website_url: "https://api.openai.com",
          })
          .select("id")
          .single(),
      );
      dependencyId = inserted.id;
    }
    const targetA = await createTarget(client, dependencyId, "a", canonicalFixture);
    const targetB = await createTarget(client, dependencyId, "b");
    const anonClient = createClient(url, process.env.AUTERIM_M1576_ANON_KEY ?? "", {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const anonymousCreate = await anonClient.rpc("create_internal_test_source", {
      p_workspace_id: targetA.workspaceId,
      p_product_id: targetA.productId,
      p_dependency_id: dependencyId,
      p_internal_key: `anon-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    });
    expect(anonymousCreate.error).not.toBeNull();
    const providerSource = await row(
      client
        .from("source_catalog")
        .insert({
          dependency_id: dependencyId,
          name: `Provider fixture ${randomUUID().slice(0, 8)}`,
          source_type: "changelog",
          url: "https://fixture.invalid/provider-changelog",
        })
        .select("id")
        .single(),
    );
    const providerBaseline = await scanSource(
      {
        sourceId: providerSource.id,
        triggerRunId: `m1577-provider:${randomUUID()}:base`,
        attemptNumber: 1,
      },
      {
        fetcher: controlledFetcher("Existing provider SDK behavior."),
        enqueueClassifier: async () => undefined,
        enqueueIntelligence: async () => undefined,
      },
    );
    expect(providerBaseline.status).toBe("success");
    const providerChange = await scanSource(
      {
        sourceId: providerSource.id,
        triggerRunId: `m1577-provider:${randomUUID()}:change`,
        attemptNumber: 1,
      },
      {
        fetcher: controlledFetcher("Provider SDK compatibility changes in the new release."),
        enqueueClassifier: async () => undefined,
        enqueueIntelligence: async () => undefined,
      },
    );
    expect(providerChange.status).toBe("changed");
    if (!providerChange.changeId) throw new Error("m1577_provider_change_missing");

    const internal = await persistInternalTestSourceChange({
      workspaceId: targetA.workspaceId,
      productId: targetA.productId,
      dependencyId,
      acceptanceKey: `m1577-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      baseline:
        "POST https://api.openai.com/v1/responses is available and applications may send Responses API requests to this endpoint.",
      changed:
        "POST https://api.openai.com/v1/responses is removed in the next API version. Applications using this endpoint must migrate before upgrading because requests to the existing endpoint will no longer work.",
    });
    const internalChange = await row(
      client
        .from("source_changes")
        .select("id,source_mode,processing_mode,workspace_id,scope_product_id")
        .eq("id", internal.sourceChangeId)
        .single(),
    );
    expect(internalChange).toMatchObject({
      source_mode: "internal_test",
      processing_mode: "evidence_only",
      workspace_id: targetA.workspaceId,
      scope_product_id: targetA.productId,
    });
    const source = await row(
      client
        .from("source_catalog")
        .select("source_mode,processing_mode,workspace_id,scope_product_id")
        .eq("id", internal.sourceId)
        .single(),
    );
    expect(source).toMatchObject({
      source_mode: internalChange.source_mode,
      processing_mode: internalChange.processing_mode,
      workspace_id: internalChange.workspace_id,
      scope_product_id: internalChange.scope_product_id,
    });

    for (const sourceChangeId of [providerChange.changeId, internal.sourceChangeId]) {
      const result = await classifySourceChange(
        {
          changeId: sourceChangeId,
          triggerRunId: `m1577-classify:${randomUUID()}`,
          attemptNumber: 1,
        },
        { classifier },
      );
      expect(result.status).toBe("classified");
      const outcome = await evaluateSourceChangeIntelligence(
        { sourceChangeId, triggerRunId: `m1577-jev:${randomUUID()}`, attemptNumber: 1 },
        {
          evaluator: async () => judgment,
          enqueueRoute: async (id) => {
            await new SupabaseIntelligenceRouterRepository().persistRouteIntent(id);
          },
        },
      );
      expect(outcome.status).toBe("completed");
    }

    const intents = await row(
      client
        .from("intelligence_route_intents")
        .select(
          "id,source_change_id,workspace_id,scope_product_id,route,route_target,route_status,review_disposition,review_reason",
        )
        .in("source_change_id", [providerChange.changeId, internal.sourceChangeId]),
    );
    const providerIntent = intents.find(
      (intent: { source_change_id: string }) => intent.source_change_id === providerChange.changeId,
    )!;
    const internalIntent = intents.find(
      (intent: { source_change_id: string }) => intent.source_change_id === internal.sourceChangeId,
    )!;
    expect(providerIntent).toMatchObject({
      workspace_id: null,
      scope_product_id: null,
      route_status: "pending",
      review_disposition: "review_required",
      review_reason: "critical_change",
    });
    expect(internalIntent).toMatchObject({
      workspace_id: targetA.workspaceId,
      scope_product_id: targetA.productId,
      route: "deprecation",
      route_target: "dependency_product_impact",
      route_status: "pending",
      review_disposition: "review_required",
      review_reason: "critical_change",
    });
    const attemptedIntentReviewRewrite = await client
      .from("intelligence_route_intents")
      .update({ review_disposition: "none", review_reason: null })
      .eq("id", internalIntent.id);
    expect(attemptedIntentReviewRewrite.error).not.toBeNull();

    const exactFiles: SnapshotFile[] = ["package.json", "src/lib/monitoring/classification.ts"].map(
      (path) => {
        const bytes = execFileSync("git", ["show", `${commitSha}:${path}`], {
          maxBuffer: 1_000_000,
        });
        const text = bytes.toString("utf8");
        return { path, text, size: bytes.byteLength, binary: false };
      },
    );
    const claim = await claimCodeAnalysisRun(
      {
        workspaceId: targetA.workspaceId,
        productId: targetA.productId,
        repositoryId: (
          await row(
            client
              .from("workspace_product_repositories")
              .select("repository_id")
              .eq("workspace_id", targetA.workspaceId)
              .eq("protected_product_id", targetA.productId)
              .single(),
          )
        ).repository_id,
        commitSha,
        routeIntentId: internalIntent.id,
      },
      client,
    );
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed" || !claim.claimToken)
      throw new Error("m1577_evidence_analysis_claim_failed");
    const analysis = analyzeCodeSnapshot(exactFiles);
    const endpointFact = analysis.externalReferences.find(
      (reference) =>
        reference.referenceType === "endpoint" &&
        reference.normalizedValue === "https://api.openai.com/v1/responses",
    );
    expect(endpointFact).toMatchObject({
      path: "src/lib/monitoring/classification.ts",
      startLine: 114,
      endLine: 114,
      confidenceClass: "exact",
    });
    await persistCodeAnalysis(
      {
        analysisRunId: claim.analysisRunId,
        workspaceId: targetA.workspaceId,
        repositoryId: (
          await row(
            client
              .from("workspace_product_repositories")
              .select("repository_id")
              .eq("workspace_id", targetA.workspaceId)
              .eq("protected_product_id", targetA.productId)
              .single(),
          )
        ).repository_id,
        commitSha,
        claimToken: claim.claimToken,
        result: analysis,
      },
      client,
    );
    const graph = await buildImpactGraph({
      routeIntentId: internalIntent.id,
      analysisRunId: claim.analysisRunId,
      productId: targetA.productId,
      repositoryId: (
        await row(
          client
            .from("workspace_product_repositories")
            .select("repository_id")
            .eq("workspace_id", targetA.workspaceId)
            .eq("protected_product_id", targetA.productId)
            .single(),
        )
      ).repository_id,
    });
    expect(graph.status).toBe("completed");
    const repositoryId = (
      await row(
        client
          .from("workspace_product_repositories")
          .select("repository_id")
          .eq("workspace_id", targetA.workspaceId)
          .eq("protected_product_id", targetA.productId)
          .single(),
      )
    ).repository_id as string;
    const beforeReplay = await Promise.all(
      ["impact_graph_builds", "impact_graph_nodes", "impact_graph_edges"].map(async (table) => {
        const result = await client
          .from(table)
          .select("id", { count: "exact", head: true })
          .eq(
            table === "impact_graph_builds" ? "route_intent_id" : "graph_build_id",
            table === "impact_graph_builds" ? internalIntent.id : graph.graphBuildId,
          );
        if (result.error || result.count === null)
          throw new Error("m1577_graph_idempotency_count_unavailable");
        return result.count;
      }),
    );
    const replay = await buildImpactGraph({
      routeIntentId: internalIntent.id,
      analysisRunId: claim.analysisRunId,
      productId: targetA.productId,
      repositoryId,
    });
    expect(replay).toMatchObject({
      graphBuildId: graph.graphBuildId,
      status: "completed",
      replayed: true,
    });
    const afterReplay = await Promise.all(
      ["impact_graph_builds", "impact_graph_nodes", "impact_graph_edges"].map(async (table) => {
        const result = await client
          .from(table)
          .select("id", { count: "exact", head: true })
          .eq(
            table === "impact_graph_builds" ? "route_intent_id" : "graph_build_id",
            table === "impact_graph_builds" ? internalIntent.id : graph.graphBuildId,
          );
        if (result.error || result.count === null)
          throw new Error("m1577_graph_idempotency_count_unavailable");
        return result.count;
      }),
    );
    expect(afterReplay).toEqual(beforeReplay);
    const exactReference = await row(
      client
        .from("code_external_references")
        .select("id,path,start_line,normalized_value,reference_type")
        .eq("analysis_run_id", claim.analysisRunId)
        .eq("reference_type", "endpoint")
        .eq("normalized_value", "https://api.openai.com/v1/responses")
        .single(),
    );
    expect(exactReference).toMatchObject({
      path: "src/lib/monitoring/classification.ts",
      start_line: 114,
      reference_type: "endpoint",
      normalized_value: "https://api.openai.com/v1/responses",
    });
    const graphEdges = await row(
      client
        .from("impact_graph_edges")
        .select(
          "edge_type,edge_kind,code_reference_id,evidence_path,evidence_start_line,evidence_chain",
        )
        .eq("graph_build_id", graph.graphBuildId),
    );
    expect(graphEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edge_type: "REFERENCES_EXTERNAL",
          edge_kind: "observed",
          code_reference_id: exactReference.id,
          evidence_path: "src/lib/monitoring/classification.ts",
          evidence_start_line: 114,
        }),
        expect.objectContaining({
          edge_type: "CHANGE_AFFECTS_ENDPOINT",
          edge_kind: "inferred",
          code_reference_id: exactReference.id,
        }),
        expect.objectContaining({
          edge_type: "PRODUCT_POTENTIALLY_AFFECTED_BY_CHANGE",
          edge_kind: "inferred",
          evidence_chain: expect.arrayContaining([
            expect.objectContaining({ type: "workspace_product_repository" }),
          ]),
        }),
      ]),
    );
    const graphRow = await row(
      client
        .from("impact_graph_builds")
        .select(
          "workspace_id,product_id,repository_id,commit_sha,production_exposure_state,review_disposition,review_reason,status",
        )
        .eq("id", graph.graphBuildId)
        .single(),
    );
    expect(graphRow).toMatchObject({
      workspace_id: targetA.workspaceId,
      product_id: targetA.productId,
      commit_sha: commitSha,
      production_exposure_state: "unknown",
      review_disposition: "review_required",
      review_reason: "critical_change",
      status: "completed",
    });
    const attemptedReviewRewrite = await client
      .from("impact_graph_builds")
      .update({ review_disposition: "none", review_reason: null })
      .eq("id", graph.graphBuildId);
    expect(attemptedReviewRewrite.error).not.toBeNull();
    await expect(
      claimCodeAnalysisRun(
        {
          workspaceId: targetB.workspaceId,
          productId: targetB.productId,
          repositoryId: (
            await row(
              client
                .from("workspace_product_repositories")
                .select("repository_id")
                .eq("workspace_id", targetB.workspaceId)
                .eq("protected_product_id", targetB.productId)
                .single(),
            )
          ).repository_id,
          commitSha,
          routeIntentId: internalIntent.id,
        },
        client,
      ),
    ).rejects.toThrow();

    const router = new SupabaseIntelligenceRouterRepository();
    const providerTargets = await row(
      client.rpc("list_code_intelligence_route_targets", {
        p_route_intent_id: (await router.persistRouteIntent(providerChange.changeId)).id,
      }),
    );
    const internalTargets = await row(
      client.rpc("list_code_intelligence_route_targets", {
        p_route_intent_id: internalIntent.id,
      }),
    );
    expect(
      providerTargets.map((item: { workspace_id: string }) => item.workspace_id).sort(),
    ).toEqual([targetA.workspaceId, targetB.workspaceId].sort());
    expect(internalTargets).toHaveLength(1);
    expect(internalTargets[0]).toMatchObject({
      workspace_id: targetA.workspaceId,
      product_id: targetA.productId,
      repository_id: repositoryId,
    });
    expect(
      customerImpactDispatchAllowed({ source_mode: "provider", processing_mode: "customer" }),
    ).toBe(true);
    expect(
      customerImpactDispatchAllowed({
        source_mode: "internal_test",
        processing_mode: "evidence_only",
      }),
    ).toBe(false);
    expect(() =>
      customerImpactDispatchAllowed({
        source_mode: "internal_test",
        processing_mode: "customer",
      }),
    ).toThrow();

    const providerClassification = await row(
      client
        .from("source_change_classifications")
        .select("id")
        .eq("change_id", providerChange.changeId)
        .single(),
    );
    const internalClassification = await row(
      client
        .from("source_change_classifications")
        .select("id")
        .eq("change_id", internal.sourceChangeId)
        .single(),
    );
    const providerQueue = await row(
      client
        .from("customer_impact_dispatch_queue")
        .select("id")
        .eq("source_change_classification_id", providerClassification.id),
    );
    const internalQueue = await row(
      client
        .from("customer_impact_dispatch_queue")
        .select("id")
        .eq("source_change_classification_id", internalClassification.id),
    );
    expect(providerQueue).toHaveLength(2);
    expect(internalQueue).toEqual([]);
    for (const table of [
      "impact_assessments",
      "preflight_runs",
      "notifications",
      "remediation_proposals",
    ]) {
      const rows = await row(client.from(table).select("id").limit(1));
      expect(rows).toEqual([]);
    }
    const due = await row(
      client.rpc("list_due_source_ids", { p_now: new Date().toISOString(), p_limit: 100 }),
    );
    expect(due.some((item: { source_id: string }) => item.source_id === internal.sourceId)).toBe(
      false,
    );
  });
});
