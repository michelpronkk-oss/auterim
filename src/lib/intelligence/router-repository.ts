import "server-only";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  INTELLIGENCE_ROUTES,
  INTELLIGENCE_ROUTE_TARGETS,
  type IntelligenceRouteTarget,
} from "@/lib/intelligence/taxonomy";

const routeTargets = Object.values(INTELLIGENCE_ROUTE_TARGETS) as [
  IntelligenceRouteTarget,
  ...IntelligenceRouteTarget[],
];

const routeIntentSchema = z.object({
  id: z.string().uuid(),
  sourceChangeId: z.string().uuid(),
  decisionId: z.string().uuid(),
  workspaceId: z.string().uuid().nullable(),
  productId: z.string().uuid().nullable(),
  route: z.enum(INTELLIGENCE_ROUTES),
  policyState: z.enum([
    "suppress_candidate",
    "continue_candidate",
    "escalate",
    "insufficient_evidence",
  ]),
  routeTarget: z.enum(routeTargets),
  routeStatus: z.enum([
    "suppressed",
    "pending",
    "queued",
    "dispatching",
    "dispatched",
    "completed",
    "failed",
  ]),
  idempotencyKey: z.string().min(1).max(160),
  replayed: z.boolean(),
});

const claimSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("claimed"),
    id: z.string().uuid(),
    claimToken: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(200),
  }),
  z.object({
    status: z.enum(["queued", "dispatching", "dispatched", "completed", "failed"]),
    id: z.string().uuid(),
    dispatched: z.literal(false),
  }),
]);

const evidenceClaimSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("claimed"),
    id: z.string().uuid(),
    routeIntentId: z.string().uuid(),
    sourceChangeId: z.string().uuid(),
    claimToken: z.string().uuid(),
    attemptCount: z.number().int().min(1).max(3),
    sourceType: z.string().max(40),
    sourceName: z.string().max(160),
    dependencyName: z.string().max(120),
    beforeVersion: z.number().int().positive(),
    afterVersion: z.number().int().positive(),
    diffText: z.string().max(16384),
    previousEvidence: z.string().max(16400),
    currentEvidence: z.string().max(16400),
    previousBytes: z.number().int().nonnegative(),
    currentBytes: z.number().int().nonnegative(),
    priorDiffTruncated: z.boolean(),
  }),
  z.object({
    status: z.enum(["busy", "completed", "insufficient_evidence", "exhausted"]),
    replayed: z.boolean(),
  }),
]);

function fail(error: { message: string } | null) {
  if (error) throw new Error("Intelligence router persistence operation failed.");
}

export class SupabaseIntelligenceRouterRepository {
  private readonly client = createSupabaseServerClient();

  async persistRouteIntent(sourceChangeId: string) {
    const { data, error } = await this.client.rpc("persist_intelligence_route_intent", {
      p_source_change_id: sourceChangeId,
      p_router_version: "intelligence-router-v1",
    });
    fail(error);
    return routeIntentSchema.parse(data);
  }

  async claimRouteDispatch(routeIntentId: string) {
    const { data, error } = await this.client.rpc("claim_intelligence_route_dispatch", {
      p_route_intent_id: routeIntentId,
    });
    fail(error);
    return claimSchema.parse(data);
  }

  async markRouteDispatched(routeIntentId: string, claimToken: string, triggerRunId: string) {
    const { data, error } = await this.client.rpc("mark_intelligence_route_dispatched", {
      p_route_intent_id: routeIntentId,
      p_claim_token: claimToken,
      p_trigger_run_id: triggerRunId,
    });
    fail(error);
    if (data !== true) throw new Error("Intelligence route dispatch was not persisted.");
  }

  async releaseRouteDispatch(routeIntentId: string, claimToken: string, category: string) {
    const { error } = await this.client.rpc("release_intelligence_route_dispatch", {
      p_route_intent_id: routeIntentId,
      p_claim_token: claimToken,
      p_failure_category: category,
    });
    fail(error);
  }

  async claimEvidenceEscalation(routeIntentId: string, triggerRunId: string) {
    const { data, error } = await this.client.rpc("claim_intelligence_evidence_escalation", {
      p_route_intent_id: routeIntentId,
      p_trigger_run_id: triggerRunId,
    });
    fail(error);
    return evidenceClaimSchema.parse(data);
  }

  async completeEvidenceEscalation(input: {
    routeIntentId: string;
    claimToken: string;
    terminalState: "completed" | "insufficient_evidence";
    reason: string;
    summary: Record<string, unknown>;
    fingerprint: string;
  }) {
    const { data, error } = await this.client.rpc("complete_intelligence_evidence_escalation", {
      p_route_intent_id: input.routeIntentId,
      p_claim_token: input.claimToken,
      p_terminal_state: input.terminalState,
      p_last_reason: input.reason,
      p_evidence_summary: input.summary,
      p_evidence_fingerprint: input.fingerprint,
    });
    fail(error);
    if (data !== true)
      throw new Error("Intelligence evidence escalation completion was not persisted.");
  }

  async releaseEvidenceEscalation(routeIntentId: string, claimToken: string, category: string) {
    const { error } = await this.client.rpc("release_intelligence_evidence_escalation", {
      p_route_intent_id: routeIntentId,
      p_claim_token: claimToken,
      p_failure_category: category,
    });
    fail(error);
  }
}

export type RouteIntent = z.infer<typeof routeIntentSchema>;
export type RouteDispatchClaim = z.infer<typeof claimSchema>;
export type EvidenceEscalationClaim = z.infer<typeof evidenceClaimSchema>;
