import type { Metadata } from "next";
import Link from "next/link";
import { PublicShell } from "@/app/public-surfaces";
import { getApprovedPublicChanges, getApprovedPublicProviders } from "@/lib/public/intelligence";
import { getPublicSiteOrigin } from "@/lib/public/intelligence";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Verified software changes",
  description:
    "Browse current and upcoming software changes approved from authoritative public sources.",
  alternates: { canonical: "/changes" },
};

export default async function ChangesPage() {
  const [changes, providers] = await Promise.all([
    getApprovedPublicChanges(),
    getApprovedPublicProviders(),
  ]);
  return (
    <PublicShell>
      <section className="public-page-intro">
        <p className="eyebrow">PUBLIC SOFTWARE INTELLIGENCE</p>
        <h1>Changes worth a closer look.</h1>
        <p>
          These pages show globally relevant changes Auterim’s evidence policy has approved for
          public use. They do not represent customer-specific impact.
        </p>
      </section>
      <section className="public-section">
        <div className="public-section-heading">
          <div>
            <p className="eyebrow">PROVIDER HUBS</p>
            <h2>Follow authoritative sources by provider.</h2>
          </div>
          <span className="public-microcopy">
            {providers.length} active provider {providers.length === 1 ? "hub" : "hubs"}
          </span>
        </div>
        {providers.length ? (
          <div className="public-provider-grid">
            {providers.map((provider) => (
              <Link
                className="public-provider-card"
                href={`/changes/${provider.slug}`}
                key={provider.slug}
              >
                <span className="provider-monogram">{provider.name.slice(0, 1)}</span>
                <span>
                  <strong>{provider.name}</strong>
                  <small>
                    {provider.updates} approved update{provider.updates === 1 ? "" : "s"}
                  </small>
                </span>
                <span aria-hidden="true">→</span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="public-empty">No provider hubs meet the publication threshold right now.</p>
        )}
      </section>
      <section className="public-section">
        <div className="public-section-heading">
          <div>
            <p className="eyebrow">INDEXABLE CHANGE PAGES</p>
            <h2>Current and upcoming changes.</h2>
          </div>
        </div>
        {changes.length ? (
          <div className="public-change-list">
            {changes.map((change) => (
              <article key={change.id} className="public-change-card">
                <p className="eyebrow">
                  {change.provider.name} · {change.freshness}
                </p>
                <h3>
                  <Link href={`/changes/${change.provider.slug}/${change.canonicalSlug}`}>
                    {change.headline}
                  </Link>
                </h3>
                <p>{change.summary}</p>
                <div className="public-card-meta">
                  {change.effectiveAt && (
                    <span>
                      Effective{" "}
                      {new Date(change.effectiveAt).toLocaleDateString("en-US", {
                        dateStyle: "medium",
                        timeZone: "UTC",
                      })}
                    </span>
                  )}
                  <span>
                    Verified{" "}
                    {new Date(change.lastVerifiedAt).toLocaleDateString("en-US", {
                      dateStyle: "medium",
                      timeZone: "UTC",
                    })}
                  </span>
                </div>
                <Link
                  className="public-text-link"
                  href={`/changes/${change.provider.slug}/${change.canonicalSlug}`}
                >
                  Read verified change →
                </Link>
              </article>
            ))}
          </div>
        ) : (
          <p className="public-empty">
            There are no public change pages that currently meet Auterim’s evidence and freshness
            requirements.
          </p>
        )}
      </section>
      <p className="public-source-note">
        Each public page links to the original source. Last refreshed from approved evidence; see{" "}
        <a href={`${getPublicSiteOrigin()}/tools`}>free tools</a> for a company-specific starting
        point.
      </p>
    </PublicShell>
  );
}
