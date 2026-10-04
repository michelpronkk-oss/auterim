import { describe, expect, it } from "vitest";
import {
  canonicalSearchPage,
  didHitSearchAnalyticsPageCap,
  evaluateSearchMetrics,
  evaluateProductEntryFeedback,
  GROWTH_FEEDBACK_RULES_VERSION,
  GROWTH_FEEDBACK_THRESHOLDS,
  growthFeedbackOpportunityTypes,
  hasOnlySearchConsoleReadScope,
  hasSearchConsolePropertyAccess,
  selectNewestSearchMetricVersionPerDateAndPage,
  isAllowedVerifiedGrowthAdmin,
} from "@/lib/growth-v2/contract";

const now = new Date("2026-10-03T12:00:00.000Z");
const currentDay = "2026-09-20";
const article = "https://auterim.com/changes/openai/openai-api-20261001";

describe("Growth Engine V2 Search Console feedback rules", () => {
  it("marks the five-page sync partial even when page-five rows are rejected later", () => {
    expect(didHitSearchAnalyticsPageCap(4, 1000)).toBe(true);
    expect(didHitSearchAnalyticsPageCap(4, 999)).toBe(false);
    expect(didHitSearchAnalyticsPageCap(3, 1000)).toBe(false);
  });

  it("selects the newest fingerprint-key namespace for overlapping page dates", () => {
    const versionOne = {
      metricDate: currentDay,
      pageUrl: article,
      queryFingerprintKeyVersion: 1,
      queryFingerprint: "a".repeat(64),
      impressions: 100,
    };
    const versionTwo = {
      ...versionOne,
      queryFingerprintKeyVersion: 2,
      queryFingerprint: "b".repeat(64),
      impressions: 110,
    };
    const olderDate = { ...versionOne, metricDate: "2026-08-01" };

    expect(
      selectNewestSearchMetricVersionPerDateAndPage([versionOne, versionTwo, olderDate]),
    ).toEqual([versionTwo, olderDate]);
  });

  it("accepts only the exact least-privilege Search Console scope", () => {
    expect(
      hasOnlySearchConsoleReadScope(["https://www.googleapis.com/auth/webmasters.readonly"]),
    ).toBe(true);
    expect(hasOnlySearchConsoleReadScope([])).toBe(false);
    expect(
      hasOnlySearchConsoleReadScope([
        "https://www.googleapis.com/auth/webmasters.readonly",
        "https://www.googleapis.com/auth/webmasters",
      ]),
    ).toBe(false);
  });

  it("requires a verified allowlisted admin identity", () => {
    const allowlist = new Set(["admin@auterim.com"]);
    expect(
      isAllowedVerifiedGrowthAdmin(" ADMIN@Auterim.com ", "2026-01-01T00:00:00Z", allowlist),
    ).toBe(true);
    expect(isAllowedVerifiedGrowthAdmin("admin@auterim.com", null, allowlist)).toBe(false);
    expect(
      isAllowedVerifiedGrowthAdmin("other@auterim.com", "2026-01-01T00:00:00Z", allowlist),
    ).toBe(false);
  });

  it.each([
    ["root", "https://auterim.com/", "/", null],
    ["tools", "https://auterim.com/tools", "/tools", null],
    ["tool detail", "https://auterim.com/tools/stack-scanner", "/tools/stack-scanner", null],
    ["pricing", "https://auterim.com/pricing", "/pricing", null],
    ["provider hub", "https://auterim.com/changes/openai", "/changes/openai", "openai"],
    ["canonical change", article, "/changes/openai/openai-api-20261001", "openai-api-20261001"],
    [
      "remove trailing slash",
      "https://auterim.com/tools/stack-scanner/",
      "/tools/stack-scanner",
      null,
    ],
    [
      "discard query string",
      "https://auterim.com/changes/openai/openai-api-20261001?utm_source=x",
      "/changes/openai/openai-api-20261001",
      "openai-api-20261001",
    ],
    ["normalize host case", "https://AUTERIM.com/pricing", "/pricing", null],
    [
      "collapse repeated slash",
      "https://auterim.com//tools//stack-scanner",
      "/tools/stack-scanner",
      null,
    ],
  ])("maps canonical Auterim surface: %s", (_name, url, path, topicKey) => {
    expect(canonicalSearchPage(url)).toEqual({ path, topicKey });
  });

  it.each([
    ["foreign host", "https://example.com/tools"],
    ["www alias", "https://www.auterim.com/tools"],
    ["http scheme", "http://auterim.com/tools"],
    ["private IP", "https://127.0.0.1/tools"],
    ["userinfo", "https://auterim.com@evil.example/tools"],
    ["numeric slug", "https://auterim.com/changes/openai/123456"],
    ["underscore slug", "https://auterim.com/changes/open_ai/openai-update"],
    ["unknown surface", "https://auterim.com/private"],
    ["invalid URL", "not a URL"],
    ["empty URL", ""],
  ])("rejects noncanonical target: %s", (_name, url) => {
    expect(canonicalSearchPage(url)).toBeNull();
  });

  it("accepts read access only to the configured Search Console domain property", () => {
    expect(
      hasSearchConsolePropertyAccess({
        siteUrl: "sc-domain:auterim.com",
        permissionLevel: "siteRestrictedUser",
      }),
    ).toBe(true);
    expect(
      hasSearchConsolePropertyAccess({
        siteUrl: "sc-domain:other.example",
        permissionLevel: "siteOwner",
      }),
    ).toBe(false);
    expect(
      hasSearchConsolePropertyAccess({
        siteUrl: "sc-domain:auterim.com",
        permissionLevel: "siteUnverifiedUser",
      }),
    ).toBe(false);
  });

  it.each([
    [100, 0],
    [101, 1],
    [250, 2],
    [999, 5],
    [1_000, 10],
    [1_500, 15],
    [2_000, 20],
    [4_000, 40],
    [10_000, 100],
    [15_000, 150],
  ])("flags high impressions and low CTR with %s impressions", (impressions, clicks) => {
    const result = evaluateSearchMetrics(
      [
        {
          metricDate: currentDay,
          query: "provider migration",
          pageUrl: article,
          impressions,
          clicks,
          ctr: clicks / impressions,
          averagePosition: 18,
        },
      ],
      now,
    );
    expect(result.some((item) => item.type === "high_impressions_low_ctr")).toBe(
      clicks / impressions < GROWTH_FEEDBACK_THRESHOLDS.lowCtr,
    );
  });

  it.each([
    [7.99, false],
    [8, true],
    [9, true],
    [10, true],
    [11, true],
    [12, true],
    [13, true],
    [14, true],
    [15, true],
    [16, true],
    [17, true],
    [18, true],
    [19, true],
    [20, true],
    [20.01, false],
  ])("applies near-page-one position boundary %s", (position, expected) => {
    const result = evaluateSearchMetrics(
      [
        {
          metricDate: currentDay,
          query: "provider release",
          pageUrl: article,
          impressions: 500,
          clicks: 25,
          ctr: 0.05,
          averagePosition: position,
        },
      ],
      now,
    );
    expect(result.some((item) => item.type === "near_page_one")).toBe(expected);
  });

  it("excludes the lag-aware incomplete days", () => {
    const incompleteDay = "2026-10-02";
    const result = evaluateSearchMetrics(
      [
        {
          metricDate: incompleteDay,
          query: "late data",
          pageUrl: article,
          impressions: 900,
          clicks: 0,
          ctr: 0,
          averagePosition: 12,
        },
      ],
      now,
    );
    expect(result).toHaveLength(0);
  });

  it("returns an honest no-data state", () => {
    expect(evaluateSearchMetrics([], now)).toEqual([]);
  });

  it("builds versioned candidate evidence without raw query text or persisted query fingerprints", () => {
    const result = evaluateSearchMetrics(
      [
        {
          metricDate: currentDay,
          query: "person@example.com",
          pageUrl: article,
          impressions: 900,
          clicks: 0,
          ctr: 0,
          averagePosition: 11,
        },
      ],
      now,
    );
    expect(result[0]?.evidence).toMatchObject({ rulesVersion: GROWTH_FEEDBACK_RULES_VERSION });
    expect(JSON.stringify(result)).not.toContain("person@example.com");
    expect(result[0]?.evidence).not.toHaveProperty("queryFingerprint");
    expect(result[0]?.evidence).not.toHaveProperty("queryTopicMatch");
  });

  it("deduplicates repeated query/page/date observations before scoring", () => {
    const row = {
      metricDate: currentDay,
      query: "provider api",
      pageUrl: article,
      impressions: 100,
      clicks: 1,
      ctr: 0.01,
      averagePosition: 10,
    };
    const result = evaluateSearchMetrics([row, row], now);
    expect(result.filter((item) => item.type === "high_impressions_low_ctr")).toHaveLength(1);
  });

  it("recognizes a topic whitespace candidate on an unmodeled surface", () => {
    const result = evaluateSearchMetrics(
      [
        {
          metricDate: currentDay,
          query: "new provider risk",
          pageUrl: "https://auterim.com/tools/stack-scanner",
          impressions: 150,
          clicks: 4,
          ctr: 4 / 150,
          averagePosition: 13,
        },
      ],
      now,
    );
    expect(result.some((item) => item.type === "topic_whitespace")).toBe(true);
  });

  it("suggests only the deterministic provider hub link for a qualified public change page", () => {
    const result = evaluateSearchMetrics(
      [
        {
          metricDate: currentDay,
          query: "openai api migration",
          pageUrl: article,
          impressions: 250,
          clicks: 20,
          ctr: 0.08,
          averagePosition: 9,
        },
      ],
      now,
    );
    expect(
      result.find((item) => item.type === "internal_link_opportunity")?.evidence,
    ).toMatchObject({
      suggestedTargetPath: "/changes/openai",
      rulesVersion: GROWTH_FEEDBACK_RULES_VERSION,
    });
  });

  it("compares aggregate search clicks with product-entry events without claiming attribution", () => {
    const weak = evaluateProductEntryFeedback({
      clicksByPath: new Map([["/changes/openai/openai-api-20261001", 200]]),
      entriesByPath: new Map(),
    });
    expect(weak).toMatchObject([
      {
        type: "strong_page_weak_conversion",
        evidence: {
          searchClicks: 200,
          productEntryActions: 0,
          measurement: "aggregate_landing_path_not_causal",
        },
      },
    ]);
    const efficient = evaluateProductEntryFeedback({
      clicksByPath: new Map([["/tools/stack-scanner", 20]]),
      entriesByPath: new Map([["/tools/stack-scanner", 2]]),
    });
    expect(efficient).toMatchObject([
      {
        type: "lower_traffic_high_entry_rate",
        evidence: { searchClicks: 20, productEntryActions: 2 },
      },
    ]);
  });

  it("keeps the complete versioned opportunity taxonomy available", () => {
    expect(growthFeedbackOpportunityTypes).toHaveLength(14);
    expect(new Set(growthFeedbackOpportunityTypes).size).toBe(14);
  });
});
