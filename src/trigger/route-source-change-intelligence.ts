import { schemaTask, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { getEnvironment } from "@/lib/env/schema";
import { SupabaseIntelligenceRouterRepository } from "@/lib/intelligence/router-repository";
import {
  createCodeAnalysisIdempotencyKey,
  shouldAnalyzeRouteTarget,
} from "@/lib/code-intelligence/analyzer";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { GitHubAppRepositoryProvider } from "@/lib/preflight/github-provider";
import type { RepositoryTarget } from "@/lib/preflight/preflight";
import type { analyzeProtectedRepositoryCodeTask } from "@/trigger/analyze-protected-repository-code";
import type { escalateSourceChangeEvidenceTask } from "@/trigger/escalate-source-change-evidence";

export const routeSourceChangeIntelligenceTask = schemaTask({
  id: "route-source-change-intelligence",
  schema: z.object({ sourceChangeId: z.string().uuid() }),
  retry: {
    maxAttempts: 6,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
    randomize: true,
  },
  concurrency: { total: 4 },
  run: async ({ sourceChangeId }) => {
    if (getEnvironment().AUTERIM_INTELLIGENCE_ROUTER_ENABLED !== "1") {
      return { sourceChangeId, status: "disabled", dispatched: false };
    }
    const repository = new SupabaseIntelligenceRouterRepository();
    const intent = await repository.persistRouteIntent(sourceChangeId);
    if (["suppressed", "completed", "failed"].includes(intent.routeStatus)) {
      return {
        routeIntentId: intent.id,
        route: intent.route,
        policyState: intent.policyState,
        reviewDisposition: intent.reviewDisposition,
        reviewReason: intent.reviewReason,
        routeTarget: intent.routeTarget,
        status: intent.routeStatus,
        dispatched: false,
      };
    }
    if (intent.routeStatus === "pending" && shouldAnalyzeRouteTarget(intent.routeTarget)) {
      const supabase = createSupabaseServerClient();
      const { data, error } = await supabase.rpc("list_code_intelligence_route_targets", {
        p_route_intent_id: intent.id,
      });
      if (error || !Array.isArray(data))
        throw new Error("code_intelligence_route_targets_unavailable");
      if (data.length > 50) throw new Error("code_intelligence_route_target_bound_exceeded");
      const environment = getEnvironment();
      const github = new GitHubAppRepositoryProvider({
        appId: environment.GITHUB_APP_ID,
        privateKey: environment.GITHUB_APP_PRIVATE_KEY,
      });
      let dispatched = 0;
      for (let offset = 0; offset < data.length; offset += 4) {
        const batch = data.slice(offset, offset + 4) as Array<{
          workspace_id: string;
          product_id: string;
          repository_id: string;
          owner: string;
          name: string;
          default_branch: string;
          external_id: number;
          installation_id: number;
        }>;
        await Promise.all(
          batch.map(async (target) => {
            const canonical: RepositoryTarget = {
              id: target.repository_id,
              workspaceId: target.workspace_id,
              owner: target.owner,
              name: target.name,
              defaultBranch: target.default_branch,
              externalId: Number(target.external_id),
              installationId: Number(target.installation_id),
            };
            const commitSha = await github.getHead(canonical);
            const analysisKey = createCodeAnalysisIdempotencyKey({
              repositoryId: target.repository_id,
              commitSha,
            });
            await tasks.trigger<typeof analyzeProtectedRepositoryCodeTask>(
              "analyze-protected-repository-code",
              {
                workspaceId: target.workspace_id,
                productId: target.product_id,
                repositoryId: target.repository_id,
                commitSha,
                routeIntentId: intent.id,
              },
              { idempotencyKey: `code-intelligence-handoff:${intent.id}:${analysisKey}` },
            );
            dispatched += 1;
          }),
        );
      }
      return {
        routeIntentId: intent.id,
        route: intent.route,
        policyState: intent.policyState,
        reviewDisposition: intent.reviewDisposition,
        reviewReason: intent.reviewReason,
        routeTarget: intent.routeTarget,
        status: data.length === 0 ? "no_protected_repository_targets" : "code_analysis_dispatched",
        targetCount: data.length,
        dispatched,
      };
    }
    if (intent.routeTarget !== "evidence_escalation") {
      return {
        routeIntentId: intent.id,
        route: intent.route,
        policyState: intent.policyState,
        reviewDisposition: intent.reviewDisposition,
        reviewReason: intent.reviewReason,
        routeTarget: intent.routeTarget,
        status: intent.routeStatus,
        dispatched: false,
      };
    }
    const claim = await repository.claimRouteDispatch(intent.id);
    if (claim.status === "dispatching") throw new Error("intelligence_route_dispatch_claim_busy");
    if (claim.status !== "claimed") {
      return {
        routeIntentId: intent.id,
        route: intent.route,
        routeTarget: intent.routeTarget,
        status: claim.status,
        dispatched: false,
      };
    }
    try {
      const run = await tasks.trigger<typeof escalateSourceChangeEvidenceTask>(
        "escalate-source-change-evidence",
        { routeIntentId: intent.id },
        { idempotencyKey: claim.idempotencyKey },
      );
      await repository.markRouteDispatched(intent.id, claim.claimToken, run.id);
      return {
        routeIntentId: intent.id,
        route: intent.route,
        routeTarget: intent.routeTarget,
        status: "dispatched",
        dispatched: true,
      };
    } catch {
      await repository.releaseRouteDispatch(
        intent.id,
        claim.claimToken,
        "downstream_enqueue_failed",
      );
      throw new Error("intelligence_route_dispatch_failed");
    }
  },
});
