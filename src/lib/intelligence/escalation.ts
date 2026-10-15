import { createHash } from "node:crypto";
import { deterministicDiff } from "@/lib/monitoring/content";
import { isCriticalSourceType } from "@/lib/intelligence/evidence";
import type { EvidenceEscalationClaim } from "@/lib/intelligence/router-repository";

const OMITTED = "[bounded middle omitted]";
const MARKERS = [
  "deprecated",
  "deprecation",
  "breaking",
  "removed",
  "security",
  "authentication",
  "authorization",
  "rate limit",
  "quota",
  "pricing",
  "webhook",
] as const;

export function evaluateBoundedEscalationEvidence(
  claim: Extract<EvidenceEscalationClaim, { status: "claimed" }>,
) {
  const diff = deterministicDiff(claim.previousEvidence, claim.currentEvidence);
  const rebuiltDiff = diff.text || claim.diffText;
  const truncated =
    diff.truncated ||
    claim.previousEvidence.includes(OMITTED) ||
    claim.currentEvidence.includes(OMITTED);
  const sourceCriticality = isCriticalSourceType(claim.sourceType) ? "critical" : "standard";
  const lower = rebuiltDiff.toLowerCase();
  const criticalMarkers = MARKERS.filter((marker) => lower.includes(marker)).slice(0, 8);
  const summary = {
    version: "bounded-source-recheck-v1",
    attemptCount: claim.attemptCount,
    sourceCriticality,
    diffTruncated: truncated,
    semanticEvidenceCoverage: truncated ? 0 : 1,
    addedLineCount: diff.addedLines,
    removedLineCount: diff.removedLines,
    criticalMarkers,
    previousBytes: claim.previousBytes,
    currentBytes: claim.currentBytes,
  };
  const fingerprint = createHash("sha256")
    .update(`${claim.sourceChangeId}:${rebuiltDiff}:${JSON.stringify(summary)}`)
    .digest("hex")
    .slice(0, 32);
  return {
    terminalState: truncated ? ("insufficient_evidence" as const) : ("completed" as const),
    reason: truncated ? "bounded_evidence_still_incomplete" : "bounded_evidence_rechecked",
    summary,
    fingerprint,
  };
}
