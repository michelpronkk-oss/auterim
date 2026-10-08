import { idempotencyKeys, schedules } from "@trigger.dev/sdk";
import { z } from "zod";
import { enqueueSemanticClassification } from "@/lib/monitoring/classification-queue";
import { SupabaseChangeClassificationRepository } from "@/lib/monitoring/classification-repository";
import { SupabaseMonitoringRepository } from "@/lib/monitoring/repository";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  baselineClaimResult,
  dispatchBaselineClaims,
  type BaselineDispatchClaim,
} from "@/lib/onboarding/baseline-dispatch";
import { scanSourceTask } from "@/trigger/scan-source";

const baselineClaimSchema = z.array(
  z.object({
    queue_id: z.string().uuid(),
    source_id: z.string().uuid(),
    dispatch_attempt: z.number().int().positive(),
    lease_recovery_count: z.number().int().nonnegative(),
    recovered: z.boolean(),
  }),
);

export const dispatchSourceScans = schedules.task({
  id: "dispatch-source-scans",
  cron: { pattern: "15 1 * * *", timezone: "UTC" },
  run: async () => {
    const baselineSources = new Set<string>();
    const service = createSupabaseServerClient();
    let baselineClaims: { data: unknown; error: unknown | null };
    try {
      const result = await service.rpc("claim_due_baseline_sources", { p_limit: 100 });
      baselineClaims = { data: result.data, error: result.error };
    } catch {
      baselineClaims = { data: null, error: true };
    }
    if (baselineClaimResult(baselineClaims.error, 0) === "error") {
      console.warn("Global baseline reconciliation claim failed.", {
        stage: "claim",
        outcome: "error",
        errorCategory: "claim_rpc_error",
        attemptCount: 0,
        leaseRecoveryState: "not_claimed",
      });
    } else {
      try {
        const claims = baselineClaimSchema.parse(
          baselineClaims.data ?? [],
        ) as BaselineDispatchClaim[];
        if (baselineClaimResult(null, claims.length) === "empty") {
          console.info("Global baseline reconciliation claim completed.", {
            stage: "claim",
            outcome: "empty",
            errorCategory: null,
            attemptCount: 0,
            leaseRecoveryState: "not_applicable",
          });
        } else {
          for (const claim of claims) baselineSources.add(claim.source_id);
          const result = await dispatchBaselineClaims(claims, null, {
            createIdempotencyKey: (claim) =>
              idempotencyKeys.create(
                `baseline-source:${claim.queue_id}:${claim.dispatch_attempt}`,
                { scope: "global" },
              ),
            trigger: (sourceId, idempotencyKey) =>
              scanSourceTask.trigger({ sourceId }, { idempotencyKey }),
            markDispatched: (claim, triggerRunId) =>
              service.rpc("mark_due_baseline_source_dispatched", {
                p_queue_id: claim.queue_id,
                p_dispatch_attempt: claim.dispatch_attempt,
                p_trigger_run_id: triggerRunId,
              }),
            release: (claim) =>
              service.rpc("release_due_baseline_source_claim", {
                p_queue_id: claim.queue_id,
                p_dispatch_attempt: claim.dispatch_attempt,
              }),
            log: (event) => {
              if (event.outcome === "error")
                console.warn("Global baseline reconciliation observed.", event);
              else console.info("Global baseline reconciliation observed.", event);
            },
          });
          console.info("Global baseline reconciliation dispatched.", result);
        }
      } catch {
        console.warn("Global baseline reconciliation response was invalid.", {
          stage: "claim",
          outcome: "error",
          errorCategory: "claim_response_invalid",
          attemptCount: 0,
          leaseRecoveryState: "not_claimed",
        });
      }
    }

    const dueSourceIds = (
      await new SupabaseMonitoringRepository().getDueSourceIds(new Date(), 100)
    ).filter((sourceId) => !baselineSources.has(sourceId));
    for (const sourceId of dueSourceIds) {
      await scanSourceTask.trigger({ sourceId });
    }
    const queuedChanges = await new SupabaseChangeClassificationRepository().getQueuedChangeIds(
      100,
    );
    let classificationsDispatched = 0;
    for (const changeId of queuedChanges) {
      try {
        await enqueueSemanticClassification(changeId);
        classificationsDispatched++;
      } catch {
        console.warn("Could not enqueue queued semantic classification.", {
          changeId,
          errorCategory: "enqueue_error",
        });
      }
    }
    console.info("Dispatched due Auterim work", {
      scans: dueSourceIds.length,
      classifications: classificationsDispatched,
    });
    return {
      dispatchedScans: dueSourceIds.length,
      dispatchedClassifications: classificationsDispatched,
    };
  },
});
