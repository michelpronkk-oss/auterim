import { describe, expect, it, beforeEach } from "vitest";
import { readPublicAttribution, publicConversionEvents } from "@/lib/public/conversion";
import { publicStackScanResult } from "@/lib/public/stack-scan";
import { consumePublicRateLimit, resetPublicRateLimitsForTests } from "@/lib/public/rate-limit";
import { validatePublishableFields } from "@/lib/growth/contract";
import { summarizeEnabledSources } from "@/lib/public/coverage";
import { POST as publicStackScan } from "@/app/api/public/stack-scan/route";
import { isPublicEvidenceFresh, MAX_PUBLIC_EVIDENCE_AGE_DAYS } from "@/lib/public/freshness";

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
            },
          ],
        },
      ],
      evidence: [],
      deepPass: { requested: false, scriptsFetched: 0, bytesFetched: 0 },
    });
    expect(JSON.stringify(result)).not.toContain("customer.example");
    expect(JSON.stringify(result)).not.toContain("x-vercel-id");
    expect(result.candidates[0]).toEqual({
      provider: "Vercel",
      confidence: 0.72,
      confidenceLabel: "medium",
      evidenceCount: 1,
      signalTypes: ["response_header"],
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
    expect(body).toEqual({ status: "failed", candidateCount: 0, candidates: [] });
  });
});
