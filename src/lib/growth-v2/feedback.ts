import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  canonicalSearchPage,
  evaluateSearchMetrics,
  evaluateProductEntryFeedback,
  didHitSearchAnalyticsPageCap,
  selectNewestSearchMetricVersionPerDateAndPage,
  GROWTH_FEEDBACK_RULES_VERSION,
  SEARCH_ANALYTICS_MAX_PAGES,
  SEARCH_ANALYTICS_PAGE_SIZE,
  type GrowthFeedbackCandidate,
  type SearchMetric,
} from "./contract";
import {
  SEARCH_CONSOLE_PROPERTY,
  searchAnalyticsPage,
  searchMetricKey,
  type SearchConsoleError,
} from "./search-console";

function isoDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

export async function syncSearchConsole(now = new Date()) {
  const client = createSupabaseServerClient();
  const runKey = `rolling-${isoDay(now)}`;
  const end = new Date(now.getTime() - 3 * 86_400_000);
  const start = new Date(end.getTime() - 59 * 86_400_000);
  const windowStart = isoDay(start);
  const windowEnd = isoDay(end);
  const leaseToken = randomUUID();
  const { data: claims, error: claimError } = await client.rpc("claim_growth_search_console_sync", {
    p_run_key: runKey,
    p_window_start: windowStart,
    p_window_end: windowEnd,
    p_lease_token: leaseToken,
  });
  const claim = Array.isArray(claims) ? claims[0] : null;
  if (claimError || !claim) throw new Error("growth_search_sync_run_unavailable");
  const runId = claim.run_id as string;
  if (!claim.acquired) return { runId, status: claim.status, rowsUpserted: 0 };
  let pagesRequested = 0;
  let rowsReceived = 0;
  let rowsUpserted = 0;
  let partial = false;
  try {
    for (let page = 0; page < SEARCH_ANALYTICS_MAX_PAGES; page += 1) {
      const rows = await searchAnalyticsPage({
        startDate: windowStart,
        endDate: windowEnd,
        startRow: page * 1000,
      });
      pagesRequested += 1;
      rowsReceived += rows.length;
      if (!rows.length) break;
      const payload = rows.flatMap((row) => {
        try {
          const safe = searchMetricKey(row);
          return [
            {
              metric_key: safe.metricKey,
              property: SEARCH_CONSOLE_PROPERTY,
              metric_date: row.metricDate,
              query_fingerprint: safe.queryFingerprint,
              query_fingerprint_key_version: safe.queryFingerprintKeyVersion,
              query_topic_match: safe.queryTopicMatch,
              page_url: `https://auterim.com${safe.pageUrl}`,
              clicks: row.clicks,
              impressions: row.impressions,
              ctr: row.ctr,
              average_position: row.averagePosition,
              ingestion_version: 2,
              observed_at: now.toISOString(),
              updated_at: now.toISOString(),
            },
          ];
        } catch {
          return [];
        }
      });
      if (didHitSearchAnalyticsPageCap(page, rows.length)) partial = true;
      if (!payload.length) continue;
      const { error } = await client
        .from("growth_search_console_metrics")
        .upsert(payload, { onConflict: "metric_key" });
      if (error) throw new Error("growth_search_metrics_upsert_failed");
      rowsUpserted += payload.length;
      if (rows.length < SEARCH_ANALYTICS_PAGE_SIZE) break;
    }
    const status = partial ? "partial" : "complete";
    const { data: finished, error } = await client.rpc("finish_growth_search_console_sync", {
      p_run_id: runId,
      p_lease_token: leaseToken,
      p_status: status,
      p_pages_requested: pagesRequested,
      p_rows_received: rowsReceived,
      p_rows_upserted: rowsUpserted,
      p_error_category: partial ? "row_limit_reached" : null,
      p_completed_at: now.toISOString(),
    });
    if (error || finished !== true) throw new Error("growth_search_sync_complete_failed");
    let retentionCleanupStatus: "complete" | "failed" = "complete";
    try {
      await pruneGrowthFeedbackData(client, now);
    } catch {
      retentionCleanupStatus = "failed";
    }
    return {
      runId,
      status,
      pagesRequested,
      rowsReceived,
      rowsUpserted,
      connectionHealthUpdated: true,
      retentionCleanupStatus,
    };
  } catch (error) {
    const category = (error as SearchConsoleError)?.category ?? "provider_unavailable";
    await client.rpc("finish_growth_search_console_sync", {
      p_run_id: runId,
      p_lease_token: leaseToken,
      p_status: "failed",
      p_pages_requested: pagesRequested,
      p_rows_received: rowsReceived,
      p_rows_upserted: rowsUpserted,
      p_error_category: category,
      p_completed_at: now.toISOString(),
    });
    throw error;
  }
}

