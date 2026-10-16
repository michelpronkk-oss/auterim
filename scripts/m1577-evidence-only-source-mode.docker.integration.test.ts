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

async function createTarget(db: SupabaseClient, dependencyId: string, label: string) {
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
        workspace_id: workspace.id,
        connection_id: connection.id,
        external_id: 4_000_000 + Math.floor(Math.random() * 1_000_000),
        owner: "fixture-owner",
        name: `repo-${label}`,
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
        category: "sdk_change",
        affectedEntities: ["@supabase/supabase-js"],
        severityHint: "high",
        confidence: 0.99,
        summary: "A material SDK compatibility change.",
        evidence: [{ type: "added", excerpt: excerpt.slice(0, 280) }],
        reasoningSummary: "Bounded local acceptance fixture.",
      },
      inputTokens: 0,
      outputTokens: 0,
    };
  },
};

const judgment: JevJudgment = {
  route: "sdk_change",
  confidence: 0.99,
  probabilities: {
    material: 0.99,
    criticalChange: 0.01,
    evidenceSufficient: 0.99,
    docsNoise: 0.01,
    requiresEscalation: 0.01,
    route: {
      docs_noise: 0.001,
      deprecation: 0.001,
      breaking_api_change: 0.001,
      auth_or_security_change: 0.001,
      schema_or_contract_change: 0.001,
      pricing_change: 0.001,
      limits_or_quota_change: 0.001,
      sdk_change: 0.99,
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
    expect(url).toBe("http://127.0.0.1:57521");
    expect(commitSha).toMatch(/^[a-f0-9]{40,64}$/);
    const dependency = await row(
      client
        .from("dependency_catalog")
        .insert({
          slug: `m1577-evidence-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
          name: "M15.77 evidence mode fixture dependency",
          category: "developer-tools",
          website_url: "https://fixture.invalid",
        })
        .select("id")
        .single(),
    );
    const targetA = await createTarget(client, dependency.id, "a");
    const targetB = await createTarget(client, dependency.id, "b");
    const anonClient = createClient(url, process.env.AUTERIM_M1576_ANON_KEY ?? "", {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const anonymousCreate = await anonClient.rpc("create_internal_test_source", {
      p_workspace_id: targetA.workspaceId,
      p_product_id: targetA.productId,
      p_dependency_id: dependency.id,
      p_internal_key: `anon-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    });
    expect(anonymousCreate.error).not.toBeNull();
    const providerSource = await row(
      client
        .from("source_catalog")
        .insert({
          dependency_id: dependency.id,
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
      dependencyId: dependency.id,
      acceptanceKey: `m1577-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      baseline: "The SDK supports the existing response contract.",
      changed: "The SDK removes the existing response contract and requires a migration.",
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
        .select("id,source_change_id,workspace_id,scope_product_id,route_target,route_status")
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
    });
    expect(internalIntent).toMatchObject({
      workspace_id: targetA.workspaceId,
      scope_product_id: targetA.productId,
      route_status: "pending",
    });

    const exactFiles: SnapshotFile[] = ["package.json", "src/lib/supabase/server.ts"].map(
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
    const graphRow = await row(
      client
        .from("impact_graph_builds")
        .select("workspace_id,product_id,repository_id,commit_sha,production_exposure_state,status")
        .eq("id", graph.graphBuildId)
        .single(),
    );
    expect(graphRow).toMatchObject({
      workspace_id: targetA.workspaceId,
      product_id: targetA.productId,
      commit_sha: commitSha,
      production_exposure_state: "unknown",
      status: "completed",
    });
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
