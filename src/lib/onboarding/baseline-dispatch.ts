import "server-only";

export type BaselineDispatchClaim = {
  queue_id: string;
  source_id: string;
  dispatch_attempt: number;
  lease_recovery_count: number;
  recovered: boolean;
};

export function baselineClaimResult(error: unknown | null, claimCount: number) {
  if (error) return "error" as const;
  return claimCount === 0 ? ("empty" as const) : ("claimed" as const);
}

export type BaselineDispatchEvent = {
  workspaceId: string | null;
  sourceId: string;
  queueId: string;
  stage: "dispatch" | "mark_dispatched" | "release";
  outcome: "success" | "error";
  errorCategory?: "trigger_dispatch_failed" | "mark_dispatch_failed" | "release_rpc_failed";
  attemptCount: number;
  leaseRecoveryCount: number;
  leaseRecoveryState: "new_claim" | "recovered_claim" | "lease_retained" | "released";
  triggerRunId?: string;
};

type RpcResult = { error: unknown | null };

type BaselineDispatchDependencies<IdempotencyKey> = {
  createIdempotencyKey: (claim: BaselineDispatchClaim) => Promise<IdempotencyKey>;
  trigger: (sourceId: string, idempotencyKey: IdempotencyKey) => Promise<{ id: string }>;
  markDispatched: (claim: BaselineDispatchClaim, triggerRunId: string) => PromiseLike<RpcResult>;
  release: (claim: BaselineDispatchClaim) => PromiseLike<RpcResult>;
  log: (event: BaselineDispatchEvent) => void;
};

/** Dispatches already-persisted baseline claims without letting transient queue failures block activation. */
export async function dispatchBaselineClaims<IdempotencyKey>(
  claims: readonly BaselineDispatchClaim[],
  workspaceId: string | null,
  dependencies: BaselineDispatchDependencies<IdempotencyKey>,
) {
  let dispatched = 0;
  let failed = 0;

  for (const claim of claims) {
    let key: IdempotencyKey;
    try {
      key = await dependencies.createIdempotencyKey(claim);
    } catch {
      // No task request was made, so releasing this reservation cannot duplicate a run.
      failed++;
      let releaseError: unknown | null = null;
      try {
        releaseError = (await dependencies.release(claim)).error;
      } catch {
        releaseError = true;
      }
      dependencies.log({
        workspaceId,
        sourceId: claim.source_id,
        queueId: claim.queue_id,
        stage: releaseError ? "release" : "dispatch",
        outcome: "error",
        errorCategory: releaseError ? "release_rpc_failed" : "trigger_dispatch_failed",
        attemptCount: claim.dispatch_attempt,
        leaseRecoveryCount: claim.lease_recovery_count,
        leaseRecoveryState: releaseError ? "lease_retained" : "released",
      });
      continue;
    }

    let run: { id: string };
    try {
      run = await dependencies.trigger(claim.source_id, key);
    } catch {
      // The request may have reached Trigger.dev even when its response was lost. Keep the
      // lease so recovery reuses this attempt's idempotency identity instead of duplicating it.
      failed++;
      dependencies.log({
        workspaceId,
        sourceId: claim.source_id,
        queueId: claim.queue_id,
        stage: "dispatch",
        outcome: "error",
        errorCategory: "trigger_dispatch_failed",
        attemptCount: claim.dispatch_attempt,
        leaseRecoveryCount: claim.lease_recovery_count,
        leaseRecoveryState: "lease_retained",
      });
      continue;
    }

    let markResult: RpcResult;
    try {
      markResult = await dependencies.markDispatched(claim, run.id);
    } catch {
      markResult = { error: true };
    }
    if (markResult.error) {
      // A retry uses the same claim/attempt idempotency identity and can recover the accepted run.
      failed++;
      dependencies.log({
        workspaceId,
        sourceId: claim.source_id,
        queueId: claim.queue_id,
        stage: "mark_dispatched",
        outcome: "error",
        errorCategory: "mark_dispatch_failed",
        attemptCount: claim.dispatch_attempt,
        leaseRecoveryCount: claim.lease_recovery_count,
        leaseRecoveryState: "lease_retained",
        triggerRunId: run.id,
      });
      continue;
    }
    dispatched++;
    dependencies.log({
      workspaceId,
      sourceId: claim.source_id,
      queueId: claim.queue_id,
      stage: "dispatch",
      outcome: "success",
      attemptCount: claim.dispatch_attempt,
      leaseRecoveryCount: claim.lease_recovery_count,
      leaseRecoveryState: claim.recovered ? "recovered_claim" : "new_claim",
      triggerRunId: run.id,
    });
  }

  return { dispatched, failed };
}
