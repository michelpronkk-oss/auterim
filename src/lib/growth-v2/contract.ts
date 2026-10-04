export const GROWTH_FEEDBACK_RULES_VERSION = "growth-feedback-v2-rules-1";
export const SEARCH_ANALYTICS_MAX_PAGES = 5;
export const SEARCH_ANALYTICS_PAGE_SIZE = 1000;

export function didHitSearchAnalyticsPageCap(pageIndex: number, rowsOnPage: number) {
  return pageIndex >= SEARCH_ANALYTICS_MAX_PAGES - 1 && rowsOnPage >= SEARCH_ANALYTICS_PAGE_SIZE;
}

export function hasOnlySearchConsoleReadScope(scopes: string[]) {
  return scopes.length === 1 && scopes[0] === "https://www.googleapis.com/auth/webmasters.readonly";
}

export function isAllowedVerifiedGrowthAdmin(
  email: string | null | undefined,
  emailConfirmedAt: string | null | undefined,
  allowlistedEmails: ReadonlySet<string>,
) {
  const normalizedEmail = email?.trim().toLowerCase();
  return Boolean(normalizedEmail && emailConfirmedAt && allowlistedEmails.has(normalizedEmail));
}

export function hasSearchConsolePropertyAccess(value: Record<string, unknown>) {
  return (
    value.siteUrl === "sc-domain:auterim.com" &&
    ["siteOwner", "siteFullUser", "siteRestrictedUser"].includes(String(value.permissionLevel))
  );
}

export const GROWTH_FEEDBACK_THRESHOLDS = Object.freeze({
  recentDaysExcluded: 3,
  comparisonDays: 28,
  minImpressions: 100,
  conversionMinClicks: 100,
  lowerTrafficMinClicks: 10,
  lowerTrafficMaxClicks: 99,
  weakEntryRate: 0.01,
  strongEntryRate: 0.05,
  lowCtr: 0.02,
  nearPageOneMinPosition: 8,
  nearPageOneMaxPosition: 20,
  declineRatio: 0.5,
  strongGrowthRatio: 1.5,
  stalePageDays: 60,
});

export const growthFeedbackOpportunityTypes = [
  "high_impressions_low_ctr",
  "near_page_one",
  "query_gap",
  "internal_link_opportunity",
  "emerging_cluster",
  "declining_cluster",
  "stale_high_value_page",
  "strong_cluster",
  "weak_conversion",
  "strong_page_weak_conversion",
  "lower_traffic_high_entry_rate",
  "topic_whitespace",
  "distribution_candidate",
  "conversion_attribution_gap",
] as const;

export type GrowthFeedbackOpportunityType = (typeof growthFeedbackOpportunityTypes)[number];

export type SearchMetric = {
  metricDate: string;
  query: string;
  pageUrl: string;
  clicks: number;
  impressions: number;
  ctr: number;
  averagePosition: number;
  queryTopicMatch?: boolean;
};

export function selectNewestSearchMetricVersionPerDateAndPage<
  T extends {
    metricDate: string;
    pageUrl: string;
    queryFingerprintKeyVersion: number;
  },
>(metrics: T[]): T[] {
  const newestVersion = new Map<string, number>();
  const pageKey = (metric: T) => {
    const page = canonicalSearchPage(metric.pageUrl);
    return page ? `${metric.metricDate}\n${page.path}` : null;
  };
  for (const metric of metrics) {
    const key = pageKey(metric);
    if (
      !key ||
      !Number.isInteger(metric.queryFingerprintKeyVersion) ||
      metric.queryFingerprintKeyVersion < 1
    )
      continue;
    newestVersion.set(
      key,
      Math.max(newestVersion.get(key) ?? 0, metric.queryFingerprintKeyVersion),
    );
  }
  return metrics.filter((metric) => {
    const key = pageKey(metric);
    return (
      key !== null &&
      Number.isInteger(metric.queryFingerprintKeyVersion) &&
      metric.queryFingerprintKeyVersion > 0 &&
      newestVersion.get(key) === metric.queryFingerprintKeyVersion
    );
  });
}

export type GrowthFeedbackCandidate = {
  type: GrowthFeedbackOpportunityType;
  canonicalPath: string | null;
  topicKey: string | null;
  evidence: Record<string, number | string | boolean | null>;
};

