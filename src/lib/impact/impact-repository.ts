import "server-only";
import { z } from "zod";
import type {
  CustomerImpactRepository,
  CustomerImpact,
  ImpactAssessmentStart,
} from "@/lib/impact/impact";
import { dependencyUsageSchema } from "@/lib/impact/impact";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function throwOnError(error: { message: string } | null) {
  if (error) throw new Error("Supabase customer impact operation failed.");
}

const assessmentResultSchema = z.object({
  relevant: z.boolean(),
  relevance: z.enum(["high", "medium", "low", "none"]),
  severity: z.enum(["critical", "high", "medium", "low", "informational"]),
  affectedAreas: z.array(dependencyUsageSchema).max(8),
  impactSummary: z.string(),
  whyItMatters: z.string(),
  actionRequired: z.boolean(),
  recommendedAction: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  missingContext: z.array(z.string()).max(10),
  evidenceRefs: z
    .array(
      z.object({ source: z.enum(["global_evidence", "dependency_context"]), excerpt: z.string() }),
    )
    .min(1)
    .max(8),
});

const beginResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("busy"), id: z.string().uuid() }),
  z.object({
    status: z.literal("assessed"),
    id: z.string().uuid(),
    replayed: z.literal(true),
    result: assessmentResultSchema,
  }),
  z.object({
    status: z.literal("processing"),
    id: z.string().uuid(),
    attemptCount: z.number().int().positive(),
  }),
]);

export class SupabaseCustomerImpactRepository implements CustomerImpactRepository {
  private readonly client = createSupabaseServerClient();

  async loadPacket(workspaceDependencyId: string, sourceChangeClassificationId: string) {
    const { data, error } = await this.client.rpc("load_customer_impact_packet", {
      p_workspace_dependency_id: workspaceDependencyId,
      p_source_change_classification_id: sourceChangeClassificationId,
    });
    throwOnError(error);
    return data;
  }

  async begin(input: {
    workspaceDependencyId: string;
    sourceChangeClassificationId: string;
    contextFingerprint: string;
    impactEngineVersion: string;
    schemaVersion: number;
    promptVersion: string;
    provider: string;
    triggerRunId: string;
    attemptNumber: number;
  }): Promise<ImpactAssessmentStart> {
    const { data, error } = await this.client.rpc("begin_customer_impact_assessment", {
      p_workspace_dependency_id: input.workspaceDependencyId,
      p_source_change_classification_id: input.sourceChangeClassificationId,
      p_context_fingerprint: input.contextFingerprint,
      p_impact_engine_version: input.impactEngineVersion,
      p_schema_version: input.schemaVersion,
      p_prompt_version: input.promptVersion,
      p_provider: input.provider,
      p_trigger_run_id: input.triggerRunId,
      p_attempt_number: input.attemptNumber,
    });
    throwOnError(error);
    return beginResultSchema.parse(data);
  }

  async record(input: {
    id: string;
    triggerRunId: string;
    attemptNumber: number;
    provider: string;
    model: string;
    result: CustomerImpact;
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number;
  }) {
    const { data, error } = await this.client.rpc("record_customer_impact_assessment", {
      p_id: input.id,
      p_trigger_run_id: input.triggerRunId,
      p_attempt_number: input.attemptNumber,
      p_provider: input.provider,
      p_model: input.model,
      p_relevant: input.result.relevant,
      p_relevance: input.result.relevance,
      p_severity: input.result.severity,
      p_affected_areas: input.result.affectedAreas,
      p_impact_summary: input.result.impactSummary,
      p_why_it_matters: input.result.whyItMatters,
      p_action_required: input.result.actionRequired,
      p_recommended_action: input.result.recommendedAction,
      p_confidence: input.result.confidence,
      p_missing_context: input.result.missingContext,
      p_evidence_refs: input.result.evidenceRefs,
      p_input_tokens: input.inputTokens,
      p_output_tokens: input.outputTokens,
      p_latency_ms: input.latencyMs,
    });
    throwOnError(error);
    return data;
  }

  async fail(input: {
    id: string;
    triggerRunId: string;
    attemptNumber: number;
    category: string;
    summary: string;
  }) {
    const { error } = await this.client.rpc("fail_customer_impact_assessment", {
      p_id: input.id,
      p_trigger_run_id: input.triggerRunId,
      p_attempt_number: input.attemptNumber,
      p_error_category: input.category,
      p_error_summary: input.summary,
    });
    throwOnError(error);
  }
}

const impactQueueItemSchema = z.object({
  queue_id: z.string().uuid(),
  workspace_dependency_id: z.string().uuid(),
  source_change_classification_id: z.string().uuid(),
  context_revision: z.number().int().nonnegative(),
});

export async function listCustomerImpactQueueItems(sourceChangeId?: string) {
  const client = createSupabaseServerClient();
  const { data, error } = await client.rpc("list_customer_impact_dispatch_queue", {
    p_source_change_id: sourceChangeId ?? null,
    p_limit: 100,
  });
  throwOnError(error);
  return z.array(impactQueueItemSchema).parse(data ?? []);
}

async function updateImpactQueue(
  queueId: string,
  rpcName: string,
  args: Record<string, unknown> = {},
) {
  const client = createSupabaseServerClient();
  const { error } = await client.rpc(rpcName, { p_queue_id: queueId, ...args });
  throwOnError(error);
}

export async function markCustomerImpactQueueDispatched(queueId: string) {
  return updateImpactQueue(queueId, "mark_customer_impact_queue_dispatched");
}

export async function markCustomerImpactQueueComplete(queueId: string) {
  return updateImpactQueue(queueId, "mark_customer_impact_queue_complete");
}

export async function markCustomerImpactQueueFailed(queueId: string, category: string) {
  return updateImpactQueue(queueId, "mark_customer_impact_queue_failed", {
    p_error_category: category,
  });
}
