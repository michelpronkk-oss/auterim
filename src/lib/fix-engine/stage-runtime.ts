import "server-only";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { FixStageSchema, type FixStage } from "@/lib/fix-engine/contracts";
import { SupabasePrivatePatchArtifactStore } from "@/lib/fix-engine/artifact-store";
import {
  isVerificationRunnerRetryableFailure,
  VerificationRunnerFailure,
} from "@/lib/fix-engine/verification-retry";

const uuid = z.string().uuid();
const stageRunSchema = z
  .object({
    id: uuid,
    workspace_id: uuid,
    product_id: uuid,
    repository_id: uuid,
    provider_repository_identity: z.string().min(3).max(511),
    workspace_dependency_id: uuid,
    product_repository_mapping_id: uuid,
    source_change_id: uuid,
    source_mode: z.enum(["provider", "internal_test"]),
    processing_mode: z.enum(["customer", "evidence_only"]),
    provenance_mode: z.enum(["customer", "evidence_only"]),
    intelligence_decision_id: uuid,
    route_intent_id: uuid,
    semantic_route: z.string(),
    route_target: z.string(),
    analysis_run_id: uuid,
    graph_build_id: uuid,
    commit_sha: z.string().regex(/^[a-f0-9]{40,64}$/),
    identity_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    idempotency_key: z.string().regex(/^[a-f0-9]{64}$/),
    positive_graph_evidence_ids: z.array(uuid).min(1).max(5000),
    evidence_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    review_disposition: z.enum(["none", "review_required"]),
    review_reason: z.string().nullable(),
    preflight_required: z.boolean(),
    draft_pr_policy_allowed: z.boolean(),
    risk_level: z.enum(["LOW", "MEDIUM", "HIGH", "BLOCKED"]).nullable(),
    production_exposure_state: z.literal("unknown"),
    status: z.string(),
    current_stage: FixStageSchema,
  })
  .strict();

export type PersistedFixRun = z.infer<typeof stageRunSchema>;
export type FixStageProcessor = (input: {
  run: PersistedFixRun;
  stage: FixStage;
  stageId: string;
  claimToken: string;
  attemptNumber: number;
}) => Promise<{ recordKind: string; record: Record<string, unknown> }>;

async function hasPersistedStageArtifact(
  client: ReturnType<typeof createSupabaseServerClient>,
  fixRunId: string,
  stage: FixStage,
): Promise<boolean> {
  const query = (() => {
    switch (stage) {
      case "diagnose":
        return client.from("fix_diagnoses").select("id").eq("fix_run_id", fixRunId);
      case "plan":
        return client.from("fix_plans").select("id").eq("fix_run_id", fixRunId);
      case "generate_patch":
        return client
          .from("fix_patches")
          .select("id")
          .eq("fix_run_id", fixRunId)
          .eq("status", "validated");
      case "apply_patch":
        return client
          .from("fix_patches")
          .select("id")
          .eq("fix_run_id", fixRunId)
          .eq("status", "applied");
      case "verify_patch":
        return client
          .from("fix_verification_runs")
          .select("id")
          .eq("fix_run_id", fixRunId)
          .eq("status", "passed");
      case "preflight":
        return client
          .from("fix_preflight_results")
          .select("id")
          .eq("fix_run_id", fixRunId)
          .eq("status", "passed");
      case "risk_assess":
        return client.from("fix_risk_assessments").select("id").eq("fix_run_id", fixRunId);
      case "create_draft_pr":
        return client
          .from("fix_pr_outcomes")
          .select("id")
          .eq("fix_run_id", fixRunId)
          .in("status", ["draft_created", "reconciled_existing"]);
    }
  })();
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw new Error("fix_stage_artifact_read_failed");
  return data !== null;
}

async function completeClaimedStage(
  client: ReturnType<typeof createSupabaseServerClient>,
  stageId: string,
  claimToken: string,
) {
  const { data, error } = await client.rpc("complete_fix_stage", {
    p_stage_id: stageId,
    p_claim_token: claimToken,
    p_result: "completed",
    p_failure_category: null,
  });
  if (error || !data) throw new Error("fix_stage_transition_failed");
  return {
    status: "completed" as const,
    nextStage: typeof data.nextStage === "string" ? FixStageSchema.parse(data.nextStage) : null,
  };
}

export function stageArtifactPersistenceFailureCategory(error: {
  message?: unknown;
  code?: unknown;
}): string {
  const message = typeof error.message === "string" ? error.message : "";
  if (/^fix_[a-z0-9_]{1,90}$/.test(message)) return message;
  const code =
    typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)
      ? error.code.toLowerCase()
      : null;
  return code ? `fix_stage_record_failed_${code}` : "fix_stage_record_failed";
}

export async function createPersistedFixRun(graphBuildId: string) {
  if (!uuid.safeParse(graphBuildId).success) throw new Error("invalid_graph_build_id");
  const { data, error } = await createSupabaseServerClient().rpc("create_fix_run_from_graph", {
    p_graph_build_id: graphBuildId,
  });
  if (error || !data || typeof data.fixRunId !== "string")
    throw new Error("fix_run_creation_failed");
  return {
    fixRunId: uuid.parse(data.fixRunId),
    idempotencyKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(data.idempotencyKey),
    replayed: data.replayed === true,
  };
}

