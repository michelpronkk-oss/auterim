import { AbortTaskRunError, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { runPreflight } from "@/lib/preflight/preflight-service";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveWorkspaceEntitlementsForService } from "@/lib/billing/server";

export const runPreflightTask = schemaTask({
  id: "run-preflight",
  schema: z.object({
    queueId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    impactAssessmentId: z.string().uuid(),
  }),
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
    randomize: true,
  },
  queue: { concurrencyLimit: 3 },
  run: async ({ queueId, workspaceId, impactAssessmentId }) => {
    const client = createSupabaseServerClient();
    try {
      const { data: queue, error: queueError } = await client
        .from("preflight_dispatch_queue")
        .select("workspace_id,impact_assessment_id")
        .eq("id", queueId)
        .maybeSingle();
      if (queueError) throw new Error("preflight_queue_read_failed");
      if (
        !queue ||
        queue.workspace_id !== workspaceId ||
        queue.impact_assessment_id !== impactAssessmentId
      ) {
        throw new AbortTaskRunError("Preflight queue identity is invalid.");
      }
      const entitlements = await resolveWorkspaceEntitlementsForService(workspaceId);
      if (
        !entitlements.capabilities.automaticPreflight ||
        entitlements.usage.preflightRuns >= entitlements.limits.preflightRuns
      ) {
        await client.rpc("mark_preflight_dispatch", {
          p_queue_id: queueId,
          p_status: "superseded",
        });
        return { status: "superseded" as const };
      }
      const result = await runPreflight({ impactAssessmentId });
      const status = result.status === "ineligible" ? "superseded" : "complete";
      const { error } = await client.rpc("mark_preflight_dispatch", {
        p_queue_id: queueId,
        p_status: status,
      });
      if (error) throw new Error("preflight_queue_update_failed");
      return result;
    } catch (error) {
      await client.rpc("mark_preflight_dispatch", {
        p_queue_id: queueId,
        p_status: "failed",
        p_error_category: "preflight_task_failed",
      });
      if (error instanceof Error && error.message === "github_app_not_configured")
        throw new AbortTaskRunError("GitHub App is not configured for this deployment.");
      throw error;
    }
  },
});
