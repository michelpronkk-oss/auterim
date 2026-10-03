import "server-only";
import { z } from "zod";
import type {
  ChangeClassificationRepository,
  ClassificationOutcome,
  ClassificationStart,
  ClassifiedDecision,
} from "@/lib/monitoring/classification";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const classifiedDecisionSchema = z
  .object({
    material: z.boolean(),
    category: z.enum([
      "pricing",
      "api_change",
      "deprecation",
      "limits",
      "terms",
      "feature_change",
      "availability",
      "documentation",
      "security",
      "other",
    ]),
    affectedEntities: z.array(z.string().trim().min(1).max(120)).max(5),
    severityHint: z.enum(["critical", "high", "medium", "low", "informational"]),
    confidence: z.number().min(0).max(1),
    summary: z.string().trim().min(1).max(1200),
    evidence: z
      .array(
        z
          .object({
            type: z.enum(["added", "removed", "changed"]),
            excerpt: z.string().trim().min(1).max(280),
          })
          .strict(),
      )
      .max(5),
    reasoningSummary: z.string().trim().min(1).max(600),
    decisionStatus: z.enum(["classified", "review_required"]),
  })
  .strict();
const changeSchema = z.object({
  sourceName: z.string().max(160),
  sourceType: z.string().max(40),
  sourceUrl: z.string().url(),
  dependencyName: z.string().max(120),
  beforeVersion: z.number().int().positive(),
  afterVersion: z.number().int().positive(),
  diffText: z.string().max(16_384),
  addedLines: z.number().int().nonnegative(),
  removedLines: z.number().int().nonnegative(),
  diffTruncated: z.boolean(),
  beforeBytes: z.number().int().nonnegative().max(524_288),
  afterBytes: z.number().int().nonnegative().max(524_288),
});
const classificationStartSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("busy"), changeId: z.string().uuid() }),
  z.object({
    status: z.literal("classified"),
    changeId: z.string().uuid(),
    classification: classifiedDecisionSchema,
    replayed: z.literal(true),
  }),
  z.object({
    status: z.literal("processing"),
    changeId: z.string().uuid(),
    schemaVersion: z.number().int().positive(),
    promptVersion: z.string().min(1).max(80),
    classifierVersion: z.string().min(1).max(80),
    provider: z.string().min(1).max(80),
    evidenceFingerprint: z.string().regex(/^[a-f0-9]{32}$/),
    triggerRunId: z.string().min(1).max(255),
    attemptNumber: z.number().int().positive(),
    change: changeSchema,
  }),
]);
const classificationOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("busy"), changeId: z.string().uuid() }),
  z.object({
    status: z.literal("classified"),
    changeId: z.string().uuid(),
    classification: classifiedDecisionSchema,
    replayed: z.boolean(),
  }),
]);

function throwOnError(error: { message: string } | null) {
  if (error) throw new Error("Supabase classification operation failed.");
}

export class SupabaseChangeClassificationRepository implements ChangeClassificationRepository {
  private readonly client = createSupabaseServerClient();

  async begin(
    changeId: string,
    triggerRunId: string,
    attemptNumber: number,
  ): Promise<ClassificationStart> {
    const { data, error } = await this.client.rpc("begin_source_change_classification", {
      p_source_change_id: changeId,
      p_trigger_run_id: triggerRunId,
      p_attempt_number: attemptNumber,
      p_classifier_version: "semantic-v1",
      p_schema_version: 1,
      p_prompt_version: "materiality-v1",
      p_provider: "ai-gateway",
    });
    throwOnError(error);
    return classificationStartSchema.parse(data) as ClassificationStart;
  }

  async record(input: {
    changeId: string;
    classifierVersion: string;
    evidenceFingerprint: string;
    triggerRunId: string;
    attemptNumber: number;
    provider: string;
    modelId: string;
    schemaVersion: number;
    promptVersion: string;
    result: ClassifiedDecision;
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number;
  }): Promise<ClassificationOutcome> {
    const { data, error } = await this.client.rpc("record_source_change_classification", {
      p_source_change_id: input.changeId,
      p_classifier_version: input.classifierVersion,
      p_evidence_fingerprint: input.evidenceFingerprint,
      p_trigger_run_id: input.triggerRunId,
      p_attempt_number: input.attemptNumber,
      p_provider: input.provider,
      p_model: input.modelId,
      p_schema_version: input.schemaVersion,
      p_prompt_version: input.promptVersion,
      p_material: input.result.material,
      p_category: input.result.category,
      p_affected_entities: input.result.affectedEntities,
      p_severity_hint: input.result.severityHint,
      p_confidence: input.result.confidence,
      p_summary: input.result.summary,
      p_evidence: input.result.evidence,
      p_reasoning_summary: input.result.reasoningSummary,
      p_decision_status: input.result.decisionStatus,
      p_input_tokens: input.inputTokens,
      p_output_tokens: input.outputTokens,
      p_latency_ms: input.latencyMs,
    });
    throwOnError(error);
    return classificationOutcomeSchema.parse(data);
  }

  async fail(input: {
    changeId: string;
    classifierVersion: string;
    evidenceFingerprint: string;
    provider: string;
    schemaVersion: number;
    promptVersion: string;
    triggerRunId: string;
    attemptNumber: number;
    category: string;
    summary: string;
  }) {
    const { error } = await this.client.rpc("record_source_change_classification_failure", {
      p_source_change_id: input.changeId,
      p_classifier_version: input.classifierVersion,
      p_evidence_fingerprint: input.evidenceFingerprint,
      p_trigger_run_id: input.triggerRunId,
      p_attempt_number: input.attemptNumber,
      p_provider: input.provider,
      p_schema_version: input.schemaVersion,
      p_prompt_version: input.promptVersion,
      p_error_category: input.category,
      p_error_summary: input.summary,
    });
    throwOnError(error);
  }

  async getQueuedChangeIds(limit = 100) {
    const { data, error } = await this.client.rpc("list_queued_source_change_classification_ids", {
      p_limit: limit,
    });
    throwOnError(error);
    return z
      .array(z.object({ change_id: z.string().uuid() }))
      .parse(data ?? [])
      .map((row) => row.change_id);
  }
}
