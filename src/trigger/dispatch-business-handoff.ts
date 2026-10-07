import { schedules, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { prepareBusinessHandoffTask } from "@/trigger/prepare-business-handoff";

const batchSchema = z.array(
  z.object({
    id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    remediation_proposal_id: z.string().uuid(),
    patch_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    attempt_count: z.number().int().min(0).max(5),
  }),
);

export const dispatchBusinessHandoffTask = schedules.task({
  id: "dispatch-business-handoff",
  cron: { pattern: "*/2 * * * *", window: "2m" },
  run: async () => {
    const client = createSupabaseServerClient();
    const { data, error } = await client.rpc("list_business_handoff_requests", { p_limit: 20 });
    if (error) throw new Error("business_handoff_queue_read_failed");
    const items = batchSchema.parse(data ?? []);
    let dispatched = 0;
    for (const item of items) {
      const { data: attempt, error: claimError } = await client.rpc(
        "claim_business_handoff_dispatch",
        { p_request_id: item.id },
      );
      if (claimError || typeof attempt !== "number" || attempt <= 0) continue;
      try {
        const handle = await tasks.trigger<typeof prepareBusinessHandoffTask>(
          "prepare-business-handoff",
          {
            requestId: item.id,
            workspaceId: item.workspace_id,
            proposalId: item.remediation_proposal_id,
            patchFingerprint: item.patch_fingerprint,
            attempt,
          },
          { idempotencyKey: `business-handoff:${item.id}:${attempt}` },
        );
        const { data: marked, error: markError } = await client.rpc(
          "mark_business_handoff_dispatched",
          { p_request_id: item.id, p_attempt: attempt, p_trigger_run_id: handle.id },
        );
        if (markError || marked !== true) throw new Error("business_handoff_dispatch_mark_failed");
        dispatched++;
      } catch {
        // The durable request remains eligible for bounded stale-dispatch recovery.
      }
    }
    return { dispatched };
  },
});
