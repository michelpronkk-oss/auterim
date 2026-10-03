import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicShell } from "@/app/public-surfaces";
import { validatePublishableFields } from "@/lib/growth/contract";
import { getChangePageContract } from "@/lib/growth/read-models";
import { isPublicEvidenceFresh } from "@/lib/public/freshness";

export const revalidate = 300;

async function pageData(providerSlug: string, slug: string) {
  const data = await getChangePageContract(slug).catch(() => null);
  if (!data || data.provider.slug !== providerSlug || data.canonicalSlug !== slug) return null;
  if (!isPublicEvidenceFresh(data.lastVerifiedAt)) return null;
  const evidence = data.authoritativeEvidence
    .map((item) => {
      const source = Array.isArray(item.source) ? item.source[0] : item.source;
      return source
        ? {
            sourceName: source.name,
            sourceType: source.source_type,
            sourceUrl: source.url,
            excerpt: item.excerpt,
            observedAt: item.observed_at,
          }
        : null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const output = {
    provider: data.provider,
    headline: data.headline,
    canonicalSlug: data.canonicalSlug,
    whatChanged: data.whatChanged,
    announcedAt: data.announcedAt,
    effectiveAt: data.effectiveAt,
    affectedPublicEntities: Array.isArray(data.affectedPublicEntities)
      ? data.affectedPublicEntities.filter((entity): entity is string => typeof entity === "string")
      : [],
    generalImpact: data.generalImpact,
    evidence,
    lastVerifiedAt: data.lastVerifiedAt,
  };
  return validatePublishableFields(output).safe ? output : null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ provider: string; slug: string }>;
}): Promise<Metadata> {
  const { provider, slug } = await params;
  const data = await pageData(provider, slug);
  if (!data) return { title: "Change page unavailable", robots: { index: false, follow: false } };
  return {
    title: `${data.headline} — ${data.provider.name}`,
    description: data.whatChanged.slice(0, 155),
    alternates: { canonical: `/changes/${provider}/${slug}` },
    openGraph: {
      title: data.headline,
      description: data.whatChanged.slice(0, 155),
      type: "article",
    },
  };
}

export default async function PublicChangePage({
  params,
}: {
  params: Promise<{ provider: string; slug: string }>;
}) {
  const { provider, slug } = await params;
  const data = await pageData(provider, slug);
  if (!data) notFound();
  return (
    <PublicShell>
      <article className="public-change-detail">
        <p className="eyebrow">{data.provider.name} · APPROVED PUBLIC CHANGE</p>
        <h1>{data.headline}</h1>
        <p className="public-lead">{data.whatChanged}</p>
        {data.generalImpact && (
          <section>
            <h2>Why this may matter</h2>
            <p>{data.generalImpact}</p>
          </section>
        )}
        {data.affectedPublicEntities.length > 0 && (
          <section>
            <h2>Public entities mentioned in the evidence</h2>
            <ul>
              {data.affectedPublicEntities.map((entity) => (
                <li key={entity}>{entity}</li>
              ))}
            </ul>
          </section>
        )}
        <dl className="public-date-grid">
          {data.announcedAt && (
            <div>
              <dt>Announced</dt>
              <dd>
                {new Date(data.announcedAt).toLocaleDateString("en-US", {
                  dateStyle: "long",
                  timeZone: "UTC",
                })}
              </dd>
            </div>
          )}
          {data.effectiveAt && (
            <div>
              <dt>Effective</dt>
              <dd>
                {new Date(data.effectiveAt).toLocaleDateString("en-US", {
                  dateStyle: "long",
                  timeZone: "UTC",
                })}
              </dd>
            </div>
          )}
          <div>
            <dt>Last verified</dt>
            <dd>
              {new Date(data.lastVerifiedAt).toLocaleDateString("en-US", {
                dateStyle: "long",
                timeZone: "UTC",
              })}
            </dd>
          </div>
        </dl>
        <section>
          <h2>Authoritative sources</h2>
          <ul className="public-evidence-list">
            {data.evidence.map((item, index) => (
              <li key={`${item.sourceUrl}-${index}`}>
                <a href={item.sourceUrl} rel="noopener noreferrer" target="_blank">
                  {item.sourceName} ({item.sourceType}) ↗
                </a>
                <blockquote>{item.excerpt}</blockquote>
              </li>
            ))}
          </ul>
        </section>
        <aside className="public-scan-cta">
          <div>
            <p className="eyebrow">CHECK YOUR EXPOSURE</p>
            <h2>A global change is not the same as your impact.</h2>
            <p>
              Auterim checks your confirmed dependencies and can verify repository references when
              GitHub is connected.
            </p>
          </div>
          <Link className="primary-link" href="/tools/stack-scanner">
            Scan a company URL <span aria-hidden="true">→</span>
          </Link>
        </aside>
      </article>
    </PublicShell>
  );
}
