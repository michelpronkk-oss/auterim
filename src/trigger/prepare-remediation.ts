import { AbortTaskRunError, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { getEnvironment } from "@/lib/env/schema";
import { GitHubAppRepositoryProvider } from "@/lib/preflight/github-provider";
import { createPinnedFixtureRepositoryProvider } from "@/lib/m15/persisted-preflight-acceptance";
import { preparePersistedRemediation } from "@/lib/m15/persisted-remediation-preparation";
import {
  isM15LocalAcceptanceRuntime,
  isM15PostCommitRetryFault,
  logM15LocalTaskOutcome,
  shouldInjectM15PostCommitRetry,
  waitForM15LocalAcceptancePreClaimGate,
  waitForM15LocalAcceptancePostWorkGate,
} from "@/lib/m15/local-trigger-proof";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const schema = z.object({
  queueId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  preflightRunId: z.string().uuid(),
  impactAssessmentId: z.string().uuid(),
  attempt: z.number().int().min(1).max(5),
});

const terminalDenialCodes = new Set([
  "generate_fix_not_entitled",
  "customer_impact_not_eligible",
  "protected_dependency_required",
  "protected_product_required",
  "material_source_change_required",
  "repository_unavailable",
  "dependency_repository_access_required",
  "repository_connection_required",
  "verified_persisted_preflight_required",
]);

function repositoryProvider() {
  if (process.env.NODE_ENV !== "production" && isM15LocalAcceptanceRuntime()) {
    return createPinnedFixtureRepositoryProvider({
      outcome: "verified",
      commitSha: "a".repeat(40),
      affectedEntity: "fixture-client",
      filePath: "src/client.ts",
      fileContents:
        'export const configuredEntity = "fixture-client"; const legacyClient = { send: () => "old" }; const modernClient = { send: () => "new" }; export const client = legacyClient.send();',
    });
  }
  const environment = getEnvironment();
  return new GitHubAppRepositoryProvider({
    appId: environment.GITHUB_APP_ID,
    privateKey: environment.GITHUB_APP_PRIVATE_KEY,
  });
}

export const prepareRemediationTask = schemaTask({
  id: "prepare-remediation",
  schema,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 15_000,
    factor: 2,
    randomize: true,
  },
  queue: { concurrencyLimit: 2 },
  run: async (payload, context) => {
    const ctx = context?.ctx;
    const report = async (outcome: string) => {
      if (ctx) {
        await logM15LocalTaskOutcome({
          taskId: "prepare-remediation",
          runId: ctx.run.id,
          queueId: payload.queueId,
          queueAttempt: payload.attempt,
          triggerAttempt: ctx.attempt.number,
          outcome,
        });
      }
    };
    const client = createSupabaseServerClient();
    const { data: row, error: rowError } = await client
      .from("remediation_preparation_queue")
      .select("workspace_id,preflight_run_id,impact_assessment_id,status,attempt_count")
      .eq("id", payload.queueId)
      .maybeSingle();
    if (rowError) throw new Error("remediation_preparation_queue_read_failed");
    if (
      !row ||
      row.workspace_id !== payload.workspaceId ||
      row.preflight_run_id !== payload.preflightRunId ||
      row.impact_assessment_id !== payload.impactAssessmentId ||
      row.attempt_count !== payload.attempt
    ) {
      throw new AbortTaskRunError("Remediation preparation queue identity is invalid.");
    }
    if (row.status === "completed") {
      await report("replayed");
      return { status: "replayed" as const };
    }
    if (row.status === "denied" || row.status === "failed") {
      await report(row.status);
      return { status: row.status };
    }
    if (row.status !== "dispatched") {
      await report("not_current");
      return { status: "not_current" as const };
    }
    await waitForM15LocalAcceptancePreClaimGate({
      taskId: "prepare-remediation",
      queueId: payload.queueId,
    });
    await report("claim_starting");
    const { data: claimToken, error: claimError } = await client.rpc(
      "claim_remediation_preparation",
      { p_queue_id: payload.queueId, p_attempt: payload.attempt },
    );
    if (claimError) throw new Error("remediation_preparation_claim_failed");
    if (typeof claimToken !== "string") {
      await report("denied");
      return { status: "denied" as const };
    }
    await report("claim_acquired");

    try {
      await report("preparation_started");
      const result = await preparePersistedRemediation({
        preflightRunId: payload.preflightRunId,
        provider: repositoryProvider(),
      });
      await report("preparation_finished");
      await waitForM15LocalAcceptancePostWorkGate({
        taskId: "prepare-remediation",
        queueId: payload.queueId,
      });
      await report("completion_starting");
      const { data: completion, error: completeError } = await client.rpc(
        "complete_remediation_preparation",
        {
          p_queue_id: payload.queueId,
          p_claim_token: claimToken,
          p_outcome: "completed",
          p_proposal: result.proposalCandidate,
          p_error_category: null,
        },
      );
      if (completeError) {
        const safeCode = /^[A-Z0-9]{5}$/.test(completeError.code ?? "")
          ? completeError.code.toLowerCase()
          : "unknown";
        await report(`completion_rpc_error_${safeCode}`);
        throw new Error("remediation_preparation_completion_conflict");
      }
      const completionResult = completion as {
        status?: unknown;
        proposalId?: unknown;
        replayed?: unknown;
      } | null;
      if (completionResult?.status === "denied") {
        await report("denied");
        return { status: "denied" as const };
      }
      if (
        completionResult?.status !== "completed" ||
        typeof completionResult.proposalId !== "string"
      ) {
        throw new Error("remediation_preparation_completion_conflict");
      }
      const injectRetry = shouldInjectM15PostCommitRetry({
        taskId: "prepare-remediation",
        queueId: payload.queueId,
        triggerAttempt: ctx?.attempt.number,
      });
      await report(injectRetry ? "persisted_before_retry" : "completed");
      if (injectRetry)
        throw new Error("m15_local_acceptance_post_commit_retry:prepare-remediation");
      return { status: "completed" as const, proposalId: completionResult.proposalId };
    } catch (error) {
      if (isM15PostCommitRetryFault(error, "prepare-remediation")) throw error;
      const code = error instanceof Error ? error.message : "remediation_preparation_failed";
      const denied = terminalDenialCodes.has(code);
      const { error: completeError } = await client.rpc("complete_remediation_preparation", {
        p_queue_id: payload.queueId,
        p_claim_token: claimToken,
        p_outcome: denied ? "denied" : "failed",
        p_proposal: null,
        p_error_category: code,
      });
      if (completeError) {
        const safeCode = /^[A-Z0-9]{5}$/.test(completeError.code ?? "")
          ? completeError.code.toLowerCase()
          : "unknown";
        await report(`failure_persist_error_${safeCode}`);
        throw new Error(`remediation_preparation_failure_persist_failed_${safeCode}`);
      }
      await report(denied ? "denied" : "failed");
      return { status: denied ? ("denied" as const) : ("failed" as const) };
    }
  },
});
