import { expect, it } from "vitest";
import { discoverWebsiteDependencies } from "../src/lib/discovery/discovery.ts";
import { fetchHttpSource } from "../src/lib/monitoring/fetcher.ts";

const targets: Array<{
  name: string;
  url: string;
  expectedProvider: string | null;
  expectedAbsentProvider?: string;
}> = [
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
      deep: target.name === "TrustMRR",
      fetcher: async (...args) => {
        requests += 1;
        return fetchHttpSource(...args);
      },
    });
    results.push({
      site: target.name,
      status: result.status,
      failureCategory: result.failureCategory ?? null,
      deepPass: result.deepPass,
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
    results.filter((result) => result.status !== "completed").map((result) => result.site),
  ).toEqual([]);
  const failedExpectations = results.filter((result) => result.expectedDetected === false);
  expect(failedExpectations.map((result) => result.site)).toEqual([]);
}, 90_000);
