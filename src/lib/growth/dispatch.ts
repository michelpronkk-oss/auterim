import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateGrowthCandidate } from "@/lib/growth/evaluator";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type ClaimedGrowthEvaluation = {
  queue_id: string;
  classification_id: string;
  source_change_id: string;
  lease_token: string;
  attempts: number;
};

/** Processes a small leased batch. It never fans out to workspaces or scans historical changes. */
export async function dispatchGrowthOpportunityEvaluation(
  options: { client?: SupabaseClient; limit?: number } = {},
) {
  const client = options.client ?? createSupabaseServerClient();
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 10), 1), 25);
  const { data, error } = await client.rpc("claim_growth_evaluation_batch", { p_limit: limit });
  if (error) throw new Error("growth_queue_claim_failed");
  const claimed = (data ?? []) as ClaimedGrowthEvaluation[];
  const results = {
    claimed: claimed.length,
    completed: 0,
    skippedUnsafe: 0,
    retried: 0,
    lostLease: 0,
  };
  for (const item of claimed) {
    try {
      const evaluated = await evaluateGrowthCandidate(item.source_change_id, {
        client,
        classificationId: item.classification_id,
      });
      if (!evaluated.packet) results.skippedUnsafe += 1;
      const { data: completed, error: completeError } = await client.rpc(
        "complete_growth_evaluation_queue",
        {
          p_queue_id: item.queue_id,
          p_lease_token: item.lease_token,
        },
      );
      if (completeError) throw new Error("growth_queue_complete_failed");
      if (completed) results.completed += 1;
      else results.lostLease += 1;
    } catch {
      const { data: failed, error: failError } = await client.rpc("fail_growth_evaluation_queue", {
        p_queue_id: item.queue_id,
        p_lease_token: item.lease_token,
        p_error_category: "evaluation_failed",
      });
      if (failError || !failed) results.lostLease += 1;
      else results.retried += 1;
    }
  }
  return results;
}
