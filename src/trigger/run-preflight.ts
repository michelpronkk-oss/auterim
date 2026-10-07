import { AbortTaskRunError, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { runPreflight } from "@/lib/preflight/preflight-service";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveWorkspaceEntitlementsForService } from "@/lib/billing/server";
import { createPinnedFixtureRepositoryProvider } from "@/lib/m15/persisted-preflight-acceptance";
import {
  logM15LocalTaskOutcome,
  waitForM15LocalAcceptancePreClaimGate,
} from "@/lib/m15/local-trigger-proof";

function fixtureProvider() {
  if (process.env.NODE_ENV === "production" || process.env.AUTERIM_M15_LOCAL_INTEGRATION !== "1") {
    return undefined;
  }
  return createPinnedFixtureRepositoryProvider({
    outcome: "verified",
    commitSha: "a".repeat(40),
    affectedEntity: "fixture-client",
    filePath: "src/client.ts",
    fileContents:
      'export const configuredEntity = "fixture-client"; const legacyClient = { send: () => "old" }; const modernClient = { send: () => "new" }; export const client = legacyClient.send();',
  });
}

export const runPreflightTask = schemaTask({
  id: "run-preflight",
  schema: z.object({
    queueId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    impactAssessmentId: z.string().uuid(),
    attempt: z.number().int().min(1).max(6),
  }),
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
    randomize: true,
  },
  queue: { concurrencyLimit: 3 },
  run: async (payload, context) => {
    const { queueId, workspaceId, impactAssessmentId, attempt } = payload;
    const ctx = context?.ctx;
    const client = createSupabaseServerClient();
    const report = async <T extends { status?: unknown }>(result: T) => {
      if (ctx) {
        await logM15LocalTaskOutcome({
          taskId: "run-preflight",
          runId: ctx.run.id,
          queueId,
          queueAttempt: attempt,
          triggerAttempt: ctx.attempt.number,
          outcome:
            typeof result.status === "string"
              ? result.status
                  .toLowerCase()
                  .replace(/[^a-z_]/g, "_")
                  .slice(0, 40)
              : "completed",
        });
      }
      return result;
    };
    try {
      const { data: queue, error: queueError } = await client
        .from("preflight_dispatch_queue")
        .select("workspace_id,impact_assessment_id,status,attempt_count")
        .eq("id", queueId)
        .maybeSingle();
      if (queueError) throw new Error("preflight_queue_read_failed");
      if (
        !queue ||
        queue.workspace_id !== workspaceId ||
        queue.impact_assessment_id !== impactAssessmentId ||
        queue.attempt_count !== attempt
      ) {
        throw new AbortTaskRunError("Preflight queue identity is invalid.");
      }
      if (queue.status === "superseded") return report({ status: "superseded" as const });
      if (queue.status === "complete") return report({ status: "complete" as const });
      if (queue.status !== "dispatched") return report({ status: "not_current" as const });
      await waitForM15LocalAcceptancePreClaimGate({ taskId: "run-preflight", queueId });
      const entitlements = await resolveWorkspaceEntitlementsForService(workspaceId);
      if (
        !entitlements.capabilities.automaticPreflight ||
        entitlements.usage.preflightRuns >= entitlements.limits.preflightRuns
      ) {
        await client.rpc("finish_preflight_dispatch", {
          p_queue_id: queueId,
          p_attempt: attempt,
          p_status: "superseded",
        });
        return report({ status: "superseded" as const });
      }
      const result = await runPreflight({ impactAssessmentId, provider: fixtureProvider() });
      const status = result.status === "ineligible" ? "superseded" : "complete";
      const { data: finished, error } = await client.rpc("finish_preflight_dispatch", {
        p_queue_id: queueId,
        p_attempt: attempt,
        p_status: status,
      });
      if (error || finished !== true) throw new Error("preflight_queue_update_failed");
      return report(result);
    } catch (error) {
      const { data: latestQueue } = await client
        .from("preflight_dispatch_queue")
        .select("status")
        .eq("id", queueId)
        .maybeSingle();
      if (latestQueue?.status === "superseded") {
        return report({ status: "superseded" as const });
      }
      await client.rpc("finish_preflight_dispatch", {
        p_queue_id: queueId,
        p_attempt: attempt,
        p_status: "failed",
        p_error_category: "preflight_task_failed",
      });
      if (error instanceof Error && error.message === "github_app_not_configured")
        throw new AbortTaskRunError("GitHub App is not configured for this deployment.");
      throw error;
    }
  },
});