export async function runPersistedFixStage(input: {
  fixRunId: string;
  stage: FixStage;
  processor: FixStageProcessor;
}) {
  const runId = uuid.parse(input.fixRunId);
  const stage = FixStageSchema.parse(input.stage);
  const client = createSupabaseServerClient();
  const { data: queueRow, error: queueError } = await client
    .from("fix_stage_queue")
    .select("id")
    .eq("fix_run_id", runId)
    .eq("stage", stage)
    .maybeSingle();
  if (queueError || !queueRow || typeof queueRow.id !== "string")
    throw new Error("fix_stage_queue_unavailable");
  const { data: claimData, error: claimError } = await client.rpc("claim_fix_stage", {
    p_stage_id: queueRow.id,
    // Match the Trigger task's 300-second maximum so the recovery dispatcher
    // cannot reclaim a stage that is still legitimately running.
    p_lease_seconds: 300,
  });
  if (claimError || !claimData) return { status: "busy" as const, nextStage: null };
  if (claimData.status === "stale_scope")
    return { status: "stale_scope" as const, nextStage: null };
  if (claimData.status === "stale_policy")
    return { status: "stale_policy" as const, nextStage: null };
  if (claimData.status === "completed")
    return {
      status: "completed" as const,
      nextStage:
        typeof claimData.nextStage === "string" ? FixStageSchema.parse(claimData.nextStage) : null,
      replayed: true,
    };
  if (claimData.status !== "claimed") return { status: "busy" as const, nextStage: null };
  const claim = z
    .object({
      stageId: uuid,
      fixRunId: uuid,
      claimToken: uuid,
      stage: FixStageSchema,
      attemptNumber: z.number().int().min(1).max(4),
      recoveryGeneration: z.number().int().min(0).max(1).default(0),
    })
    .refine(
      (value) =>
        value.attemptNumber <= 3 ||
        (value.stage === "diagnose" && value.attemptNumber === 4 && value.recoveryGeneration === 1),
    )
    .parse(claimData);
  const { data: rawRun, error: runError } = await client
    .from("fix_runs")
    .select(
      [
        "id",
        "workspace_id",
        "product_id",
        "repository_id",
        "provider_repository_identity",
        "workspace_dependency_id",
        "product_repository_mapping_id",
        "source_change_id",
        "source_mode",
        "processing_mode",
        "provenance_mode",
        "intelligence_decision_id",
        "route_intent_id",
        "semantic_route",
        "route_target",
        "analysis_run_id",
        "graph_build_id",
        "commit_sha",
        "identity_fingerprint",
        "idempotency_key",
        "positive_graph_evidence_ids",
        "evidence_fingerprint",
        "review_disposition",
        "review_reason",
        "preflight_required",
        "draft_pr_policy_allowed",
        "risk_level",
        "production_exposure_state",
        "status",
        "current_stage",
      ].join(","),
    )
    .eq("id", runId)
    .maybeSingle();
  if (runError || !rawRun) throw new Error("fix_run_unavailable");
  const run = stageRunSchema.parse(rawRun);
  if (claim.fixRunId !== run.id || claim.stage !== stage || run.current_stage !== stage)
    throw new Error("fix_stage_identity_mismatch");
  if (!(
    (run.source_mode === "provider" &&
      run.processing_mode === "customer" &&
      run.provenance_mode === "customer") ||
    (run.source_mode === "internal_test" &&
      run.processing_mode === "evidence_only" &&
      run.provenance_mode === "evidence_only")
  )) {
    throw new Error("fix_run_provenance_invalid");
  }
  // A worker may crash after the artifact RPC commits but before the stage
  // transition. Reuse that durable result instead of calling a model or
  // external provider a second time.
  if (await hasPersistedStageArtifact(client, run.id, stage)) {
    const completed = await completeClaimedStage(client, claim.stageId, claim.claimToken);
    return { ...completed, replayed: true };
  }
  try {
    const output = await input.processor({
      run,
      stage,
      stageId: claim.stageId,
      claimToken: claim.claimToken,
      attemptNumber: claim.attemptNumber,
    });
    if (output.recordKind) {
      const { error } = await client.rpc("record_fix_stage_artifact", {
        p_fix_run_id: run.id,
        p_stage_id: claim.stageId,
        p_claim_token: claim.claimToken,
        p_kind: output.recordKind,
        p_payload: output.record,
      });
      if (error) {
        if (output.recordKind === "patch" && typeof output.record.artifactPath === "string") {
          const persisted = await client
            .from("fix_patches")
            .select("patch_fingerprint,artifact_path")
            .eq("fix_run_id", run.id)
            .eq("attempt_number", output.record.attemptNumber ?? -1)
            .maybeSingle();
          if (
            persisted.data?.patch_fingerprint !== output.record.patchFingerprint ||
            persisted.data?.artifact_path !== output.record.artifactPath
          ) {
            await new SupabasePrivatePatchArtifactStore()
              .remove({ paths: [output.record.artifactPath] })
              .catch(() => undefined);
          }
        }
        throw new Error(stageArtifactPersistenceFailureCategory(error));
      }
    }
    const completed = await completeClaimedStage(client, claim.stageId, claim.claimToken);
    return {
      ...completed,
      replayed: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const retryable =
      isVerificationRunnerRetryableFailure(error) ||
      (!(error instanceof VerificationRunnerFailure) &&
        (message.includes("provider_unavailable") ||
          message.includes("timeout") ||
          message.includes("ambiguous") ||
          message.includes("transport_ambiguous")));
    const safeCategory = /^[a-z0-9_]{1,100}$/.test(message) ? message : "fix_stage_failed";
    await client.rpc("complete_fix_stage", {
      p_stage_id: claim.stageId,
      p_claim_token: claim.claimToken,
      p_result: retryable ? "retry" : "failed",
      p_failure_category: safeCategory,
    });
    throw new Error(safeCategory);
  }
}