export function canonicalSearchPage(
  value: string,
): { path: string; topicKey: string | null } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "auterim.com") return null;
    const path = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    const change = /^\/changes\/([a-z0-9-]+)\/([a-z0-9-]+)$/i.exec(path);
    if (change && /^[0-9]{5,}$/.test(change[2])) return null;
    if (change) return { path: `/changes/${change[1]}/${change[2]}`, topicKey: change[2] };
    const hub = /^\/changes\/([a-z0-9-]+)$/i.exec(path);
    if (hub) return { path: `/changes/${hub[1]}`, topicKey: hub[1] };
    if (/^\/(?:tools|pricing|)$/i.test(path) || /^\/tools\/[a-z0-9-]+$/i.test(path))
      return { path, topicKey: null };
    return null;
  } catch {
    return null;
  }
}

export function evaluateSearchMetrics(
  metrics: SearchMetric[],
  now = new Date(),
): GrowthFeedbackCandidate[] {
  const threshold = GROWTH_FEEDBACK_THRESHOLDS;
  const recentEnd = new Date(now.getTime() - threshold.recentDaysExcluded * 86_400_000);
  const currentStart = new Date(recentEnd.getTime() - threshold.comparisonDays * 86_400_000);
  const previousStart = new Date(currentStart.getTime() - threshold.comparisonDays * 86_400_000);
  const grouped = new Map<string, { current: SearchMetric[]; previous: SearchMetric[] }>();
  const seen = new Set<string>();
  for (const metric of metrics) {
    const page = canonicalSearchPage(metric.pageUrl);
    if (!page || !metric.query.trim() || metric.impressions < 0 || metric.clicks < 0) continue;
    const query = metric.query.trim().toLowerCase();
    const identity = `${metric.metricDate}\n${page.path}\n${query}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const key = `${page.path}\n${query}`;
    const entry = grouped.get(key) ?? { current: [], previous: [] };
    const date = new Date(`${metric.metricDate}T00:00:00Z`);
    if (date >= currentStart && date < recentEnd) entry.current.push(metric);
    else if (date >= previousStart && date < currentStart) entry.previous.push(metric);
    grouped.set(key, entry);
  }

  const candidates = new Map<string, GrowthFeedbackCandidate>();
  const pageTotals = new Map<
    string,
    {
      topicKey: string | null;
      currentImpressions: number;
      previousImpressions: number;
      currentClicks: number;
      queryCount: number;
      positionWeighted: number;
    }
  >();
  const push = (
    type: GrowthFeedbackOpportunityType,
    path: string,
    topicKey: string | null,
    evidence: GrowthFeedbackCandidate["evidence"],
  ) => {
    const key = `${type}|${path}|${topicKey ?? ""}`;
    const existing = candidates.get(key);
    if (!existing) {
      candidates.set(key, { type, canonicalPath: path, topicKey, evidence: { ...evidence } });
      return;
    }
    for (const field of ["currentImpressions", "currentClicks", "previousImpressions"] as const) {
      const value = evidence[field];
      if (typeof value === "number")
        existing.evidence[field] =
          (typeof existing.evidence[field] === "number"
            ? (existing.evidence[field] as number)
            : 0) + value;
    }
    existing.evidence.matchingQueries =
      (typeof existing.evidence.matchingQueries === "number"
        ? existing.evidence.matchingQueries
        : 1) + 1;
  };

  for (const [key, values] of grouped) {
    const path = key.split("\n")[0]!;
    const currentImpressions = values.current.reduce((sum, row) => sum + row.impressions, 0);
    const currentClicks = values.current.reduce((sum, row) => sum + row.clicks, 0);
    const ctr = currentImpressions ? currentClicks / currentImpressions : 0;
    const position = values.current.length
      ? values.current.reduce((sum, row) => sum + row.averagePosition * row.impressions, 0) /
        Math.max(currentImpressions, 1)
      : 0;
    const previousImpressions = values.previous.reduce((sum, row) => sum + row.impressions, 0);
    const topicKey =
      canonicalSearchPage(values.current[0]?.pageUrl ?? values.previous[0]?.pageUrl ?? "")
        ?.topicKey ?? null;
    const evidence = {
      currentImpressions,
      currentClicks,
      currentCtr: Number(ctr.toFixed(4)),
      averagePosition: Number(position.toFixed(2)),
      previousImpressions,
      rulesVersion: GROWTH_FEEDBACK_RULES_VERSION,
    };
    const totals = pageTotals.get(path) ?? {
      topicKey,
      currentImpressions: 0,
      previousImpressions: 0,
      currentClicks: 0,
      queryCount: 0,
      positionWeighted: 0,
    };
    totals.currentImpressions += currentImpressions;
    totals.previousImpressions += previousImpressions;
    totals.currentClicks += currentClicks;
    totals.queryCount += currentImpressions > 0 || previousImpressions > 0 ? 1 : 0;
    totals.positionWeighted += position * currentImpressions;
    pageTotals.set(path, totals);

    if (currentImpressions >= threshold.minImpressions && ctr < threshold.lowCtr)
      push("high_impressions_low_ctr", path, topicKey, {
        ...evidence,
        suggestedReview: "title_snippet_intent_alignment",
      });
    if (
      currentImpressions >= threshold.minImpressions &&
      position >= threshold.nearPageOneMinPosition &&
      position <= threshold.nearPageOneMaxPosition
    )
      push("near_page_one", path, topicKey, evidence);
    if (
      topicKey &&
      currentImpressions >= threshold.minImpressions &&
      values.current.some((row) => row.queryTopicMatch === false)
    )
      push("query_gap", path, topicKey, evidence);
    if (
      !topicKey &&
      path.startsWith("/tools/") &&
      currentImpressions >= threshold.minImpressions &&
      position <= threshold.nearPageOneMaxPosition
    )
      push("topic_whitespace", path, null, evidence);
    const article = /^\/changes\/([a-z0-9-]+)\/([a-z0-9-]+)$/i.exec(path);
    if (article && currentImpressions >= threshold.minImpressions)
      push("internal_link_opportunity", path, article[2] ?? null, {
        currentImpressions,
        suggestedTargetPath: `/changes/${article[1]}`,
        rulesVersion: GROWTH_FEEDBACK_RULES_VERSION,
      });
  }

  for (const [path, totals] of pageTotals) {
    if (totals.queryCount < 3 || totals.currentImpressions < threshold.minImpressions) continue;
    const averagePosition = totals.positionWeighted / Math.max(1, totals.currentImpressions);
    const evidence = {
      currentImpressions: totals.currentImpressions,
      currentClicks: totals.currentClicks,
      previousImpressions: totals.previousImpressions,
      matchingQueries: totals.queryCount,
      averagePosition: Number(averagePosition.toFixed(2)),
      rulesVersion: GROWTH_FEEDBACK_RULES_VERSION,
    };
    if (
      totals.previousImpressions >= threshold.minImpressions &&
      totals.currentImpressions <= totals.previousImpressions * threshold.declineRatio
    )
      push("declining_cluster", path, totals.topicKey, evidence);
    if (
      totals.previousImpressions >= threshold.minImpressions &&
      totals.currentImpressions >= totals.previousImpressions * threshold.strongGrowthRatio
    )
      push("emerging_cluster", path, totals.topicKey, evidence);
    const ctr = totals.currentClicks / totals.currentImpressions;
    if (ctr >= 0.08 && averagePosition <= 10) {
      push("strong_cluster", path, totals.topicKey, evidence);
      push("distribution_candidate", path, totals.topicKey, evidence);
    }
  }

  return [...candidates.values()];
}

export function evaluateProductEntryFeedback(input: {
  clicksByPath: Map<string, number>;
  entriesByPath: Map<string, number>;
}): GrowthFeedbackCandidate[] {
  const candidates: GrowthFeedbackCandidate[] = [];
  const threshold = GROWTH_FEEDBACK_THRESHOLDS;
  for (const [path, clicks] of input.clicksByPath) {
    if (clicks < threshold.lowerTrafficMinClicks) continue;
    const entries = input.entriesByPath.get(path) ?? 0;
    const entryRate = entries / clicks;
    const page = canonicalSearchPage(`https://auterim.com${path}`);
    if (!page) continue;
    const evidence = {
      searchClicks: clicks,
      productEntryActions: entries,
      productEntryActionRate: Number(entryRate.toFixed(4)),
      measurement: "aggregate_landing_path_not_causal",
      rulesVersion: GROWTH_FEEDBACK_RULES_VERSION,
    };
    if (clicks >= threshold.conversionMinClicks && entryRate < threshold.weakEntryRate)
      candidates.push({
        type: "strong_page_weak_conversion",
        canonicalPath: path,
        topicKey: page.topicKey,
        evidence,
      });
    if (
      clicks >= threshold.lowerTrafficMinClicks &&
      clicks <= threshold.lowerTrafficMaxClicks &&
      entryRate >= threshold.strongEntryRate
    )
      candidates.push({
        type: "lower_traffic_high_entry_rate",
        canonicalPath: path,
        topicKey: page.topicKey,
        evidence,
      });
  }
  return candidates;
}
