import type { UrlDiscoveryResult } from "@/lib/discovery/discovery";

export function publicStackScanResult(result: UrlDiscoveryResult) {
  return {
    status: result.status,
    candidateCount: result.candidates.length,
    candidates: result.candidates.slice(0, 25).map((candidate) => ({
      provider: candidate.providerName,
      confidence: candidate.confidence,
      confidenceLabel: candidate.confidenceLabel,
      evidenceCount: candidate.evidence.length,
      signalTypes: [...new Set(candidate.evidence.map((item) => item.signalType))],
    })),
  };
}
