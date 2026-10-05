import { describe, expect, it, beforeEach } from "vitest";
import { readPublicAttribution, publicConversionEvents } from "@/lib/public/conversion";
import { publicStackScanResult } from "@/lib/public/stack-scan";
import { consumePublicRateLimit, resetPublicRateLimitsForTests } from "@/lib/public/rate-limit";
import { validatePublishableFields } from "@/lib/growth/contract";
import { summarizeEnabledSources } from "@/lib/public/coverage";
import { POST as publicStackScan } from "@/app/api/public/stack-scan/route";
import { isPublicEvidenceFresh, MAX_PUBLIC_EVIDENCE_AGE_DAYS } from "@/lib/public/freshness";
import { scopePublicToolItems, scopePublicToolProviders } from "@/lib/public/tool-filter";

describe("public acquisition surfaces", () => {
  beforeEach(() => resetPublicRateLimitsForTests());

  it("defines the first-party funnel event contract", () => {
    expect(publicConversionEvents).toEqual(
      expect.arrayContaining([
        "homepage_view",
        "stack_scan_started",
        "stack_scan_completed",
        "scan_result_continue",
        "signup_started",
        "signup_completed",
        "protection_activation",
        "github_connect_started",
        "github_connected",
        "trial_started",
      ]),
    );
  });

  it("suppresses source intelligence after the public freshness window", () => {
    const now = Date.parse("2026-10-03T12:00:00.000Z");
    expect(isPublicEvidenceFresh(new Date(now - 10 * 86_400_000).toISOString(), now)).toBe(true);
    expect(
      isPublicEvidenceFresh(
        new Date(now - (MAX_PUBLIC_EVIDENCE_AGE_DAYS + 1) * 86_400_000).toISOString(),
        now,
      ),
    ).toBe(false);
    expect(isPublicEvidenceFresh(new Date(now + 86_400_000).toISOString(), now)).toBe(false);
  });

  it("keeps only bounded safe attribution values", () => {
    const attribution = readPublicAttribution(
      new URLSearchParams("utm_source=partner&utm_medium=docs&utm_campaign=autumn%2F..%2Fprivate"),
      "/tools/stack-scanner?secret=1",
    );
    expect(attribution).toEqual({ utmSource: "partner", utmMedium: "docs", landingPath: "/" });
  });

  it("limits repeated public scans in a bounded window", () => {
    expect(
      consumePublicRateLimit("hashed-client", { now: 10, limit: 2, windowMs: 1000 }).allowed,
    ).toBe(true);
    expect(
      consumePublicRateLimit("hashed-client", { now: 11, limit: 2, windowMs: 1000 }).allowed,
    ).toBe(true);
    expect(
      consumePublicRateLimit("hashed-client", { now: 12, limit: 2, windowMs: 1000 }),
    ).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    expect(
      consumePublicRateLimit("hashed-client", { now: 1010, limit: 2, windowMs: 1000 }).allowed,
    ).toBe(true);
  });

  it("projects discovery results without returning company origin or raw evidence", () => {
    const result = publicStackScanResult({
      normalizedUrl: "https://customer.example/",
      status: "completed",
      candidates: [
        {
          providerSlug: "vercel",
          providerName: "Vercel",
          confidence: 0.72,
          confidenceLabel: "medium",
          evidence: [
            {
              providerSlug: "vercel",
              providerName: "Vercel",
              signatureKey: "x-vercel-id",
              signalType: "response_header",
              strength: "strong",
              sourceOrigin: "https://customer.example",
              surfaceType: "ROOT_MARKETING",
              surfaceHost: "customer.example",
            },
          ],
        },
      ],
      evidence: [],
      outcome: "complete",
      coverage: {
        outcome: "complete",
        durationMs: 1,
        html: {
          attempted: true,
          status: 200,
          bytesRead: 0,
          truncated: false,
          referencesExtracted: 0,
          extractionPerformed: true,
          nodeLimitReached: false,
          referenceLimitReached: false,
        },
        staticCoverage: {
          quality: "weak",
          durationMs: 1,
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
          uniqueHosts: 0,
          providerMatches: 0,
          blockedUnsafeRequests: 0,
          status: "skipped",
          memoryDeltaBytes: null,
        },
        headers: { inspected: 0 },
        csp: { inspected: true, hostSources: 0 },
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
        dnsRecordsUsed: false as const,
        browserRuntime: false as const,
      },
    });
    expect(JSON.stringify(result)).not.toContain("customer.example");
    expect(JSON.stringify(result)).not.toContain("x-vercel-id");
    expect(result.candidates[0]).toEqual({
      providerId: "vercel",
      provider: "Vercel",
      confidence: 0.72,
      confidenceLabel: "medium",
      evidenceCount: 1,
      evidenceFamilies: ["hosting_infrastructure"],
    });
  });

  it("rejects private-looking claims from public content", () => {
    expect(validatePublishableFields({ workspace_id: "123456" }).safe).toBe(false);
    expect(validatePublishableFields({ summary: "The API will retire on 2027-05-01." }).safe).toBe(
      true,
    );
  });

  it("derives source coverage from enabled catalog rows and marks bounded results partial", () => {
    const exact = summarizeEnabledSources(
      [
        { dependency_id: "stripe", source_type: "changelog" },
        { dependency_id: "stripe", source_type: "api_docs" },
        { dependency_id: "stripe", source_type: "api_docs" },
        { dependency_id: "openai", source_type: "deprecations" },
      ],
      4,
    );
    expect(exact.partial).toBe(false);
    expect(exact.byDependency.get("stripe")).toEqual({
      total: 3,
      byType: { changelog: 1, api_docs: 2 },
    });
    expect(
      summarizeEnabledSources([{ dependency_id: "stripe", source_type: "changelog" }], 501).partial,
    ).toBe(true);
  });

  it("keeps an unknown provider filter from falling back to all public providers", () => {
    const directory = [{ slug: "openai" }, { slug: "stripe" }];
    expect(scopePublicToolProviders(directory)).toEqual({
      selected: null,
      providers: directory,
    });
    expect(scopePublicToolProviders(directory, "stripe")).toEqual({
      selected: directory[1],
      providers: [directory[1]],
    });
    expect(scopePublicToolProviders(directory, "unknown-provider")).toEqual({
      selected: null,
      providers: [],
    });

    const changes = [
      { provider: { slug: "openai" }, id: "openai-change" },
      { provider: { slug: "stripe" }, id: "stripe-change" },
    ];
    expect(scopePublicToolItems(changes, directory).map(({ id }) => id)).toEqual([
      "openai-change",
      "stripe-change",
    ]);
    expect(scopePublicToolItems(changes, directory, "stripe").map(({ id }) => id)).toEqual([
      "stripe-change",
    ]);
    expect(scopePublicToolItems(changes, directory, "unknown-provider")).toEqual([]);
  });

  it("rejects malformed public scan requests without echoing submitted data", async () => {
    const response = await publicStackScan(
      new Request("http://localhost/api/public/stack-scan", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.19" },
        body: "{",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request_body" });
  });

  it("streams and rejects an oversized public scan body without buffering it whole", async () => {
    const response = await publicStackScan(
      new Request("http://localhost/api/public/stack-scan", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.21" },
        body: " ".repeat(4097),
      }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request_too_large" });
  });

  it("does not fetch private network targets from the public scanner", async () => {
    const response = await publicStackScan(
      new Request("http://localhost/api/public/stack-scan", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.20" },
        body: JSON.stringify({ websiteUrl: "http://127.0.0.1" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: "failed",
      outcome: "failed",
      candidateCount: 0,
      candidates: [],
    });
  });
});
