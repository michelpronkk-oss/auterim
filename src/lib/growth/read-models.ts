import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const MAX_PAGE = 100;
type Cursor = { at: string; id: string };

function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    if (!/^\d{4}-\d\d-\d\dT/.test(parsed.at) || !/^[0-9a-f-]{36}$/i.test(parsed.id)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function encodeCursor(at: string, id: string) {
  return Buffer.from(JSON.stringify({ at, id })).toString("base64url");
}

function pageSize(limit: number | undefined) {
  return Math.min(Math.max(Math.trunc(limit ?? 25), 1), MAX_PAGE);
}

function throwIf(error: unknown, code: string): asserts error is null {
  if (error) throw new Error(code);
}

function oneRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

const opportunitySelect =
  "id,decision,status,recommended_surface,free_tool_type,cta_types,indexable,publication_ready,headline,public_summary,general_impact,affected_public_entities,reasons,blockers,factors,confidence,freshness,announced_at,effective_at,last_verified_at,current_evidence_fingerprint,current_source_change_id,current_evaluation_id,last_evaluated_at,created_at,updated_at,topic:growth_topics!inner(id,provider_id,topic_key,entity_key,label,canonical_slug,provider:dependency_catalog!inner(slug,name,category,website_url))";

export async function getGrowthOpportunities(
  options: {
    client?: SupabaseClient;
    decision?: string;
    providerSlug?: string;
    category?: string;
    freshness?: string;
    status?: string;
    surfaceType?: string;
    needsReview?: boolean;
    cursor?: string | null;
    limit?: number;
  } = {},
) {
  const client = options.client ?? createSupabaseServerClient();
  const cursor = decodeCursor(options.cursor);
  if (options.cursor && !cursor) throw new Error("invalid_growth_cursor");
  const size = pageSize(options.limit);
  let query = client
    .from("growth_opportunities")
    .select(opportunitySelect)
    .order("last_evaluated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(size * 4 + 1);
  if (options.decision) query = query.eq("decision", options.decision);
  if (options.status) query = query.eq("status", options.status);
  if (options.freshness) query = query.eq("freshness", options.freshness);
  if (options.surfaceType) query = query.eq("recommended_surface", options.surfaceType);
  if (options.category) query = query.eq("topic.topic_key", options.category);
  if (options.providerSlug) query = query.eq("topic.provider.slug", options.providerSlug);
  if (cursor)
    query = query.or(
      `last_evaluated_at.lt.${cursor.at},and(last_evaluated_at.eq.${cursor.at},id.lt.${cursor.id})`,
    );
  const { data, error } = await query;
  throwIf(error, "growth_opportunities_unavailable");
  const rows = data ?? [];
  const filtered = options.needsReview
    ? rows.filter((row) => (row.blockers as string[]).length > 0)
    : rows;
  const items = filtered.slice(0, size);
  const hasMoreRaw = rows.length > size * 4;
  const last = items.at(-1);
  const rawBoundary = rows[Math.min(rows.length, size * 4) - 1];
  return {
    items,
    nextCursor:
      items.length === size && last
        ? encodeCursor(last.last_evaluated_at, last.id)
        : hasMoreRaw && rawBoundary
          ? encodeCursor(rawBoundary.last_evaluated_at, rawBoundary.id)
          : null,
  };
}

export async function getGrowthOpportunity(id: string, client = createSupabaseServerClient()) {
  const { data: opportunity, error } = await client
    .from("growth_opportunities")
    .select(opportunitySelect)
    .eq("id", id)
    .maybeSingle();
  throwIf(error, "growth_opportunity_unavailable");
  if (!opportunity) return null;
  const [evidence, evaluations, candidates] = await Promise.all([
    client
      .from("growth_opportunity_evidence")
      .select(
        "id,source_change_id,classification_id,source_id,evidence_type,excerpt,observed_at,source:source_catalog!inner(name,source_type,url)",
      )
      .eq("opportunity_id", id)
      .order("observed_at", { ascending: false })
      .limit(40),
    client
      .from("growth_opportunity_evaluations")
      .select(
        "id,source_change_id,classification_id,evaluator_version,packet_schema_version,policy_version,evidence_fingerprint,decision,reasons,blockers,factors,confidence,supersedes_evaluation_id,evaluated_at",
      )
      .eq("opportunity_id", id)
      .order("evaluated_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(25),
    client
      .from("growth_distribution_candidates")
      .select(
        "id,candidate_type,status,suggested_angle,safe_claim_boundaries,freshness,evidence_fingerprint,created_at,updated_at",
      )
      .eq("opportunity_id", id)
      .order("created_at", { ascending: false })
      .limit(6),
  ]);
  throwIf(
    evidence.error || evaluations.error || candidates.error,
    "growth_opportunity_detail_unavailable",
  );
  const distributionCandidates = (candidates.data ?? []).map((candidate) => ({
    ...candidate,
    currentEvidence: candidate.evidence_fingerprint === opportunity.current_evidence_fingerprint,
    eligible:
      candidate.evidence_fingerprint === opportunity.current_evidence_fingerprint &&
      opportunity.publication_ready &&
      ["PUBLIC_PAGE", "HUB_UPDATE", "DISTRIBUTION_ONLY"].includes(opportunity.decision) &&
      ["candidate", "needs_review"].includes(candidate.status),
  }));
  return {
    ...opportunity,
    evidence: evidence.data ?? [],
    evaluations: evaluations.data ?? [],
    distributionCandidates,
  };
}

export async function getGrowthTopics(
  options: {
    client?: SupabaseClient;
    providerSlug?: string;
    cursor?: string | null;
    limit?: number;
  } = {},
) {
  const client = options.client ?? createSupabaseServerClient();
  const cursor = decodeCursor(options.cursor);
  if (options.cursor && !cursor) throw new Error("invalid_growth_cursor");
  const size = pageSize(options.limit);
  let query = client
    .from("growth_topics")
    .select(
      "id,provider_id,topic_key,entity_key,label,canonical_slug,created_at,updated_at,provider:dependency_catalog!inner(slug,name,category)",
    )
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(size + 1);
  if (options.providerSlug) query = query.eq("provider.slug", options.providerSlug);
  if (cursor)
    query = query.or(
      `created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`,
    );
  const { data, error } = await query;
  throwIf(error, "growth_topics_unavailable");
  const rows = data ?? [];
  const items = rows.slice(0, size);
  return {
    items,
    nextCursor:
      rows.length > size && items.length
        ? encodeCursor(items.at(-1)!.created_at, items.at(-1)!.id)
        : null,
  };
}

export async function getDistributionCandidates(
  options: {
    client?: SupabaseClient;
    status?: string;
    providerSlug?: string;
    cursor?: string | null;
    limit?: number;
  } = {},
) {
  const client = options.client ?? createSupabaseServerClient();
  const cursor = decodeCursor(options.cursor);
  if (options.cursor && !cursor) throw new Error("invalid_growth_cursor");
  const size = pageSize(options.limit);
  let query = client
    .from("growth_distribution_candidates")
    .select(
      "id,opportunity_id,candidate_type,status,suggested_angle,safe_claim_boundaries,freshness,evidence_fingerprint,created_at,opportunity:growth_opportunities!inner(decision,publication_ready,current_evidence_fingerprint,topic:growth_topics!inner(canonical_slug,topic_key,provider:dependency_catalog!inner(slug,name)))",
    )
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(size * 2 + 1);
  if (options.status) query = query.eq("status", options.status);
  if (options.providerSlug)
    query = query.eq("opportunity.topic.provider.slug", options.providerSlug);
  if (cursor)
    query = query.or(
      `created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`,
    );
  const { data, error } = await query;
  throwIf(error, "growth_distribution_unavailable");
  const rows = data ?? [];
  const items = rows.slice(0, size).map((candidate) => {
    const opportunity = Array.isArray(candidate.opportunity)
      ? candidate.opportunity[0]
      : candidate.opportunity;
    return {
      ...candidate,
      currentEvidence: candidate.evidence_fingerprint === opportunity?.current_evidence_fingerprint,
      eligible:
        candidate.evidence_fingerprint === opportunity?.current_evidence_fingerprint &&
        opportunity?.publication_ready &&
        ["candidate", "needs_review"].includes(candidate.status),
    };
  });
  return {
    items,
    nextCursor:
      rows.length > size && items.length
        ? encodeCursor(items.at(-1)!.created_at, items.at(-1)!.id)
        : null,
  };
}

export async function getProviderGrowthSummary(
  providerSlug: string,
  client = createSupabaseServerClient(),
) {
  const { data: provider, error: providerError } = await client
    .from("dependency_catalog")
    .select("id,slug,name,category,website_url")
    .eq("slug", providerSlug)
    .eq("enabled", true)
    .maybeSingle();
  throwIf(providerError, "growth_provider_unavailable");
  if (!provider) return null;
  const base = () =>
    client
      .from("growth_opportunities")
      .select("id,topic:growth_topics!inner(provider_id)", { count: "exact", head: true })
      .eq("topic.provider_id", provider.id);
  const [all, pages, hubs, distributions, topics] = await Promise.all([
    base(),
    base().eq("publication_ready", true),
    base().eq("decision", "PUBLIC_PAGE").eq("indexable", true),
    base().eq("decision", "DISTRIBUTION_ONLY"),
    client
      .from("growth_topics")
      .select("id", { count: "exact", head: true })
      .eq("provider_id", provider.id),
  ]);
  throwIf(
    all.error || pages.error || hubs.error || distributions.error || topics.error,
    "growth_provider_summary_unavailable",
  );
  const recent = await client
    .from("growth_opportunities")
    .select(opportunitySelect)
    .eq("topic.provider_id", provider.id)
    .in("decision", ["PUBLIC_PAGE", "HUB_UPDATE", "DISTRIBUTION_ONLY"])
    .order("effective_at", { ascending: true, nullsFirst: false })
    .limit(20);
  throwIf(recent.error, "growth_provider_summary_unavailable");
  return {
    provider,
    totals: {
      opportunities: all.count ?? 0,
      ready: pages.count ?? 0,
      indexableChangePages: hubs.count ?? 0,
      distributionCandidates: distributions.count ?? 0,
      canonicalTopics: topics.count ?? 0,
    },
    upcomingAndRecent: recent.data ?? [],
    lastVerifiedAt:
      recent.data?.reduce<string | null>(
        (latest, row) => (!latest || row.last_verified_at > latest ? row.last_verified_at : latest),
        null,
      ) ?? null,
  };
}

export async function getProviderHubContract(
  providerSlug: string,
  client = createSupabaseServerClient(),
) {
  const summary = await getProviderGrowthSummary(providerSlug, client);
  if (!summary) return null;
  const categories = summary.upcomingAndRecent
    .map((row) => oneRelation(row.topic)?.topic_key)
    .filter((category): category is string => Boolean(category));
  return {
    provider: summary.provider,
    currentMaterialChanges: summary.upcomingAndRecent,
    lastVerifiedAt: summary.lastVerifiedAt,
    categories: [...new Set(categories)],
  };
}

export async function getChangePageContract(
  canonicalSlug: string,
  client = createSupabaseServerClient(),
) {
  const { data: topic, error } = await client
    .from("growth_topics")
    .select(
      "id,canonical_slug,label,provider:dependency_catalog!inner(slug,name,category,website_url)",
    )
    .eq("canonical_slug", canonicalSlug)
    .eq("provider.enabled", true)
    .maybeSingle();
  throwIf(error, "growth_change_page_unavailable");
  if (!topic) return null;
  const provider = oneRelation(topic.provider);
  if (!provider) return null;
  const { data: opportunity, error: opportunityError } = await client
    .from("growth_opportunities")
    .select(opportunitySelect)
    .eq("topic_id", topic.id)
    .eq("decision", "PUBLIC_PAGE")
    .eq("status", "approved_by_engine")
    .eq("publication_ready", true)
    .eq("indexable", true)
    .in("freshness", ["current", "upcoming", "recent"])
    .maybeSingle();
  throwIf(opportunityError, "growth_change_page_unavailable");
  if (!opportunity) return null;
  const detail = await getGrowthOpportunity(opportunity.id, client);
  if (!detail) return null;
  return {
    provider,
    headline: detail.headline,
    canonicalSlug: topic.canonical_slug,
    whatChanged: detail.public_summary,
    announcedAt: detail.announced_at,
    effectiveAt: detail.effective_at,
    affectedPublicEntities: detail.affected_public_entities,
    generalImpact: detail.general_impact,
    authoritativeEvidence: detail.evidence,
    lastVerifiedAt: detail.last_verified_at,
    relatedProviderSlug: provider.slug,
    ctaTypes: detail.cta_types,
  };
}
