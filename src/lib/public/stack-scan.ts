import "server-only";
import { discoverCompanySurfaceDependencies } from "@/lib/discovery/company-surfaces";
import { evidenceFamily, type UrlDiscoveryResult } from "@/lib/discovery/discovery";

export async function discoverPublicStackScan(websiteUrl: string) {
  const result = await discoverCompanySurfaceDependencies(websiteUrl, {
    deep: true,
    runtimeEnabled: process.env.AUTERIM_DISCOVERY_RUNTIME_ENABLED === "1",
  });
  return publicStackScanResult(result);
}

export function publicStackScanResult(result: UrlDiscoveryResult) {
  const companyCoverage = result.companyCoverage;
  const candidateSlugs = new Set(result.candidates.map(({ providerSlug }) => providerSlug));
  const additionalTechnologiesBySlug = new Map<string, string>();
  for (const observation of companyCoverage?.technologyObservations ??
    result.technologyObservations ??
    []) {
    if (
      candidateSlugs.has(observation.technologySlug) ||
      (observation.strength !== "strong" && observation.strength !== "medium") ||
      (observation.status !== "strong" && observation.status !== "supported")
    ) {
      continue;
    }
    additionalTechnologiesBySlug.set(observation.technologySlug, observation.technologyName);
  }
  const additionalTechnologyNames = [...additionalTechnologiesBySlug.values()];
  return {
    status: result.status,
    outcome: result.outcome,
    partial: result.status === "partial" || result.outcome === "partial",
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
    companyCoverage: companyCoverage
      ? {
          surfacesObserved: companyCoverage.surfacesObserved,
          surfacesSelected: companyCoverage.surfacesSelected,
          surfacesScanned: companyCoverage.surfacesScanned,
          providersSuggested: companyCoverage.providersSuggested,
          totalDurationMs: companyCoverage.totalDurationMs,
          totalStaticBytes: companyCoverage.totalStaticBytes,
          totalRuntimeDurationMs: companyCoverage.totalRuntimeDurationMs,
          totalRuntimeRequests: companyCoverage.totalRuntimeRequests,
        }
      : null,
    additionalTechnologyCount: additionalTechnologyNames.length,
    additionalTechnologies: additionalTechnologyNames.slice(0, 8),
    candidates: result.candidates.slice(0, 25).map((candidate) => ({
      providerId: candidate.providerSlug,
      provider: candidate.providerName,
      confidence: candidate.confidence,
      confidenceLabel: candidate.confidenceLabel,
      evidenceCount: candidate.evidence.length,
      evidenceFamilies: [
        ...new Set(candidate.evidence.map((item) => evidenceFamily(item.signalType))),
      ],
    })),
  };
}
