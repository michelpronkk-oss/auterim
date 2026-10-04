import { expect, it } from "vitest";
import { discoverWebsiteDependencies } from "../src/lib/discovery/discovery.ts";
import { fetchHttpSource } from "../src/lib/monitoring/fetcher.ts";

const targets: Array<{
  name: string;
  url: string;
  expectedProvider: string | null;
  expectedAbsentProvider?: string;
}> = [
  { name: "Cal.com", url: "https://cal.com/", expectedProvider: null },
  { name: "TrustMRR", url: "https://trustmrr.com/", expectedProvider: null },
  { name: "Vercel", url: "https://vercel.com/", expectedProvider: "vercel" },
  {
    name: "Stripe",
    url: "https://stripe.com/",
    expectedProvider: null,
    expectedAbsentProvider: "stripe",
  },
  { name: "Cloudflare", url: "https://www.cloudflare.com/", expectedProvider: "cloudflare" },
] as const;

it("runs a bounded live URL dependency evaluation against selected public sites", async () => {
  if (process.env.AUTERIM_DISCOVERY_LIVE !== "1") {
    throw new Error("Set AUTERIM_DISCOVERY_LIVE=1 to opt in to public-site HTTP requests.");
  }
  const siteFilter = process.env.AUTERIM_DISCOVERY_SITE?.toLowerCase();
  const selectedTargets = siteFilter
    ? targets.filter((target) => target.name.toLowerCase() === siteFilter)
    : targets;
  if (!selectedTargets.length) throw new Error("AUTERIM_DISCOVERY_SITE is not in the bounded set.");
  const results = [];
  let requests = 0;
  for (const target of selectedTargets) {
    const result = await discoverWebsiteDependencies(target.url, {
      deep: target.name === "TrustMRR" || target.name === "Cal.com",
      runtimeEnabled: target.name === "TrustMRR" || target.name === "Cal.com",
      fetcher: async (...args) => {
        requests += 1;
        return fetchHttpSource(...args);
      },
    });
    results.push({
      site: target.name,
      status: result.status,
      failureCategory: result.failureCategory ?? null,
      rootStatus: result.coverage.html.status,
      htmlBytes: result.coverage.html.bytesRead,
      htmlTruncated: result.coverage.html.truncated,
      references: result.coverage.html.referencesExtracted,
      scriptsFetched: result.coverage.javascript.scriptsFetched,
      deepPass: result.deepPass,
      runtime: result.coverage.runtime,
      coverage: result.coverage,
      inspected: result.inspected,
      evidence: result.evidence.map(({ providerSlug, signatureKey, signalType, strength }) => ({
        providerSlug,
        signatureKey,
        signalType,
        strength,
      })),
      candidates: result.candidates.map(
        ({ providerSlug, confidenceLabel, confidence, evidence }) => ({
          providerSlug,
          confidenceLabel,
          confidence,
          evidenceCount: evidence.length,
          signalTypes: [...new Set(evidence.map((item) => item.signalType))],
        }),
      ),
      expectedDetected: target.expectedProvider
        ? result.candidates.some((candidate) => candidate.providerSlug === target.expectedProvider)
        : target.expectedAbsentProvider
          ? !result.candidates.some(
              (candidate) => candidate.providerSlug === target.expectedAbsentProvider,
            )
          : null,
    });
  }
  process.stdout.write(
    `LIVE_DISCOVERY_EVALUATION ${JSON.stringify({ sites: selectedTargets.length, requests, results })}\n`,
  );
  expect(
    results.filter((result) => result.status === "failed").map((result) => result.site),
  ).toEqual([]);
  expect(
    results
      .filter((result) => result.status === "partial")
      .every((result) => result.coverage.incompleteReasons.length > 0),
  ).toBe(true);
  const failedExpectations = results.filter((result) => result.expectedDetected === false);
  expect(failedExpectations.map((result) => result.site)).toEqual([]);
}, 90_000);