async function pruneGrowthFeedbackData(
  client: ReturnType<typeof createSupabaseServerClient>,
  now: Date,
) {
  const metricsBefore = isoDay(new Date(now.getTime() - 180 * 86_400_000));
  const eventsBefore = new Date(now.getTime() - 365 * 86_400_000).toISOString();
  const statesBefore = new Date(now.getTime() - 86_400_000).toISOString();
  const runsBefore = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  const bucketsBefore = new Date(now.getTime() - 15 * 60_000).toISOString();
  const results = await Promise.all([
    client.from("growth_search_console_metrics").delete().lt("metric_date", metricsBefore),
    client.from("growth_first_party_events").delete().lt("occurred_at", eventsBefore),
    client.from("growth_search_console_oauth_states").delete().lt("expires_at", statesBefore),
    client
      .from("growth_search_console_sync_runs")
      .delete()
      .lt("started_at", runsBefore)
      .or(`status.neq.running,lease_until.lt.${now.toISOString()}`),
    client.from("growth_public_event_ingest_buckets").delete().lt("bucket_start", bucketsBefore),
  ]);
  if (results.some((result) => result.error))
    throw new Error("growth_feedback_retention_cleanup_failed");
}

function keyFor(candidate: GrowthFeedbackCandidate) {
  const material = JSON.stringify({
    version: GROWTH_FEEDBACK_RULES_VERSION,
    type: candidate.type,
    path: candidate.canonicalPath,
    topic: candidate.topicKey,
  });
  return createHash("sha256").update(material).digest("hex");
}

