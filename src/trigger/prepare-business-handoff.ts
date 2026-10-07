import { AbortTaskRunError, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  logM15LocalTaskOutcome,
  waitForM15LocalAcceptancePreClaimGate,
} from "@/lib/m15/local-trigger-proof";

const schema = z.object({
  requestId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  proposalId: z.string().uuid(),
  patchFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  attempt: z.number().int().min(1).max(5),
});

export const prepareBusinessHandoffTask = schemaTask({
  id: "prepare-business-handoff",
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
    const client = createSupabaseServerClient();
    const report = async (outcome: string) => {
      const ctx = context?.ctx;
      if (!ctx) return;
      await logM15LocalTaskOutcome({
        taskId: "prepare-business-handoff",
        runId: ctx.run.id,
        queueId: payload.requestId,
        queueAttempt: payload.attempt,
        triggerAttempt: ctx.attempt.number,
        outcome,
      });
    };
    const { data: request, error } = await client
      .from("business_handoff_requests")
      .select("workspace_id,remediation_proposal_id,patch_fingerprint,status,attempt_count")
      .eq("id", payload.requestId)
      .maybeSingle();
    if (error) throw new Error("business_handoff_request_read_failed");
    if (
      !request ||
      request.workspace_id !== payload.workspaceId ||
      request.remediation_proposal_id !== payload.proposalId ||
      request.patch_fingerprint !== payload.patchFingerprint ||
      request.attempt_count !== payload.attempt
    ) {
      throw new AbortTaskRunError("Business handoff request identity is invalid.");
    }
    if (
      request.status === "prepared" ||
      request.status === "denied" ||
      request.status === "failed"
    ) {
      await report("replayed");
      return { status: "replayed" as const };
    }
    if (request.status !== "dispatched") {
      await report("not_current");
      return { status: "not_current" as const };
    }

    await waitForM15LocalAcceptancePreClaimGate({
      taskId: "prepare-business-handoff",
      queueId: payload.requestId,
    });

    const { data: claimToken, error: claimError } = await client.rpc(
      "claim_business_handoff_execution",
      { p_request_id: payload.requestId, p_attempt: payload.attempt },
    );
    if (claimError) throw new Error("business_handoff_execution_claim_failed");
    if (typeof claimToken !== "string") {
      await report("denied");
      return { status: "denied" as const };
    }

    // This is a local/persisted preparation boundary only. No GitHub API call or PR is made.
    const branch = `auterim/fix/${payload.patchFingerprint.slice(0, 20)}`;
    const { data: completed, error: completeError } = await client.rpc(
      "complete_business_handoff_preparation",
      {
        p_request_id: payload.requestId,
        p_claim_token: claimToken,
        p_outcome: "prepared",
        p_prepared_branch: branch,
        p_approval_required: true,
        p_error_category: null,
      },
    );
    if (completeError || completed !== true) throw new Error("business_handoff_completion_failed");
    await report("prepared");
    return { status: "prepared" as const, branch, externalPullRequestCreated: false as const };
  },
});
