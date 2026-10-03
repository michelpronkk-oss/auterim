import "server-only";
import { unstable_cache } from "next/cache";
import { validatePublishableFields } from "@/lib/growth/contract";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { summarizeEnabledSources } from "@/lib/public/coverage";
import { isPublicEvidenceFresh } from "@/lib/public/freshness";

const PAGE_SELECT =
  "id,decision,status,publication_ready,indexable,headline,public_summary,general_impact,affected_public_entities,freshness,announced_at,effective_at,last_verified_at,last_evaluated_at,topic:growth_topics!inner(canonical_slug,label,provider:dependency_catalog!inner(slug,name,category,website_url))";

type PublicOpportunity = {
  id: string;
  decision: string;
  status: string;
  publication_ready: boolean;
  indexable: boolean;
  headline: string;
  public_summary: string;
  general_impact: string;
  affected_public_entities: string[];
  freshness: string;
  announced_at: string | null;
  effective_at: string | null;
  last_verified_at: string;
  last_evaluated_at: string;
  topic:
    | {
        canonical_slug: string;
        label: string;
        provider: { slug: string; name: string; category: string; website_url: string } | null;
      }
    | Array<{
        canonical_slug: string;
        label: string;
        provider: { slug: string; name: string; category: string; website_url: string } | null;
      }>
    | null;
};

function first<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function throwIfError(error: unknown): asserts error is null {
  if (error) throw new Error("public_intelligence_unavailable");
}

async function safePublicRead<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

function projectOpportunity(row: PublicOpportunity) {
  const topic = first(row.topic);
  const provider = first(topic?.provider);
  if (!topic || !provider) return null;
  if (!isPublicEvidenceFresh(row.last_verified_at)) return null;
  const output = {
    id: row.id,
    provider: { slug: provider.slug, name: provider.name, category: provider.category },
    canonicalSlug: topic.canonical_slug,
    label: topic.label,
    headline: row.headline,
    summary: row.public_summary,
    generalImpact: row.general_impact,
    affectedPublicEntities: row.affected_public_entities ?? [],
    freshness: row.freshness,
    announcedAt: row.announced_at,
    effectiveAt: row.effective_at,
    lastVerifiedAt: row.last_verified_at,
    lastEvaluatedAt: row.last_evaluated_at,
  };
  const validated = validatePublishableFields(output);
  return validated.safe ? output : null;
}

