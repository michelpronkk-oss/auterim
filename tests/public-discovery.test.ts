import { describe, expect, it } from "vitest";
import { discoverCompanySurfaceDependencies } from "@/lib/discovery/company-surfaces";
import type { UrlDiscoveryResult } from "@/lib/discovery/discovery";
import type { FetchResult } from "@/lib/monitoring/fetcher";
import { publicStackScanResult } from "@/lib/public/stack-scan";
import { publicScanHeadline } from "@/lib/public/stack-scan-copy";

function response(
  url: string,
  body: string,
  safeHeaders: Record<string, string> = {},
): FetchResult {
  return {
    status: 200,
    body: Buffer.from(body),
    bytesRead: Buffer.byteLength(body),
    wireBytesRead: Buffer.byteLength(body),
    bodyTruncated: false,
    contentType: "text/html",
    safeHeaders,
    etag: null,
    lastModified: null,
    finalUrl: url,
  };
}

describe("canonical discovery public projection", () => {
  it("maps canonical confidence to honest possible/likely copy", () => {
    expect(publicScanHeadline("completed", ["medium"])).toBe("We found 1 possible dependency.");
    expect(publicScanHeadline("partial", ["high"])).toBe("We found 1 likely dependency.");
    expect(publicScanHeadline("completed", ["high", "low"])).toBe(
      "We found 1 likely dependency and 1 possible dependency.",
    );
    expect(publicScanHeadline("completed", [])).toBe(
      "No supported dependency suggestions were found.",
    );
    expect(publicScanHeadline("failed", [])).toBe("We couldn't complete this scan.");
  });

  it("projects canonical company suggestions without recalculating provider truth", async () => {
    const result = await discoverCompanySurfaceDependencies("https://example.test", {
      deep: true,
      fetcher: async (url) => {
        if (url === "https://example.test/") {
          return response(
            url,
            '<a href="https://app.example.test">Open app</a><script src="/_next/static/chunks/app.js"></script>',
            { "cf-ray": "internal-cloudflare-evidence" },
          );
        }
        if (url === "https://app.example.test/")
          return response(url, '<script src="https://js.stripe.com/v3/"></script>');
        throw new Error("Unexpected surface request");
      },
    });

    const projected = publicStackScanResult(result);
    expect(projected.candidates.map(({ providerId }) => providerId)).toEqual(
      result.candidates.map(({ providerSlug }) => providerSlug),
    );
    expect(projected.candidates.map(({ providerId }) => providerId)).toEqual(
      expect.arrayContaining(["cloudflare", "stripe"]),
    );
    expect(
      projected.candidates.every(({ confidenceLabel }) =>
        result.candidates.some((candidate) => candidate.confidenceLabel === confidenceLabel),
      ),
    ).toBe(true);
    expect(projected.companyCoverage?.surfacesScanned).toBe(2);
    expect(projected).not.toHaveProperty("technologyObservations");
    expect(projected).not.toHaveProperty("evidence");
    expect(JSON.stringify(projected)).not.toContain("internal-cloudflare-evidence");
    expect(JSON.stringify(projected)).not.toContain("signatureKey");
    expect(JSON.stringify(projected)).not.toContain("surfaceHost");
    expect(JSON.stringify(projected)).not.toContain("workspaceId");
  });

  it("preserves partial canonical results and the canonical confidence label", async () => {
    const result = await discoverCompanySurfaceDependencies("https://example.test", {
      fetcher: async (url) => {
        if (url === "https://example.test/")
          return response(url, '<a href="https://app.example.test">Open app</a>', {
            "cf-ray": "fixture",
          });
        throw new Error("The selected app surface is unavailable");
      },
    });

    const projected = publicStackScanResult(result);
    expect(projected.partial).toBe(true);
    expect(projected.status).toBe("partial");
    expect(projected.candidates.map(({ providerId }) => providerId)).toEqual(
      result.candidates.map(({ providerSlug }) => providerSlug),
    );
    expect(
      projected.candidates.find(({ providerId }) => providerId === "cloudflare")?.confidenceLabel,
    ).toBe(
      result.candidates.find(({ providerSlug }) => providerSlug === "cloudflare")?.confidenceLabel,
    );
  });

  it("does not expose technology observations as dependency suggestions", () => {
    const projected = publicStackScanResult({
      normalizedUrl: "https://example.test/",
      status: "completed",
      outcome: "complete",
      candidates: [],
      evidence: [],
      technologyObservations: [
        {
          technologySlug: "nextjs",
          technologyName: "Next.js",
          category: "framework",
          strength: "strong",
          protectability: "non_protectable",
          fingerprintId: "internal-next-fingerprint",
          registryVersion: "internal-registry-version",
          evidenceFamily: "html_script",
          relationship: "unknown",
          status: "suppressed",
          disposition: "suppressed",
          suppressionReason: "FRAMEWORK",
          evidence: [],
        } as unknown as NonNullable<UrlDiscoveryResult["technologyObservations"]>[number],
      ],
      coverage: {
        outcome: "complete",
        durationMs: 12,
        html: {
          attempted: true,
          status: 200,
          bytesRead: 100,
          truncated: false,
          referencesExtracted: 0,
          extractionPerformed: true,
          nodeLimitReached: false,
          referenceLimitReached: false,
        },
        staticCoverage: {
          quality: "strong",
          durationMs: 12,
          signalFamilies: 0,
          runtimeRequired: false,
          resourceGraph: {
            scriptsFirstParty: 0,
            scriptsThirdParty: 0,
            stylesheets: 0,
            preloads: 0,
            apiEndpoints: 0,
            frames: 0,
            manifests: 0,
            formActions: 0,
            otherResources: 0,
          },
        },
        runtime: {
          attempted: false,
          durationMs: 0,
          requestsObserved: 0,
          requestsFulfilled: 0,
          requestsBlocked: 0,
          uniqueHosts: 0,
          providerMatches: 0,
          blockedUnsafeRequests: 0,
          status: "skipped",
          memoryDeltaBytes: null,
        },
        headers: { inspected: 0 },
        csp: { inspected: false, hostSources: 0 },
        manifest: { attempted: false, discovered: 0, fetched: 0, failures: 0 },
        javascript: {
          attempted: false,
          scriptsDiscovered: 0,
          scriptsAttempted: 0,
          scriptsFetched: 0,
          bytesFetched: 0,
          failures: 0,
          limitReached: false,
        },
        incompleteReasons: [],
      },
      deepPass: {
        requested: false,
        scriptsDiscovered: 0,
        scriptsAttempted: 0,
        scriptsFetched: 0,
        bytesFetched: 0,
        failures: 0,
      },
      inspected: {
        responseHeaders: 0,
        redirects: 0,
        htmlNodes: 0,
        scriptReferences: 0,
        resourceReferences: 0,
        cspHosts: 0,
        inlineConfigUrls: 0,
        manifestsFetched: 0,
        jsAssetsFetched: 0,
        dnsRecordsUsed: false,
        browserRuntime: false,
      },
    });

    expect(projected.candidates).toEqual([]);
    expect(JSON.stringify(projected)).not.toContain("Next.js");
    expect(JSON.stringify(projected)).not.toContain("FRAMEWORK");
  });
});
