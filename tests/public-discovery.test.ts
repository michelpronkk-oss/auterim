import { describe, expect, it } from "vitest";
import { discoverCompanySurfaceDependencies } from "@/lib/discovery/company-surfaces";
import type { UrlDiscoveryResult } from "@/lib/discovery/discovery";
import type { FetchResult } from "@/lib/monitoring/fetcher";
import { publicStackScanResult } from "@/lib/public/stack-scan";
import {
  publicAdditionalTechnologyCopy,
  publicDiscoveryScopeCopy,
  publicScanHeadline,
} from "@/lib/public/stack-scan-copy";
import type { TechnologyObservation } from "@/lib/discovery/technology-registry";

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

function technologyObservation(
  technologySlug: string,
  technologyName: string,
  overrides: Partial<TechnologyObservation> = {},
): TechnologyObservation {
  return {
    technologySlug,
    technologyName,
    category: "framework",
    fingerprintId: `internal-${technologySlug}-fingerprint`,
    registryVersion: "internal-registry-version",
    evidenceFamily: "html_marker",
    strength: "strong",
    relationship: "unknown",
    protectability: "non_protectable",
    status: "supported",
    disposition: "suppressed",
    suppressionReason: "FRAMEWORK",
    surfaceType: "ROOT_MARKETING",
    surfaceHost: "private-observed-host.example",
    sourceHost: "private-source-host.example",
    ...overrides,
  };
}

describe("canonical discovery public projection", () => {
  it("describes zero, one, and many dependency candidates without overclaiming", () => {
    expect(publicScanHeadline("completed", 0)).toBe(
      "No dependency candidates were surfaced for review.",
    );
    expect(publicScanHeadline("partial", 1)).toBe("Auterim surfaced 1 dependency for review.");
    expect(publicScanHeadline("completed", 2)).toBe("Auterim surfaced 2 dependencies for review.");
    expect(publicScanHeadline("failed", 0)).toBe("We couldn't complete this scan.");
  });

  it("summarizes zero, one, many, and bounded additional technology names", () => {
    expect(publicAdditionalTechnologyCopy(0, [])).toBe("");
    expect(publicAdditionalTechnologyCopy(1, ["Next.js"])).toBe(
      "1 additional technology observed: Next.js.",
    );
    expect(publicAdditionalTechnologyCopy(3, ["Next.js", "React", "Tailwind"])).toBe(
      "3 additional technologies observed: Next.js · React · Tailwind.",
    );
    expect(publicAdditionalTechnologyCopy(10, ["A", "B", "C", "D", "E", "F", "G", "H"])).toBe(
      "10 additional technologies observed: A · B · C · D · E · F · G · H · +2 more.",
    );
  });

  it("states partial and complete discovery scope without claiming exhaustiveness", () => {
    expect(publicDiscoveryScopeCopy(true)).toBe(
      "Initial discovery is selective by design. This scan may not surface every dependency.",
    );
    expect(publicDiscoveryScopeCopy(false)).toBe(
      "Initial discovery prioritizes evidence-backed matches for review.",
    );
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
    for (const candidate of projected.candidates) {
      const canonical = result.candidates.find(
        ({ providerSlug }) => providerSlug === candidate.providerId,
      );
      expect(canonical).toBeDefined();
      expect(candidate.confidence).toBe(canonical?.confidence);
      expect(candidate.confidenceLabel).toBe(canonical?.confidenceLabel);
    }
    expect(projected.companyCoverage?.surfacesScanned).toBe(2);
    expect(projected).toMatchObject({
      additionalTechnologyCount: 1,
      additionalTechnologies: ["Next.js"],
    });
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

  it("projects only distinct supported non-candidate technology names", async () => {
    const result = await discoverCompanySurfaceDependencies("https://example.test", {
      fetcher: async (url) =>
        url === "https://example.test/" ? response(url, "<html></html>") : response(url, ""),
    });
    const companyObservations = [
      technologyObservation("cloudflare", "Cloudflare"),
      technologyObservation("nextjs", "Next.js"),
      technologyObservation("nextjs", "Next.js", { surfaceHost: "app.example.test" }),
      technologyObservation("react", "React"),
      technologyObservation("weak-tool", "Weak Tool", { strength: "weak", status: "weak" }),
      technologyObservation("derived-tool", "Derived Tool", { strength: "derived" }),
      technologyObservation("conflicted-tool", "Conflicted Tool", { status: "conflicted" }),
      technologyObservation("unknown-tool", "Unknown Tool", { status: "unknown" }),
    ];
    const projected = publicStackScanResult({
      ...result,
      candidates: [
        {
          providerSlug: "cloudflare",
          providerName: "Cloudflare",
          confidence: 0.8,
          confidenceLabel: "high",
          evidence: [],
        },
      ],
      technologyObservations: [technologyObservation("root-only", "Root-only")],
      companyCoverage: {
        ...result.companyCoverage!,
        technologyObservations: companyObservations,
      },
    });

    expect(projected.additionalTechnologyCount).toBe(2);
    expect(projected.additionalTechnologies).toEqual(["Next.js", "React"]);
    expect(projected.candidates.map(({ providerId }) => providerId)).toEqual(["cloudflare"]);
    const serialized = JSON.stringify(projected);
    for (const internalValue of [
      "internal-nextjs-fingerprint",
      "internal-registry-version",
      "html_marker",
      "FRAMEWORK",
      "private-observed-host.example",
      "private-source-host.example",
      "Weak Tool",
      "Derived Tool",
      "Conflicted Tool",
      "Unknown Tool",
      "Root-only",
      "workspaceId",
    ]) {
      expect(serialized).not.toContain(internalValue);
    }
  });

  it("falls back to root observations when company observations are unavailable", async () => {
    const result = await discoverCompanySurfaceDependencies("https://example.test", {
      fetcher: async (url) => response(url, "<html></html>"),
    });
    const projected = publicStackScanResult({
      ...result,
      technologyObservations: [technologyObservation("react", "React")],
      companyCoverage: {
        ...result.companyCoverage!,
        technologyObservations: undefined,
      },
    });

    expect(projected.additionalTechnologyCount).toBe(1);
    expect(projected.additionalTechnologies).toEqual(["React"]);
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
