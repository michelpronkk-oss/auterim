import "server-only";
import { z } from "zod";
import type { PolicyDecision } from "@/lib/intelligence/policy";
import type { PolicyThresholds } from "@/lib/intelligence/policy";
import type { EvidenceQuality } from "@/lib/intelligence/evidence";
import type { JevJudgment } from "@/lib/intelligence/taxonomy";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const changeSchema = z.object({
  sourceName: z.string().max(160),
  sourceType: z.string().max(40),
  dependencyName: z.string().max(120),
  beforeVersion: z.number().int().positive(),
  afterVersion: z.number().int().positive(),
  diffText: z.string().max(16_384),
  addedLines: z.number().int().nonnegative(),
  removedLines: z.number().int().nonnegative(),
  diffTruncated: z.boolean(),
  beforeBytes: z.number().int().nonnegative(),
  afterBytes: z.number().int().nonnegative(),
});
const beginSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), replayed: z.literal(true) }),
  z.object({ status: z.literal("busy") }),
  z.object({
    status: z.literal("processing"),
    sourceChangeId: z.string().uuid(),
    evidenceFingerprint: z.string().regex(/^[a-f0-9]{32}$/),
    engineVersion: z.string().min(1).max(80),
    policyVersion: z.string().min(1).max(80),
    provider: z.string().min(1).max(80),
    model: z.string().min(1).max(160),
    change: changeSchema,
  }),
]);

export type IntelligenceStart = z.infer<typeof beginSchema>;
export interface ChangeIntelligenceRepository {
  begin(input: {
    sourceChangeId: string;
    triggerRunId: string;
    attemptNumber: number;
  }): Promise<IntelligenceStart>;
  getClassifierSummary(sourceChangeId: string): Promise<{
    material: boolean;
    category: string;
    confidence: number;
    decisionStatus: "classified" | "review_required";
  } | null>;
  record(input: {
    sourceChangeId: string;
    evidenceFingerprint: string;
    triggerRunId: string;
    attemptNumber: number;
    judgment: JevJudgment;
    quality: EvidenceQuality;
    policy: PolicyDecision;
    policyIdentity: PersistedPolicyIdentity;
  }): Promise<void>;
  fail(input: {
    sourceChangeId: string;
    evidenceFingerprint: string;
    triggerRunId: string;
    attemptNumber: number;
    category: string;
  }): Promise<void>;
  getQueuedSourceChangeIds(limit?: number): Promise<string[]>;
}

export type PersistedPolicyIdentity = {
  mode: "active_calibrated" | "shadow" | "fail_closed";
  policyVersion: string;
  thresholdVersion: string;
  calibrationCorpusVersion: string;
  calibrationVersion: string;
  calibrationFixtureCount: number;
  thresholdFingerprint: string | null;
  thresholds: PolicyThresholds;
  readiness: Record<string, unknown>;
  holdoutMetrics: Record<string, unknown> | null;
};

function throwOnError(error: { message: string } | null) {
  if (error) throw new Error("Intelligence persistence operation failed.");
}

export class SupabaseChangeIntelligenceRepository implements ChangeIntelligenceRepository {
  private readonly client = createSupabaseServerClient();

  async begin(input: { sourceChangeId: string; triggerRunId: string; attemptNumber: number }) {
    const { data, error } = await this.client.rpc("begin_source_change_intelligence", {
      p_source_change_id: input.sourceChangeId,
      p_trigger_run_id: input.triggerRunId,
      p_attempt_number: input.attemptNumber,
    });
    throwOnError(error);
    return beginSchema.parse(data) as IntelligenceStart;
  }

  async getClassifierSummary(sourceChangeId: string) {
    const { data, error } = await this.client
      .from("source_change_classifications")
      .select("material,category,confidence,decision_status,status")
      .eq("change_id", sourceChangeId)
      .eq("status", "classified")
      .order("classified_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    throwOnError(error);
    if (
      !data ||
      typeof data.material !== "boolean" ||
      typeof data.category !== "string" ||
      typeof data.confidence !== "number" ||
      (data.decision_status !== "classified" && data.decision_status !== "review_required")
    )
      return null;
    return {
      material: data.material,
      category: data.category,
      confidence: data.confidence,
      decisionStatus: data.decision_status,
    };
  }

  async record(input: {
    sourceChangeId: string;
    evidenceFingerprint: string;
    triggerRunId: string;
    attemptNumber: number;
    judgment: JevJudgment;
    quality: EvidenceQuality;
    policy: PolicyDecision;
    policyIdentity: PersistedPolicyIdentity;
  }) {
    const { error } = await this.client.rpc("record_source_change_intelligence_v3", {
      p_source_change_id: input.sourceChangeId,
      p_evidence_fingerprint: input.evidenceFingerprint,
      p_trigger_run_id: input.triggerRunId,
      p_attempt_number: input.attemptNumber,
      p_route: input.policy.route,
      p_probabilities: input.judgment.probabilities,
      p_confidence: input.judgment.confidence,
      p_evidence_quality: input.quality,
      p_proposed_policy_state: input.policy.state,
      p_policy_reason: input.policy.reason,
      p_response_model: input.judgment.responseModel || null,
      p_policy_mode: input.policyIdentity.mode,
      p_active_policy_version: input.policyIdentity.policyVersion,
      p_threshold_version: input.policyIdentity.thresholdVersion,
      p_calibration_corpus_version: input.policyIdentity.calibrationCorpusVersion,
      p_calibration_version: input.policyIdentity.calibrationVersion,
      p_calibration_fixture_count: input.policyIdentity.calibrationFixtureCount,
      p_threshold_fingerprint: input.policyIdentity.thresholdFingerprint,
      p_policy_thresholds: input.policyIdentity.thresholds,
      p_readiness_metadata: input.policyIdentity.readiness,
      p_holdout_metrics: input.policyIdentity.holdoutMetrics,
      p_latency_ms: input.judgment.latencyMs,
      p_input_tokens: input.judgment.inputTokens,
      p_output_tokens: input.judgment.outputTokens,
      p_cost_usd: input.judgment.costUsd,
    });
    throwOnError(error);
  }

  async fail(input: {
    sourceChangeId: string;
    evidenceFingerprint: string;
    triggerRunId: string;
    attemptNumber: number;
    category: string;
  }) {
    const { error } = await this.client.rpc("record_source_change_intelligence_failure", {
      p_source_change_id: input.sourceChangeId,
      p_evidence_fingerprint: input.evidenceFingerprint,
      p_trigger_run_id: input.triggerRunId,
      p_attempt_number: input.attemptNumber,
      p_error_category: input.category,
    });
    throwOnError(error);
  }

  async getQueuedSourceChangeIds(limit = 100) {
    const { data, error } = await this.client.rpc("list_queued_source_change_intelligence_ids", {
      p_limit: limit,
    });
    throwOnError(error);
    return z
      .array(z.object({ source_change_id: z.string().uuid() }))
      .parse(data ?? [])
      .map((row) => row.source_change_id);
  }
}
