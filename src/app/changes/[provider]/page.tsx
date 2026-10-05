import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicShell } from "@/app/public-surfaces";
import {
  getApprovedProviderUpdates,
  getApprovedPublicProviders,
  getApprovedPublicEvidence,
} from "@/lib/public/intelligence";

export const revalidate = 300;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ provider: string }>;
}): Promise<Metadata> {
  const { provider: slug } = await params;
  const providers = await getApprovedPublicProviders();
  const provider = providers.find((item) => item.slug === slug);
  if (!provider)
    return { title: "Provider updates — Auterim", robots: { index: false, follow: false } };
  return {
    title: `${provider.name} changes and updates`,
    description: `Current approved software changes and authoritative evidence for ${provider.name}.`,
    alternates: { canonical: `/changes/${provider.slug}` },
  };
}

export default async function ProviderHubPage({
  params,
}: {
  params: Promise<{ provider: string }>;
}) {
  const { provider: slug } = await params;
  const providers = await getApprovedPublicProviders();
  const provider = providers.find((item) => item.slug === slug);
  if (!provider) notFound();
  const updates = (await getApprovedProviderUpdates(slug)).slice(0, 12);
  const updatesWithEvidence = await Promise.all(
    updates.map(async (update) => ({
      ...update,
      evidence: await getApprovedPublicEvidence(update.id),
    })),
  );
  return (
    <PublicShell current="changes">
      <section className="public-page-intro">
        <p className="eyebrow">PROVIDER HUB · {provider.category.toUpperCase()}</p>
        <h1>{provider.name} changes and updates</h1>
        <p>
          Evidence-backed changes approved by Auterim’s policy. A provider mention or date alone is
          not a claim about your own systems.
        </p>
        <div className="public-card-meta">
          <span>
            {provider.updates} current approved update{provider.updates === 1 ? "" : "s"}
          </span>
          <span>
            Last verified{" "}
            {new Date(provider.lastVerifiedAt).toLocaleDateString("en-US", {
              dateStyle: "medium",
              timeZone: "UTC",
            })}
          </span>
        </div>
      </section>
      <section className="public-section">
        <div className="public-section-heading">
          <div>
            <p className="eyebrow">APPROVED INTELLIGENCE</p>
            <h2>Recent and upcoming changes</h2>
          </div>
        </div>
        {updatesWithEvidence.length ? (
          <div className="public-change-list">
            {updatesWithEvidence.map((update) => (
              <article className="public-change-card" key={update.id}>
                <p className="eyebrow">
                  {update.freshness} · verified{" "}
                  {new Date(update.lastVerifiedAt).toLocaleDateString("en-US", {
                    dateStyle: "medium",
                    timeZone: "UTC",
                  })}
                </p>
                <h3>{update.headline}</h3>
                <p>{update.summary}</p>
                {update.generalImpact && <p>{update.generalImpact}</p>}
                {update.effectiveAt && (
                  <p className="public-card-meta">
                    Effective{" "}
                    {new Date(update.effectiveAt).toLocaleDateString("en-US", {
                      dateStyle: "medium",
                      timeZone: "UTC",
                    })}
                  </p>
                )}
                {update.evidence.length > 0 && (
                  <ul className="public-evidence-list">
                    {update.evidence.map((evidence, index) => (
                      <li key={`${evidence.source.url}-${index}`}>
                        <a href={evidence.source.url} rel="noopener noreferrer" target="_blank">
                          {evidence.source.name} ({evidence.source.type})
                        </a>
                        <blockquote>{evidence.excerpt}</blockquote>
                      </li>
                    ))}
                  </ul>
                )}
                {update.canonicalSlug.startsWith(`${provider.slug}-`) && (
                  <Link
                    className="public-text-link"
                    href={`/changes/${provider.slug}/${update.canonicalSlug}`}
                  >
                    Open the change page →
                  </Link>
                )}
              </article>
            ))}
          </div>
        ) : (
          <p className="public-empty">
            This provider does not have enough current approved material for a provider hub.
          </p>
        )}
      </section>
      <p className="public-source-note">
        <Link href="/tools/stack-scanner">Scan your stack</Link> to see likely dependencies, then
        confirm them in your workspace before Auterim protects them.
      </p>
    </PublicShell>
  );
}
