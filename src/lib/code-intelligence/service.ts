import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createCodeAnalysisIdempotencyKey } from "@/lib/code-intelligence/analyzer";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const BATCH_SIZE = 250;

function fail(error: { message: string } | null) {
  if (error) throw new Error("code_intelligence_persistence_failed");
}

async function upsertBatches<T>(
  rows: T[],
  insert: (batch: T[]) => Promise<{ error: { message: string } | null }>,
) {
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const { error } = await insert(rows.slice(index, index + BATCH_SIZE));
    fail(error);
  }
}

export type CodeAnalysisIdentity = {
  workspaceId: string;
  productId: string;
  repositoryId: string;
  commitSha: string;
  routeIntentId?: string;
};

export async function claimCodeAnalysisRun(
  input: CodeAnalysisIdentity,
  client: SupabaseClient = createSupabaseServerClient(),
) {
  const idempotencyKey = createCodeAnalysisIdempotencyKey({
    repositoryId: input.repositoryId,
    commitSha: input.commitSha,
  });
  const { data, error } = await client.rpc("claim_code_analysis_run", {
    p_workspace_id: input.workspaceId,
    p_product_id: input.productId,
    p_repository_id: input.repositoryId,
    p_commit_sha: input.commitSha,
    p_analyzer_version: "code-intelligence-v1",
    p_language_profile: "javascript-typescript-v1",
    p_analysis_profile: "javascript-typescript-v1",
    p_idempotency_key: idempotencyKey,
    p_route_intent_id: input.routeIntentId ?? null,
  });
  fail(error);
  if (!data || typeof data !== "object") throw new Error("code_intelligence_claim_invalid");
  return data as {
    status: "claimed" | "completed" | "busy" | "failed";
    analysisRunId: string;
    claimToken?: string;
    replayed: boolean;
  };
}

export async function persistCodeAnalysis(
  input: {
    analysisRunId: string;
    workspaceId: string;
    repositoryId: string;
    commitSha: string;
    claimToken: string;
    result: import("@/lib/code-intelligence/analyzer").AnalysisResult;
  },
  client: SupabaseClient = createSupabaseServerClient(),
) {
  const entities = input.result.entities.map((entity) => ({
    analysis_run_id: input.analysisRunId,
    workspace_id: input.workspaceId,
    repository_id: input.repositoryId,
    commit_sha: input.commitSha,
    entity_type: entity.entityType,
    name: entity.name,
    language: entity.language,
    path: entity.path,
    start_line: entity.startLine,
    start_column: entity.startColumn,
    end_line: entity.endLine,
    end_column: entity.endColumn,
    extractor_type: entity.extractorType,
    confidence_class: entity.confidenceClass,
    structural_fingerprint: entity.entityKey,
  }));
  await upsertBatches(entities, async (batch) =>
    client.from("code_entities").upsert(batch, {
      onConflict: "analysis_run_id,structural_fingerprint",
    }),
  );

  const { data: entityRows, error: entityReadError } = await client
    .from("code_entities")
    .select("id,structural_fingerprint")
    .eq("analysis_run_id", input.analysisRunId);
  fail(entityReadError);
  const entityIds = new Map<string, string>(
    (entityRows ?? []).map((row: { id: string; structural_fingerprint: string }) => [
      row.structural_fingerprint,
      row.id,
    ]),
  );
  const relations = input.result.relations.flatMap((relation) => {
    const fromEntityId = entityIds.get(relation.fromEntityKey);
    const toEntityId = entityIds.get(relation.toEntityKey);
    if (!fromEntityId || !toEntityId) return [];
    const fingerprint = createCodeAnalysisIdempotencyKey({
      repositoryId: `${input.repositoryId}:${relation.fromEntityKey}:${relation.toEntityKey}:${relation.relationType}`,
      commitSha: input.commitSha,
    });
    return [
      {
        analysis_run_id: input.analysisRunId,
        from_entity_id: fromEntityId,
        to_entity_id: toEntityId,
        relation_type: relation.relationType,
        confidence_class: relation.confidenceClass,
        structural_fingerprint: fingerprint,
      },
    ];
  });
  await upsertBatches(relations, async (batch) =>
    client.from("code_relations").upsert(batch, {
      onConflict: "analysis_run_id,structural_fingerprint",
    }),
  );

  const refs = input.result.externalReferences.flatMap((reference) => {
    const entityId = entityIds.get(reference.entityKey);
    if (!entityId) return [];
    return [
      {
        analysis_run_id: input.analysisRunId,
        workspace_id: input.workspaceId,
        repository_id: input.repositoryId,
        commit_sha: input.commitSha,
        entity_id: entityId,
        reference_type: reference.referenceType,
        normalized_value: reference.normalizedValue,
        path: reference.path,
        start_line: reference.startLine,
        end_line: reference.endLine,
        language: reference.language,
        confidence_class: reference.confidenceClass,
        redacted: reference.redacted,
        value_fingerprint: reference.valueFingerprint,
        extractor_type: reference.extractorType,
        structural_fingerprint: createCodeAnalysisIdempotencyKey({
          repositoryId: `${input.repositoryId}:${reference.entityKey}:${reference.referenceType}`,
          commitSha: input.commitSha,
        }),
      },
    ];
  });
  await upsertBatches(refs, async (batch) =>
    client.from("code_external_references").upsert(batch, {
      onConflict: "analysis_run_id,structural_fingerprint",
    }),
  );

  const skips = input.result.skippedFiles.map((file) => ({
    analysis_run_id: input.analysisRunId,
    path: file.path,
    skip_reason: file.reason,
    byte_size: file.size,
  }));
  await upsertBatches(skips, async (batch) =>
    client.from("code_analysis_skipped_files").upsert(batch, {
      onConflict: "analysis_run_id,path,skip_reason",
    }),
  );

  const { data, error } = await client.rpc("complete_code_analysis_run", {
    p_analysis_run_id: input.analysisRunId,
    p_claim_token: input.claimToken,
    p_coverage_state: input.result.coverageState,
    p_files_discovered: input.result.filesDiscovered,
    p_files_analyzed: input.result.filesAnalyzed,
    p_files_skipped: input.result.filesSkipped,
    p_parse_failures: input.result.parseFailures,
    p_bytes_analyzed: input.result.bytesAnalyzed,
  });
  fail(error);
  if (data !== true) throw new Error("code_intelligence_completion_not_persisted");
}

export async function failCodeAnalysisRun(
  input: {
    analysisRunId: string;
    claimToken: string;
    failureCategory: string;
    retryable: boolean;
  },
  client: SupabaseClient = createSupabaseServerClient(),
) {
  const { error } = await client.rpc("fail_code_analysis_run", {
    p_analysis_run_id: input.analysisRunId,
    p_claim_token: input.claimToken,
    p_failure_category:
      input.failureCategory.replace(/[^a-z0-9_]/g, "_").slice(0, 80) || "analysis_failed",
    p_retryable: input.retryable,
  });
  fail(error);
}
