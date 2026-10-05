import { expect, it } from "vitest";
import { POST as publicStackScan } from "../src/app/api/public/stack-scan/route.ts";
import { discoverCompanySurfaceDependencies } from "../src/lib/discovery/company-surfaces.ts";
import type { publicStackScanResult } from "../src/lib/public/stack-scan.ts";

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
    expect(publicResponse.status).toBe(200);
    const projected = (await publicResponse.json()) as ReturnType<typeof publicStackScanResult>;
    const canonical = await discoverCompanySurfaceDependencies(target.url, {
      deep: true,
      runtimeEnabled,
    });
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