export async function evaluateGrowthFeedback(now = new Date()) {
  const client = createSupabaseServerClient();
  await pruneGrowthFeedbackData(client, now);
  const through = new Date(now.getTime() - 3 * 86_400_000).toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 180 * 86_400_000).toISOString().slice(0, 10);
  const rawMetrics: {
    metric_key: string;
    metric_date: string;
    query_fingerprint: string;
    query_fingerprint_key_version: number;
    query_topic_match: boolean;
    page_url: string;
    clicks: number;
    impressions: number;
    ctr: number;
    average_position: number;
  }[] = [];
  let partialMetrics = false;
  for (let offset = 0; offset < 10_000; offset += 1000) {
    const { data, error } = await client
      .from("growth_search_console_metrics")
      .select(
        "metric_key,metric_date,query_fingerprint,query_fingerprint_key_version,query_topic_match,page_url,clicks,impressions,ctr,average_position",
      )
      .gte("metric_date", from)
      .lte("metric_date", through)
      .order("metric_date", { ascending: false })
      .order("metric_key", { ascending: false })
      .range(offset, offset + 999);
    if (error) throw new Error("growth_search_metrics_read_failed");
    const rows = data ?? [];
    rawMetrics.push(...rows);
    if (rows.length < 1000) break;
    if (offset === 9000) partialMetrics = true;
  }
  const versionedMetrics = selectNewestSearchMetricVersionPerDateAndPage(
    rawMetrics.map((row) => ({
      source: row,
      metricDate: row.metric_date,
      pageUrl: row.page_url,
      queryFingerprintKeyVersion: row.query_fingerprint_key_version,
    })),
  );
  const metrics: SearchMetric[] = versionedMetrics.map(({ source: row }) => ({
    metricDate: row.metric_date,
    query: `${row.query_fingerprint}:${row.query_fingerprint_key_version}`,
    queryTopicMatch: row.query_topic_match,
    pageUrl: row.page_url,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: Number(row.ctr),
    averagePosition: Number(row.average_position),
  }));
  const candidates = evaluateSearchMetrics(metrics, now);
  const byPath = new Map<string, SearchMetric[]>();
  for (const metric of metrics) {
    const page = canonicalSearchPage(metric.pageUrl);
    if (page) (byPath.get(page.path) ?? byPath.set(page.path, []).get(page.path)!).push(metric);
  }
  const cut = new Date(now.getTime() - 60 * 86_400_000).toISOString().slice(0, 10);
  for (const [path, rows] of byPath) {
    const latestActivity = rows.reduce(
      (latest, row) => (row.metricDate > latest ? row.metricDate : latest),
      "0000-00-00",
    );
    const older = rows.filter((row) => row.metricDate < cut);
    const olderImpressions = older.reduce((sum, row) => sum + row.impressions, 0);
    if (!partialMetrics && latestActivity < cut && olderImpressions >= 100) {
      const page = canonicalSearchPage(rows[0]!.pageUrl)!;
      candidates.push({
        type: "stale_high_value_page",
        canonicalPath: path,
        topicKey: page.topicKey,
        evidence: { olderImpressions, staleDays: 60, rulesVersion: GROWTH_FEEDBACK_RULES_VERSION },
      });
    }
  }
  const eventRows: {
    event_id: string;
    event_type: string;
    event_source: string;
    landing_path: string | null;
    attribution_confidence: string;
    occurred_at: string;
  }[] = [];
  let partialServerEventCoverage = false;
  for (let offset = 0; offset < 10_000; offset += 1000) {
    const { data, error } = await client
      .from("growth_first_party_events")
      .select("event_id,event_type,event_source,landing_path,attribution_confidence,occurred_at")
      .in("event_type", [
        "signup_completed",
        "protection_activation",
        "github_connected",
        "trial_started",
        "paid_conversion",
      ])
      .eq("event_source", "server")
      .gte("occurred_at", new Date(now.getTime() - 31 * 86_400_000).toISOString())
      .lte("occurred_at", `${through}T23:59:59.999Z`)
      .order("occurred_at", { ascending: false })
      .order("event_id", { ascending: false })
      .range(offset, offset + 999);
    if (error) throw new Error("growth_first_party_events_read_failed");
    const rows = data ?? [];
    eventRows.push(...rows);
    if (rows.length < 1000) break;
    if (offset === 9000) partialServerEventCoverage = true;
  }
  const browserRows: { event_type: string; landing_path: string | null }[] = [];
  let partialProductEntryCoverage = false;
  for (let offset = 0; offset < 10_000; offset += 1000) {
    const { data, error } = await client
      .from("growth_first_party_events")
      .select("event_id,event_type,landing_path")
      .in("event_type", ["stack_scan_started", "scan_result_continue"])
      .eq("event_source", "browser")
      .gte("occurred_at", new Date(now.getTime() - 31 * 86_400_000).toISOString())
      .lte("occurred_at", `${through}T23:59:59.999Z`)
      .order("occurred_at", { ascending: false })
      .order("event_id", { ascending: false })
      .range(offset, offset + 999);
    if (error) throw new Error("growth_first_party_events_read_failed");
    const rows = data ?? [];
    browserRows.push(...rows);
    if (rows.length < 1000) break;
    if (offset === 9000) partialProductEntryCoverage = true;
  }
  const eventsByPath = new Map<string, number>();
  for (const event of eventRows ?? []) {
    const page = event.landing_path
      ? canonicalSearchPage(`https://auterim.com${event.landing_path}`)
      : null;
    if (page && event.attribution_confidence === "unknown")
      eventsByPath.set(page.path, (eventsByPath.get(page.path) ?? 0) + 1);
  }
  for (const [path, count] of partialServerEventCoverage ? [] : eventsByPath) {
    const page = canonicalSearchPage(`https://auterim.com${path}`)!;
    candidates.push({
      type: "conversion_attribution_gap",
      canonicalPath: path,
      topicKey: page.topicKey,
      evidence: {
        confirmedConversions: count,
        attributionConfidence: "unknown",
        rulesVersion: GROWTH_FEEDBACK_RULES_VERSION,
      },
    });
  }
  const clicksByPath = new Map<string, number>();
  const entriesByPath = new Map<string, number>();
  const productWindowStart = isoDay(new Date(now.getTime() - 31 * 86_400_000));
  for (const metric of metrics) {
    if (metric.metricDate < productWindowStart) continue;
    const page = canonicalSearchPage(metric.pageUrl);
    if (page) clicksByPath.set(page.path, (clicksByPath.get(page.path) ?? 0) + metric.clicks);
  }
  for (const event of browserRows ?? []) {
    const page = event.landing_path
      ? canonicalSearchPage(`https://auterim.com${event.landing_path}`)
      : null;
    if (page) entriesByPath.set(page.path, (entriesByPath.get(page.path) ?? 0) + 1);
  }
  if (!partialProductEntryCoverage)
    candidates.push(...evaluateProductEntryFeedback({ clicksByPath, entriesByPath }));
  const { data: lastSync, error: lastSyncError } = await client
    .from("growth_search_console_sync_runs")
    .select("status")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const incompleteCoverage =
    partialMetrics ||
    partialServerEventCoverage ||
    lastSyncError !== null ||
    !lastSync ||
    !["complete", "partial"].includes(lastSync.status) ||
    lastSync.status === "partial";
  const safeCandidates = candidates.filter(
    (candidate) =>
      candidate.evidence.rulesVersion === GROWTH_FEEDBACK_RULES_VERSION &&
      !(
        incompleteCoverage &&
        [
          "declining_cluster",
          "emerging_cluster",
          "stale_high_value_page",
          "strong_cluster",
          "strong_page_weak_conversion",
          "lower_traffic_high_entry_rate",
        ].includes(candidate.type)
      ),
  );
  const payload = safeCandidates.map((candidate) => ({
    opportunity_key: keyFor(candidate),
    opportunity_type: candidate.type,
    canonical_path: candidate.canonicalPath,
    topic_key: candidate.topicKey,
    status: "needs_review",
    evidence: candidate.evidence,
    rules_version: GROWTH_FEEDBACK_RULES_VERSION,
    updated_at: now.toISOString(),
  }));
  for (let offset = 0; offset < payload.length; offset += 100) {
    for (const item of payload.slice(offset, offset + 100)) {
      const { error: upsertError } = await client.rpc("record_growth_feedback_candidate", {
        p_payload: item,
      });
      if (upsertError) throw new Error("growth_feedback_candidate_persist_failed");
    }
  }
  return {
    rowsRead: metrics.length,
    candidates: payload.length,
    partialCoverage: incompleteCoverage,
    partialServerEventCoverage,
    partialProductEntryCoverage,
    rulesVersion: GROWTH_FEEDBACK_RULES_VERSION,
  };
}