async function queryApprovedChanges() {
  const client = createSupabaseServerClient();
  const { data, error } = await client
    .from("growth_opportunities")
    .select(PAGE_SELECT)
    .eq("decision", "PUBLIC_PAGE")
    .eq("status", "approved_by_engine")
    .eq("publication_ready", true)
    .eq("indexable", true)
    .eq("topic.provider.enabled", true)
    .in("freshness", ["current", "upcoming", "recent"])
    .order("last_verified_at", { ascending: false })
    .limit(60);
  throwIfError(error);
  return ((data ?? []) as unknown as PublicOpportunity[])
    .map(projectOpportunity)
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

export const getApprovedPublicChanges = unstable_cache(
  () => safePublicRead(queryApprovedChanges, []),
  ["public-changes-v1"],
  {
    revalidate: 300,
  },
);

async function queryPublicProviders() {
  const client = createSupabaseServerClient();
  const { data, error } = await client
    .from("growth_opportunities")
    .select(PAGE_SELECT)
    .in("decision", ["PUBLIC_PAGE", "HUB_UPDATE"])
    .eq("status", "approved_by_engine")
    .eq("publication_ready", true)
    .eq("topic.provider.enabled", true)
    .in("freshness", ["current", "upcoming", "recent"])
    .order("last_verified_at", { ascending: false })
    .limit(120);
  throwIfError(error);
  const providerMap = new Map<
    string,
    { slug: string; name: string; category: string; lastVerifiedAt: string; updates: number }
  >();
  for (const row of (data ?? []) as unknown as PublicOpportunity[]) {
    const opportunity = projectOpportunity(row);
    if (!opportunity) continue;
    const current = providerMap.get(opportunity.provider.slug);
    if (current) current.updates += 1;
    else
      providerMap.set(opportunity.provider.slug, {
        ...opportunity.provider,
        lastVerifiedAt: opportunity.lastVerifiedAt,
        updates: 1,
      });
  }
  return [...providerMap.values()]
    .filter((provider) => provider.updates >= 2)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const getApprovedPublicProviders = unstable_cache(
  () => safePublicRead(queryPublicProviders, []),
  ["public-providers-v1"],
  { revalidate: 300 },
);

async function queryProviderUpdates(providerSlug: string) {
  const client = createSupabaseServerClient();
  const { data, error } = await client
    .from("growth_opportunities")
    .select(PAGE_SELECT)
    .in("decision", ["PUBLIC_PAGE", "HUB_UPDATE"])
    .eq("status", "approved_by_engine")
    .eq("publication_ready", true)
    .eq("topic.provider.enabled", true)
    .in("freshness", ["current", "upcoming", "recent"])
    .eq("topic.provider.slug", providerSlug)
    .order("last_verified_at", { ascending: false })
    .limit(30);
  throwIfError(error);
  return ((data ?? []) as unknown as PublicOpportunity[])
    .map(projectOpportunity)
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

export function getApprovedProviderUpdates(providerSlug: string) {
  return unstable_cache(
    () => safePublicRead(() => queryProviderUpdates(providerSlug), []),
    ["public-provider-updates-v1", providerSlug],
    { revalidate: 300 },
  )();
}

export async function getApprovedPublicEvidence(opportunityId: string) {
  return safePublicRead(async () => {
    const client = createSupabaseServerClient();
    const { data, error } = await client
      .from("growth_opportunity_evidence")
      .select("excerpt,observed_at,source:source_catalog!inner(name,source_type,url)")
      .eq("opportunity_id", opportunityId)
      .order("observed_at", { ascending: false })
      .limit(4);
    throwIfError(error);
    const evidence = (data ?? []).map((row) => {
      const source = first(
        row.source as
          | { name: string; source_type: string; url: string }
          | Array<{ name: string; source_type: string; url: string }>
          | null,
      );
      if (!source) return null;
      const item = {
        excerpt: row.excerpt,
        observedAt: row.observed_at,
        source: { name: source.name, type: source.source_type, url: source.url },
      };
      return validatePublishableFields(item).safe ? item : null;
    });
    return evidence.filter((item): item is NonNullable<typeof item> => item !== null);
  }, []);
}

async function queryPublicToolDirectory() {
  const client = createSupabaseServerClient();
  const [dependencies, sources] = await Promise.all([
    client
      .from("dependency_catalog")
      .select("id,slug,name,category")
      .eq("enabled", true)
      .order("name", { ascending: true })
      .limit(100),
    client
      .from("source_catalog")
      .select("dependency_id,source_type", { count: "exact" })
      .eq("enabled", true)
      .limit(500),
  ]);
  throwIfError(dependencies.error);
  throwIfError(sources.error);
  const sourceCoverage = summarizeEnabledSources(sources.data ?? [], sources.count ?? null);
  const changes = await getApprovedPublicChanges();
  return (dependencies.data ?? []).map((dependency) => {
    const coverage = sourceCoverage.byDependency.get(dependency.id) ?? { total: 0, byType: {} };
    return {
      slug: dependency.slug,
      name: dependency.name,
      category: dependency.category,
      authoritativeSources: coverage.total,
      sourceCoveragePartial: sourceCoverage.partial,
      sourcesByType: coverage.byType,
      approvedChanges: changes
        .filter((change) => change.provider.slug === dependency.slug)
        .map(
          ({
            id,
            canonicalSlug,
            label,
            headline,
            summary,
            freshness,
            effectiveAt,
            lastVerifiedAt,
          }) => ({
            id,
            canonicalSlug,
            label,
            headline,
            summary,
            freshness,
            effectiveAt,
            lastVerifiedAt,
          }),
        ),
    };
  });
}

export const getPublicToolDirectory = unstable_cache(
  () => safePublicRead(queryPublicToolDirectory, []),
  ["public-tool-directory-v1"],
  { revalidate: 300 },
);

export function getPublicSiteOrigin() {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  try {
    const url = new URL(configured || "https://auterim.com");
    return url.origin;
  } catch {
    return "https://auterim.com";
  }
}
