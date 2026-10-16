import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { classifySourceChange, type SemanticClassifier } from "@/lib/monitoring/classification";
import { evaluateSourceChangeIntelligence } from "@/lib/intelligence/decision";
import { SupabaseIntelligenceRouterRepository } from "@/lib/intelligence/router-repository";
import type { IntelligenceRoute, JevJudgment } from "@/lib/intelligence/taxonomy";

const enabled = process.env.AUTERIM_M1577_POLICY_DOCKER_ACCEPTANCE === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey = process.env.AUTERIM_M15_LOCAL_SUPABASE_SECRET_KEY ?? "";
const client =
  enabled && url && serviceKey
    ? createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
    : null;

async function must<T>(
  query: PromiseLike<{ data: T; error: { message: string } | null }>,
): Promise<NonNullable<T>> {
  const result = await query;
  if (result.error || result.data === null) {
    const error = result.error as unknown as { code?: unknown; message?: string } | null;
    const code = error?.code === undefined ? "no_data" : String(error.code);
    const message = String(error?.message ?? "");
    const constraint =
      /check constraint "([a-z0-9_]{1,100})"/i.exec(message)?.[1] ?? "unknown_constraint";
    throw new Error(`active_policy_fixture_persistence_failed:${code}:${constraint}`);
  }
  return result.data as NonNullable<T>;
}

async function createSourceChange(label: string, sourceType: string, diffTruncated = false) {
  if (!client) throw new Error("active_policy_docker_guard_required");
  const nonce = randomUUID();
  const dependency = await must(
    client
      .from("dependency_catalog")
      .insert({
        slug: `m1577-policy-${nonce.replaceAll("-", "").slice(0, 14)}`,
        name: `M15.77 policy fixture ${label}`,
        category: "developer-tools",
        website_url: "https://fixture.invalid",
      })
      .select("id")
      .single(),
  );
  const source = await must(
    client
      .from("source_catalog")
      .insert({
        dependency_id: dependency.id,
        name: `Fixture ${label}`,
        source_type: sourceType,
        url: "https://fixture.invalid/changelog",
        default_interval_seconds: 86_400,
      })
      .select("id")
      .single(),
  );
  const before = `The provider SDK behavior before ${label} is stable.`;
  const after = `The provider SDK behavior after ${label} changes safely.`;
  const snapshots: string[] = [];
  const runIds: string[] = [];
  for (let index = 0; index < 2; index++) {
    const id = randomUUID();
    const body = index === 0 ? before : after;
    const runId = randomUUID();
    await must(
      client
        .from("scan_runs")
        .insert({
          id: runId,
          source_id: source.id,
          trigger_run_id: `m1577-policy-${nonce}-${index}`,
          attempt_number: 1,
          status: "success",
          finished_at: new Date().toISOString(),
        })
        .select("id")
        .single(),
    );
    runIds.push(runId);
    await must(
      client
        .from("source_snapshots")
        .insert({
          id,
          source_id: source.id,
          scan_run_id: runId,
          previous_snapshot_id: index === 0 ? null : snapshots[0],
          version: index + 1,
          content_hash: createHash("sha256").update(body).digest("hex"),
          normalized_content: body,
          normalized_bytes: Buffer.byteLength(body),
          content_bytes: Buffer.byteLength(body),
        })
        .select("id")
        .single(),
    );
    snapshots.push(id);
  }
  const change = await must(
    client
      .from("source_changes")
      .insert({
        source_id: source.id,
        scan_run_id: runIds[1],
        previous_snapshot_id: snapshots[0],
        new_snapshot_id: snapshots[1],
        diff_text: `-${before}\n+${after}`,
        added_lines: 1,
        removed_lines: 1,
        diff_truncated: diffTruncated,
        previous_bytes: Buffer.byteLength(before),
        new_bytes: Buffer.byteLength(after),
      })
      .select("id")
      .single(),
  );
  return change.id as string;
}

