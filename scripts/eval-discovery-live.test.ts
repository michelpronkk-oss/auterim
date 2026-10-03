import { expect, it } from "vitest";
import { discoverWebsiteDependencies } from "../src/lib/discovery/discovery.ts";
import { fetchHttpSource } from "../src/lib/monitoring/fetcher.ts";

const targets = [
  { name: "Vercel", url: "https://vercel.com/", expectedProvider: "vercel" },
  {
    name: "Stripe",
    url: "https://stripe.com/",
    expectedProvider: null,
    expectedAbsentProvider: "stripe",
  },
  { name: "Cloudflare", url: "https://www.cloudflare.com/", expectedProvider: "cloudflare" },
] as const;

it("runs a bounded live URL dependency evaluation against three public sites", async () => {
  if (process.env.AUTERIM_DISCOVERY_LIVE !== "1") {
    throw new Error("Set AUTERIM_DISCOVERY_LIVE=1 to opt in to three public-site HTTP requests.");
  }
  const results = [];
  let requests = 0;
  for (const target of targets) {
    const result = await discoverWebsiteDependencies(target.url, {
      deep: false,
      fetcher: async (...args) => {
        requests += 1;
        return fetchHttpSource(...args);
      },
    });
    results.push({
      site: target.name,
      status: result.status,
      candidates: result.candidates.map(({ providerSlug, confidenceLabel }) => ({
        providerSlug,
        confidenceLabel,
      })),
      expectedDetected:
        target.expectedProvider === null
          ? !result.candidates.some(
              (candidate) => candidate.providerSlug === target.expectedAbsentProvider,
            )
          : result.candidates.some(
              (candidate) => candidate.providerSlug === target.expectedProvider,
            ),
    });
    expect(result.status, `${target.name} safe fetch`).toBe("completed");
  }
  console.log(
    `LIVE_DISCOVERY_EVALUATION ${JSON.stringify({ sites: targets.length, requests, results })}`,
  );
  expect(results.filter((result) => !result.expectedDetected).map((result) => result.site)).toEqual(
    [],
  );
}, 90_000);
