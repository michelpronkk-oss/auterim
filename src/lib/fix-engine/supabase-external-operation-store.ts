import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { ExternalOperation, ExternalOperationStore } from "@/lib/fix-engine/operation-ledger";

type OperationKind = "github_branch" | "github_commit" | "github_draft_pr";
type OperationStatus = ExternalOperation["status"];

/** Durable, stage-claim-scoped ledger. The database stores only safe provider IDs/URLs. */
export class SupabaseExternalOperationStore implements ExternalOperationStore {
  constructor(private readonly scope: { fixRunId: string; stageId: string; claimToken: string }) {}

  async begin(input: {
    idempotencyKey: string;
    operationKind: OperationKind;
    requestFingerprint: string;
  }): Promise<ExternalOperation> {
    const client = createSupabaseServerClient();
    const { data: started, error: startError } = await client.rpc("record_fix_stage_artifact", {
      p_fix_run_id: this.scope.fixRunId,
      p_stage_id: this.scope.stageId,
      p_claim_token: this.scope.claimToken,
      p_kind: "external_operation",
      p_payload: {
        idempotencyKey: input.idempotencyKey,
        operationKind: input.operationKind,
        requestFingerprint: input.requestFingerprint,
        status: "pending",
      },
    });
    if (
      startError ||
      !started ||
      typeof started.recordId !== "string" ||
      typeof started.replayed !== "boolean"
    ) {
      throw new Error("fix_external_operation_start_failed");
    }

    const { data: row, error: readError } = await client
      .from("fix_external_operations")
      .select(
        "id,fix_run_id,operation_kind,idempotency_key,request_fingerprint,status,external_id,external_url",
      )
      .eq("id", started.recordId)
      .eq("fix_run_id", this.scope.fixRunId)
      .maybeSingle();
    if (
      readError ||
      !row ||
      row.id !== started.recordId ||
      row.fix_run_id !== this.scope.fixRunId ||
      row.operation_kind !== input.operationKind ||
      row.idempotency_key !== input.idempotencyKey ||
      row.request_fingerprint !== input.requestFingerprint ||
      !isOperationStatus(row.status)
    ) {
      throw new Error("fix_external_operation_identity_mismatch");
    }
    return {
      operationId: row.id,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      externalId: typeof row.external_id === "string" ? row.external_id : null,
      safeResult: null,
      isNew: started.replayed === false,
    };
  }

  async finish(input: {
    operationId: string;
    idempotencyKey: string;
    status: Exclude<OperationStatus, "pending">;
    externalId?: string;
    externalUrl?: string;
    safeResult?: unknown;
  }): Promise<void> {
    void input.safeResult;
    const { data, error } = await createSupabaseServerClient().rpc(
      "resolve_fix_external_operation",
      {
        p_fix_run_id: this.scope.fixRunId,
        p_operation_id: input.operationId,
        p_status: input.status,
        p_external_id: input.externalId ?? null,
        p_external_url: input.externalUrl ?? null,
      },
    );
    if (error || data !== true) throw new Error("fix_external_operation_finish_failed");
  }
}

function isOperationStatus(value: unknown): value is OperationStatus {
  return (
    value === "pending" || value === "succeeded" || value === "failed" || value === "ambiguous"
  );
}