function fixedClassifier(input: {
  material: boolean;
  category:
    | "api_change"
    | "deprecation"
    | "sdk_change"
    | "security"
    | "pricing"
    | "documentation"
    | "other";
}): SemanticClassifier {
  return {
    providerId: "openai",
    modelId: "m1577-deterministic-fixture-v1",
    async classify(packet) {
      const excerpt = packet.currentEvidence.split("\n").at(-1) ?? "changed";
      return {
        classification: {
          ...input,
          affectedEntities: ["provider SDK"],
          severityHint: input.material ? "high" : "informational",
          confidence: 0.99,
          summary: "Deterministic fixture classification.",
          evidence: [{ type: "added", excerpt: excerpt.slice(0, 280) }],
          reasoningSummary: "Fixture adapter exercises canonical validation and persistence.",
        },
        inputTokens: 0,
        outputTokens: 0,
      };
    },
  };
}

function fixedJev(
  route: IntelligenceRoute,
  options: {
    material?: number;
    critical?: number;
    evidence?: number;
    docs?: number;
    escalation?: number;
  } = {},
): JevJudgment {
  return {
    route,
    confidence: route === "uncertain" ? 0.2 : 0.99,
    probabilities: {
      material: options.material ?? (route === "docs_noise" ? 0.01 : 0.99),
      criticalChange: options.critical ?? 0.01,
      evidenceSufficient: options.evidence ?? 0.99,
      docsNoise: options.docs ?? (route === "docs_noise" ? 0.99 : 0.01),
      requiresEscalation: options.escalation ?? 0.01,
      route: { [route]: 0.99 },
    } as JevJudgment["probabilities"],
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    latencyMs: 0,
    responseModel: "typesafe/jev-1.14-fixture-compatible",
  };
}

