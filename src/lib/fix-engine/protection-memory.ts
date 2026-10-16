export type VerifiedFixOutcome = {
  fixRunId: string;
  identityFingerprint: string;
  humanDecision?: "accepted" | "rejected";
  mergedSha?: string;
  productionSha?: string;
  runtimeOutcome?: "healthy" | "regressed" | "unknown";
};

export function buildProtectionMemoryEvent(input: VerifiedFixOutcome) {
  if (
    !/^[a-f0-9-]{36}$/i.test(input.fixRunId) ||
    !/^[a-f0-9]{64}$/i.test(input.identityFingerprint)
  )
    throw new Error("invalid_fix_memory_identity");
  if (!input.humanDecision && !input.mergedSha && !input.productionSha && !input.runtimeOutcome)
    return null;
  if (input.productionSha && !/^[a-f0-9]{40,64}$/i.test(input.productionSha))
    throw new Error("invalid_fix_memory_production_sha");
  if (input.mergedSha && !/^[a-f0-9]{40,64}$/i.test(input.mergedSha))
    throw new Error("invalid_fix_memory_merge_sha");
  return {
    eventType: "fix_outcome_candidate" as const,
    fixRunId: input.fixRunId,
    identityFingerprint: input.identityFingerprint,
    humanDecision: input.humanDecision ?? null,
    mergedSha: input.mergedSha?.toLowerCase() ?? null,
    productionSha: input.productionSha?.toLowerCase() ?? null,
    runtimeOutcome: input.runtimeOutcome ?? "unknown",
    trainingEligible: Boolean(
      input.humanDecision || input.mergedSha || input.productionSha || input.runtimeOutcome,
    ),
    verifiedOutcomeOnly: true as const,
  };
}
