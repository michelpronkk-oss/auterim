import { expect, it } from "vitest";
import { POST as publicStackScan } from "../src/app/api/public/stack-scan/route.ts";
import { discoverCompanySurfaceDependencies } from "../src/lib/discovery/company-surfaces.ts";
import { publicStackScanResult } from "../src/lib/public/stack-scan.ts";

const targets = [
  { name: "Cal.com", url: "https://cal.com/" },
  { name: "TrustMRR", url: "https://trustmrr.com/" },
  { name: "Auterim", url: "https://auterim.com/" },
] as const;

it("checks bounded live public projections against canonical Discovery V1", async () => {
  if (process.env.AUTERIM_PUBLIC_DISCOVERY_LIVE !== "1") {
    throw new Error(
      "Set AUTERIM_PUBLIC_DISCOVERY_LIVE=1 to opt in to the bounded public-site scan.",
    );
  }

  const runtimeEnabled = process.env.AUTERIM_DISCOVERY_RUNTIME_ENABLED === "1";
  const results = [];
  for (const [index, target] of targets.entries()) {
    const publicResponse = await publicStackScan(
      new Request("https://auterim.invalid/api/public/stack-scan", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-real-ip": `203.0.113.${40 + index}`,
        },
        body: JSON.stringify({ websiteUrl: target.url }),
      }),
    );
    const publicBody = await publicResponse.json();
    expect(publicResponse.status, JSON.stringify(publicBody)).toBe(200);
    const projected = publicBody as ReturnType<typeof publicStackScanResult>;
    const canonical = await discoverCompanySurfaceDependencies(target.url, {
      deep: true,
      runtimeEnabled,
    });
    const canonicalProjection = publicStackScanResult(canonical);
    const technologyObservations =
      canonical.companyCoverage?.technologyObservations ?? canonical.technologyObservations ?? [];
    const technologySlugsByDisposition = {
      suggested: new Set(
        technologyObservations
          .filter(({ disposition }) => disposition === "suggested")
          .map(({ technologySlug }) => technologySlug),
      ).size,
      suppressed: new Set(
        technologyObservations
          .filter(({ disposition }) => disposition === "suppressed")
          .map(({ technologySlug }) => technologySlug),
      ).size,
    };
    const canonicalProviders = canonical.candidates.map((candidate) => ({
      providerId: candidate.providerSlug,
      confidence: candidate.confidence,
      confidenceLabel: candidate.confidenceLabel,
    }));
    expect(
      projected.candidates.map(({ providerId, confidence, confidenceLabel }) => ({
        providerId,
        confidence,
        confidenceLabel,
      })),
    ).toEqual(canonicalProviders);
    expect(projected.partial).toBe(
      canonical.status === "partial" || canonical.outcome === "partial",
    );
    expect(projected.companyCoverage?.surfacesScanned).toBe(
      canonical.companyCoverage?.surfacesScanned,
    );
    expect(projected.additionalTechnologyCount).toBe(canonicalProjection.additionalTechnologyCount);
    expect(projected.additionalTechnologies).toEqual(canonicalProjection.additionalTechnologies);

    results.push({
      site: target.name,
      status: projected.status,
      partial: projected.partial,
      durationMs: projected.companyCoverage?.totalDurationMs ?? projected.coverage.durationMs,
      surfaces: {
        observed: projected.companyCoverage?.surfacesObserved ?? 1,
        selected: projected.companyCoverage?.surfacesSelected ?? 1,
        scanned: projected.companyCoverage?.surfacesScanned ?? 1,
      },
      technologyObservations: {
        records:
          canonical.companyCoverage?.technologyObservationsTotal ?? technologyObservations.length,
        uniqueTechnologies:
          canonical.companyCoverage?.technologiesObserved ??
          new Set(technologyObservations.map(({ technologySlug }) => technologySlug)).size,
        suggestedTechnologies: technologySlugsByDisposition.suggested,
        suppressedTechnologies: technologySlugsByDisposition.suppressed,
      },
      additionalTechnologyCount: projected.additionalTechnologyCount,
      additionalTechnologies: projected.additionalTechnologies,
      runtime: {
        enabled: runtimeEnabled,
        attempted: canonical.coverage.runtime.attempted,
        status: canonical.coverage.runtime.status,
        durationMs: canonical.coverage.runtime.durationMs,
      },
      suggestions: projected.candidates.map(
        ({ providerId, provider, confidenceLabel, evidenceFamilies }) => ({
          providerId,
          provider,
          confidenceLabel,
          evidenceFamilies,
        }),
      ),
    });
  }

  process.stdout.write(`PUBLIC_DISCOVERY_PARITY ${JSON.stringify({ results })}\n`);
  expect(results.every((result) => result.status !== "failed")).toBe(true);
}, 90_000);