describe.skipIf(!enabled)(
  "M15.77 calibrated policy → canonical router on isolated Docker Supabase",
  () => {
    it("executes material SDK, incomplete critical, uncertain, docs noise, and disagreement cases", async () => {
      if (!client) throw new Error("active_policy_docker_guard_required");
      expect(url).toBe("http://127.0.0.1:57521");
      expect(process.env.AUTERIM_M15_LOCAL_INTEGRATION).toBe("1");
      const router = new SupabaseIntelligenceRouterRepository();
      const cases = [
        {
          name: "material-sdk",
          type: "changelog",
          classifier: { material: true, category: "sdk_change" as const },
          route: "sdk_change" as const,
          expected: "continue_candidate",
          target: "repository_dependency_exposure_analysis",
        },
        {
          name: "critical-sdk-review-not-blocked",
          type: "changelog",
          classifier: { material: true, category: "sdk_change" as const },
          route: "sdk_change" as const,
          options: { critical: 0.96, escalation: 0.89 },
          expected: "continue_candidate",
          target: "repository_dependency_exposure_analysis",
          expectedReview: "review_required",
          expectedReviewReason: "critical_change",
        },
        {
          name: "endpoint-removal-review-not-blocked",
          type: "api",
          classifier: { material: true, category: "api_change" as const },
          route: "breaking_api_change" as const,
          options: { critical: 0.96, escalation: 0.89 },
          expected: "continue_candidate",
          target: "dependency_impact_repository_exposure_candidate",
          expectedReview: "review_required",
          expectedReviewReason: "critical_change",
        },
        {
          name: "auth-scope-review-not-blocked",
          type: "api",
          classifier: { material: true, category: "security" as const },
          route: "auth_or_security_change" as const,
          options: { critical: 0.96, escalation: 0.89 },
          expected: "continue_candidate",
          target: "integration_auth_risk_analysis",
          expectedReview: "review_required",
          expectedReviewReason: "critical_change",
        },
        {
          name: "pricing-material-clear",
          type: "pricing",
          classifier: { material: true, category: "pricing" as const },
          route: "pricing_change" as const,
          expected: "continue_candidate",
          target: "commercial_impact_analysis",
          expectedReview: "none",
        },
        {
          name: "critical-incomplete",
          type: "deprecation",
          truncated: true,
          classifier: { material: true, category: "deprecation" as const },
          route: "deprecation" as const,
          expectedRoute: "uncertain" as const,
          options: { evidence: 0.1 },
          expected: "insufficient_evidence",
          target: "evidence_escalation",
          expectedReview: "review_required",
          expectedReviewReason: "evidence_incomplete",
        },
        {
          name: "uncertain-low-confidence",
          type: "documentation",
          classifier: { material: false, category: "documentation" as const },
          route: "uncertain" as const,
          expected: "escalate",
          target: "evidence_escalation",
          expectedReview: "review_required",
          expectedReviewReason: "analysis_uncertain",
        },
        {
          name: "docs-noise",
          type: "documentation",
          classifier: { material: false, category: "documentation" as const },
          route: "docs_noise" as const,
          expected: "suppress_candidate",
          target: "suppress_archive",
        },
        {
          name: "classifier-jev-disagreement",
          type: "pricing",
          classifier: { material: true, category: "pricing" as const },
          route: "docs_noise" as const,
          expected: "escalate",
          target: "evidence_escalation",
          expectedReview: "review_required",
          expectedReviewReason: "classifier_model_conflict",
        },
      ];

      for (const item of cases) {
        const sourceChangeId = await createSourceChange(
          item.name,
          item.type,
          item.truncated ?? false,
        );
        const classification = await classifySourceChange(
          {
            changeId: sourceChangeId,
            triggerRunId: `m1577-classifier-${randomUUID()}`,
            attemptNumber: 1,
          },
          { classifier: fixedClassifier(item.classifier) },
        );
        expect(classification.status).toBe("classified");
        const outcome = await evaluateSourceChangeIntelligence(
          { sourceChangeId, triggerRunId: `m1577-jev-${randomUUID()}`, attemptNumber: 1 },
          {
            evaluator: async () => fixedJev(item.route, item.options),
            enqueueRoute: async (id) => {
              await router.persistRouteIntent(id);
            },
          },
        );
        expect(outcome.status).toBe("completed");
        const decision = await must(
          client
            .from("change_intelligence_decisions")
            .select(
              "proposed_route,proposed_policy_state,review_disposition,review_reason,policy_mode,active_policy_version,threshold_version,calibration_corpus_version,calibration_version,calibration_fixture_count,threshold_fingerprint,policy_thresholds,readiness_metadata,holdout_metrics",
            )
            .eq("source_change_id", sourceChangeId)
            .single(),
        );
        expect(decision.proposed_policy_state).toBe(item.expected);
        expect(decision.review_disposition, item.name).toBe(item.expectedReview ?? "none");
        expect(decision.review_reason, item.name).toBe(item.expectedReviewReason ?? null);
        expect(decision.policy_mode).toBe("active_calibrated");
        expect(decision.active_policy_version).toBe("intelligence-policy-active-v2");
        expect(decision.threshold_version).toBe("m1575a-calibrated-thresholds-v1");
        expect(decision.calibration_corpus_version).toBe("explicit-stratified-64-v2");
        expect(decision.calibration_version).toBe("m1575a-stratified-64-v2");
        expect(decision.calibration_fixture_count).toBe(32);
        expect(decision.threshold_fingerprint).toMatch(/^[a-f0-9]{64}$/);
        const intent = await must(
          client
            .from("intelligence_route_intents")
            .select(
              "route,policy_state,policy_version,review_disposition,review_reason,route_target,route_status",
            )
            .eq("source_change_id", sourceChangeId)
            .single(),
        );
        expect(intent.route).toBe(item.expectedRoute ?? item.route);
        expect(intent.policy_state).toBe(item.expected);
        expect(intent.policy_version).toBe("intelligence-policy-active-v2");
        expect(intent.review_disposition, item.name).toBe(item.expectedReview ?? "none");
        expect(intent.review_reason, item.name).toBe(item.expectedReviewReason ?? null);
        expect(intent.route_target).toBe(item.target);
        if (item.name === "docs-noise") expect(intent.route_status).toBe("suppressed");
        else if (item.expected === "continue_candidate")
          expect(intent.route_status).toBe("pending");
        else expect(intent.route_status).toBe("queued");
      }
      const sideEffects = await client.from("customer_impact_dispatch_queue").select("id").limit(1);
      expect(sideEffects.error).toBeNull();
      expect(sideEffects.data).toEqual([]);
    });
  },
);
