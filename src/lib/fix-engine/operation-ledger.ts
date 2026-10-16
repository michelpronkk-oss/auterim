import { createHash } from "node:crypto";

export type ExternalOperationStatus = "pending" | "succeeded" | "failed" | "ambiguous";
export type ExternalOperation = {
  operationId: string;
  idempotencyKey: string;
  status: ExternalOperationStatus;
  externalId: string | null;
  safeResult: unknown | null;
  isNew: boolean;
};

export interface ExternalOperationStore {
  begin(input: {
    idempotencyKey: string;
    operationKind: "github_branch" | "github_commit" | "github_draft_pr";
    requestFingerprint: string;
  }): Promise<ExternalOperation>;
  finish(input: {
    operationId: string;
    idempotencyKey: string;
    status: "succeeded" | "failed" | "ambiguous";
    externalId?: string;
    externalUrl?: string;
    safeResult?: unknown;
  }): Promise<void>;
}

export function externalOperationKey(
  fixRunIdentity: string,
  kind: string,
  requestFingerprint: string,
) {
  if (!/^[a-f0-9]{64}$/i.test(fixRunIdentity) || !/^[a-f0-9]{64}$/i.test(requestFingerprint))
    throw new Error("invalid_external_operation_identity");
  return createHash("sha256")
    .update(`${fixRunIdentity}:${kind}:${requestFingerprint}`, "utf8")
    .digest("hex");
}

export async function executeReconciledOperation<T>(input: {
  store: ExternalOperationStore;
  key: string;
  operationKind: "github_branch" | "github_commit" | "github_draft_pr";
  requestFingerprint: string;
  reconcile: () => Promise<T | null>;
  execute: () => Promise<T>;
  externalId: (result: T) => string;
  externalUrl?: (result: T) => string | undefined;
  /** Enable only when reconcile proves resuming the operation is safe. */
  safeToResumeAfterMissingReconciliation?: boolean;
}) {
  const existing = await input.store.begin({
    idempotencyKey: input.key,
    operationKind: input.operationKind,
    requestFingerprint: input.requestFingerprint,
  });
  if (existing.status === "succeeded") {
    if (existing.safeResult !== null)
      return {
        result: existing.safeResult as T,
        replayed: true,
        operationId: existing.operationId,
      };
    // The durable ledger intentionally stores only bounded external identity,
    // not provider response bodies. Reconstruct a completed result from the
    // provider before returning; never repeat a successful non-idempotent write.
    const recovered = await input.reconcile();
    if (recovered !== null)
      return { result: recovered, replayed: true, operationId: existing.operationId };
    throw new Error("external_operation_success_unreconciled");
  }
  if (existing.status === "failed") throw new Error("external_operation_terminal_failure");
  if (!existing.isNew && (existing.status === "pending" || existing.status === "ambiguous")) {
    const recovered = await input.reconcile();
    if (recovered !== null) {
      await input.store.finish({
        idempotencyKey: input.key,
        operationId: existing.operationId,
        status: "succeeded",
        externalId: input.externalId(recovered),
        externalUrl: input.externalUrl?.(recovered),
        safeResult: recovered,
      });
      return { result: recovered, replayed: true, operationId: existing.operationId };
    }
    if (!input.safeToResumeAfterMissingReconciliation)
      throw new Error("external_operation_reconciliation_required");
  }
  try {
    const result = await input.execute();
    await input.store.finish({
      idempotencyKey: input.key,
      operationId: existing.operationId,
      status: "succeeded",
      externalId: input.externalId(result),
      externalUrl: input.externalUrl?.(result),
      safeResult: result,
    });
    return { result, replayed: false, operationId: existing.operationId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const status =
      message.includes("ambiguous") || message.includes("timeout") ? "ambiguous" : "failed";
    await input.store.finish({
      idempotencyKey: input.key,
      operationId: existing.operationId,
      status,
      safeResult: null,
    });
    throw error;
  }
}
