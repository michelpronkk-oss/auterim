import type { UrlDiscoveryResult } from "@/lib/discovery/discovery";

export function publicStackScanResult(result: UrlDiscoveryResult) {
  return {
    status: result.status,
    outcome: result.outcome,
    candidateCount: result.candidates.length,
    coverage: {
      durationMs: result.coverage.durationMs,
      htmlBytesRead: result.coverage.html.bytesRead,
      htmlTruncated: result.coverage.html.truncated,
      htmlExtractionPerformed: result.coverage.html.extractionPerformed,
      scriptsDiscovered: result.coverage.javascript.scriptsDiscovered,
      scriptsAttempted: result.coverage.javascript.scriptsAttempted,
      scriptsFetched: result.coverage.javascript.scriptsFetched,
      deepBytesFetched: result.coverage.javascript.bytesFetched,
    },
    candidates: result.candidates.slice(0, 25).map((candidate) => ({
      provider: candidate.providerName,
      confidence: candidate.confidence,
      confidenceLabel: candidate.confidenceLabel,
      evidenceCount: candidate.evidence.length,
      signalTypes: [...new Set(candidate.evidence.map((item) => item.signalType))],
    })),
  };
}