export async function recordGrowthFirstPartyEvent(input: {
  eventType:
    | "signup_completed"
    | "protection_activation"
    | "product_selected"
    | "dependency_confirmed"
    | "protection_graph_viewed"
    | "first_grounded_value"
    | "github_connected"
    | "trial_started"
    | "paid_conversion";
  stableKey: string;
  attribution?: {
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    landingPath?: string;
  };
  occurredAt?: string;
}) {
  const client = createSupabaseServerClient();
  const key = growthFirstPartyEventKey(input.eventType, input.stableKey);
  const attribution = input.attribution ?? {};
  const safeText = (value: string | undefined) =>
    value && /^[\p{L}\p{N}._ -]{1,100}$/u.test(value) ? value : null;
  const landingPath =
    input.attribution?.landingPath &&
    /^\/[a-zA-Z0-9/_-]{1,160}$/.test(input.attribution.landingPath)
      ? input.attribution.landingPath
      : null;
  const { error } = await client.from("growth_first_party_events").upsert(
    {
      event_key: key,
      event_type: input.eventType,
      event_source: "server",
      occurred_at: input.occurredAt ?? new Date().toISOString(),
      utm_source: safeText(attribution.utmSource),
      utm_medium: safeText(attribution.utmMedium),
      utm_campaign: safeText(attribution.utmCampaign),
      landing_path: landingPath,
      attribution_confidence: "unknown",
    },
    { onConflict: "event_key", ignoreDuplicates: true },
  );
  if (error) throw new Error("growth_first_party_event_write_failed");
}

export function growthFirstPartyEventKey(eventType: string, stableKey: string) {
  return createHash("sha256").update(`growth-event:v1:${eventType}:${stableKey}`).digest("hex");
}

export async function getGrowthFeedbackReadModel(options: { limit?: number } = {}) {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);
  const client = createSupabaseServerClient();
  const [{ data: connection }, { data: opportunities, error }] = await Promise.all([
    client
      .from("growth_search_console_connection")
      .select(
        "property,lifecycle_state,health_state,scopes,connected_at,last_checked_at,last_sync_at,last_sync_status,last_error_category",
      )
      .eq("id", "auterim")
      .maybeSingle(),
    client
      .from("growth_feedback_opportunities")
      .select(
        "id,opportunity_type,canonical_path,topic_key,status,evidence,rules_version,created_at,updated_at",
      )
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);
  if (error) throw new Error("growth_feedback_read_failed");
  return {
    connection: connection ?? {
      property: SEARCH_CONSOLE_PROPERTY,
      lifecycle_state: "disconnected",
      health_state: "unknown",
      scopes: [],
      last_sync_status: "never",
    },
    opportunities: opportunities ?? [],
    rulesVersion: GROWTH_FEEDBACK_RULES_VERSION,
  };
}
