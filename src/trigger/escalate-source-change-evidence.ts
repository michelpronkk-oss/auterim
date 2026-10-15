import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { evaluateBoundedEscalationEvidence } from "@/lib/intelligence/escalation";
import { SupabaseIntelligenceRouterRepository } from "@/lib/intelligence/router-repository";

export const escalateSourceChangeEvidenceTask = schemaTask({
  id: "escalate-source-change-evidence",
  schema: z.object({ routeIntentId: z.string().uuid() }),
  retry: {
    maxAttempts: 5,
    minTimeoutInMs: 30_000,
    maxTimeoutInMs: 60_000,
    factor: 2,
    randomize: false,
  },
  concurrency: { total: 2 },
  run: async ({ routeIntentId }, { ctx }) => {
    const repository = new SupabaseIntelligenceRouterRepository();
    const claim = await repository.claimEvidenceEscalation(routeIntentId, ctx.run.id);
    if (claim.status !== "claimed") {
      if (claim.status === "busy") throw new Error("intelligence_evidence_escalation_busy");
      return { routeIntentId, status: claim.status, replayed: claim.replayed };
    }
    try {
      const result = evaluateBoundedEscalationEvidence(claim);
      await repository.completeEvidenceEscalation({
        routeIntentId,
        claimToken: claim.claimToken,
        terminalState: result.terminalState,
        reason: result.reason,
        summary: result.summary,
        fingerprint: result.fingerprint,
      });
      return {
        routeIntentId,
        status: result.terminalState,
        evidenceFingerprint: result.fingerprint,
      };
    } catch {
      await repository.releaseEvidenceEscalation(
        routeIntentId,
        claim.claimToken,
        "evidence_recheck_failed",
      );
      throw new Error("intelligence_evidence_escalation_failed");
    }
  },
});
