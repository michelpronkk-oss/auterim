import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CODE_INTELLIGENCE_PROFILE,
  CODE_INTELLIGENCE_VERSION,
  createCodeAnalysisIdempotencyKey,
} from "@/lib/code-intelligence/analyzer";
import type { CodeAnalysisFailureStage } from "@/lib/code-intelligence/failures";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const BATCH_SIZE = 250;

function fail(error: { message: string } | null) {
  if (error) throw new Error("code_intelligence_persistence_failed");
}

async function upsertReturningCount<T, R>(
  rows: T[],
  insert: (batch: T[]) => PromiseLike<{ data: R[] | null; error: { message: string } | null }>,
  returnedIdentity: (row: R) => string,
  inputIdentity: (row: T) => string,
) {
  let persisted = 0;
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);
    const { data, error } = await insert(batch);
    fail(error);
    const received = new Set((data ?? []).map(returnedIdentity));
    const expected = new Set(batch.map(inputIdentity));
    if (
      !data ||
      data.length !== batch.length ||
      received.size !== batch.length ||
      expected.size !== batch.length ||
      [...expected].some((key) => !received.has(key))
    )
      throw new Error("code_intelligence_fact_persistence_count_mismatch");
    persisted += data.length;
  }
  return persisted;
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
    p_analyzer_version: CODE_INTELLIGENCE_VERSION,
    p_language_profile: CODE_INTELLIGENCE_PROFILE,
    p_analysis_profile: CODE_INTELLIGENCE_PROFILE,
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
  const entityIds = new Map<string, string>();
  for (let index = 0; index < entities.length; index += BATCH_SIZE) {
    const batch = entities.slice(index, index + BATCH_SIZE);
    const { data, error } = await client
      .from("code_entities")
      .upsert(batch, { onConflict: "analysis_run_id,structural_fingerprint" })
      .select("id,structural_fingerprint");
    fail(error);
    const returned = new Map(
      (data ?? []).map((row: { id: string; structural_fingerprint: string }) => [
        row.structural_fingerprint,
        row.id,
      ]),
    );
    if (
      returned.size !== batch.length ||
      batch.some((row) => !returned.has(row.structural_fingerprint))
    )
      throw new Error("code_intelligence_entity_persistence_count_mismatch");
    for (const [fingerprint, id] of returned) entityIds.set(fingerprint, id);
  }
  if (entityIds.size !== input.result.entities.length)
    throw new Error("code_intelligence_entity_persistence_count_mismatch");
  const relations = input.result.relations.flatMap((relation) => {
    const fromEntityId = entityIds.get(relation.fromEntityKey);
    const toEntityId = entityIds.get(relation.toEntityKey);
    if (!fromEntityId || !toEntityId) throw new Error("code_intelligence_relation_entity_missing");
    const fingerprint = createCodeAnalysisIdempotencyKey({
      repositoryId: JSON.stringify([
        input.repositoryId,
        relation.fromEntityKey,
        relation.toEntityKey,
        relation.relationType,
        relation.evidencePath,
        relation.evidenceStartLine,
        relation.evidenceEndLine,
        relation.extractorType,
      ]),
      commitSha: input.commitSha,
    });
    return [
      {
        analysis_run_id: input.analysisRunId,
        from_entity_id: fromEntityId,
        to_entity_id: toEntityId,
        relation_type: relation.relationType,
        confidence_class: relation.confidenceClass,
        evidence_path: relation.evidencePath,
        evidence_start_line: relation.evidenceStartLine,
        evidence_end_line: relation.evidenceEndLine,
        extractor_type: relation.extractorType,
        structural_fingerprint: fingerprint,
      },
    ];
  });
  const persistedRelations = await upsertReturningCount(
    relations,
    (batch) =>
      client
        .from("code_relations")
        .upsert(batch, { onConflict: "analysis_run_id,structural_fingerprint" })
        .select("structural_fingerprint"),
    (row: { structural_fingerprint: string }) => row.structural_fingerprint,
    (row) => row.structural_fingerprint,
  );
  if (persistedRelations !== input.result.relations.length)
    throw new Error("code_intelligence_relation_persistence_count_mismatch");

  const refs = input.result.externalReferences.flatMap((reference) => {
    const entityId = entityIds.get(reference.entityKey);
    if (!entityId) throw new Error("code_intelligence_reference_entity_missing");
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
          repositoryId: JSON.stringify([
            input.repositoryId,
            reference.entityKey,
            reference.referenceType,
            reference.normalizedValue,
            reference.path,
            reference.startLine,
            reference.endLine,
            reference.extractorType,
            reference.valueFingerprint ?? "",
          ]),
          commitSha: input.commitSha,
        }),
      },
    ];
  });
  const persistedReferences = await upsertReturningCount(
    refs,
    (batch) =>
      client
        .from("code_external_references")
        .upsert(batch, { onConflict: "analysis_run_id,structural_fingerprint" })
        .select("structural_fingerprint"),
    (row: { structural_fingerprint: string }) => row.structural_fingerprint,
    (row) => row.structural_fingerprint,
  );
  if (persistedReferences !== input.result.externalReferences.length)
    throw new Error("code_intelligence_reference_persistence_count_mismatch");

  const skips = input.result.skippedFiles.map((file) => ({
    analysis_run_id: input.analysisRunId,
    path: file.path,
    skip_reason: file.reason,
    byte_size: file.size,
  }));
  const persistedSkips = await upsertReturningCount(
    skips,
    (batch) =>
      client
        .from("code_analysis_skipped_files")
        .upsert(batch, { onConflict: "analysis_run_id,path,skip_reason" })
        .select("path,skip_reason"),
    (row: { path: string; skip_reason: string }) => `${row.path}\0${row.skip_reason}`,
    (row) => `${row.path}\0${row.skip_reason}`,
  );
  if (persistedSkips !== input.result.skippedFiles.length)
    throw new Error("code_intelligence_skip_persistence_count_mismatch");

  const { data, error } = await client.rpc("complete_code_analysis_run_v2", {
    p_analysis_run_id: input.analysisRunId,
    p_claim_token: input.claimToken,
    p_coverage_state: input.result.coverageState,
    p_files_discovered: input.result.filesDiscovered,
    p_files_analyzed: input.result.filesAnalyzed,
    p_files_skipped: input.result.filesSkipped,
    p_parse_failures: input.result.parseFailures,
    p_bytes_analyzed: input.result.bytesAnalyzed,
    p_supported_files_discovered: input.result.supportedFilesDiscovered,
    p_supported_files_analyzed: input.result.supportedFilesAnalyzed,
    p_supported_files_skipped_by_bound: input.result.supportedFilesSkippedByBound,
    p_unsupported_language_files: input.result.unsupportedLanguageFiles,
    p_coverage_reason_counts: input.result.coverageReasonCounts,
    p_persisted_entity_count: entityIds.size,
    p_persisted_relation_count: persistedRelations,
    p_persisted_reference_count: persistedReferences,
    p_persisted_skip_count: persistedSkips,
  });
  fail(error);
  if (data !== true) throw new Error("code_intelligence_completion_not_persisted");
}

export async function failCodeAnalysisRun(
  input: {
    analysisRunId: string;
    claimToken: string;
    failureStage: CodeAnalysisFailureStage | null;
    failureCategory: string;
    retryable: boolean;
    cleanupFailureCategory?: "cleanup_failed";
  },
  client: SupabaseClient = createSupabaseServerClient(),
) {
  const { data, error } = await client.rpc("fail_code_analysis_run", {
    p_analysis_run_id: input.analysisRunId,
    p_claim_token: input.claimToken,
    p_failure_category: input.failureCategory,
    p_failure_stage: input.failureStage,
    p_retryable: input.retryable,
    p_cleanup_failure_category: input.cleanupFailureCategory ?? null,
  });
  fail(error);
  if (data !== true) throw new Error("code_intelligence_failure_claim_mismatch");
}
