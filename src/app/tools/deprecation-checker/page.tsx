import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { ProviderMark } from "@/app/_home/marks";
import { SiteShell } from "@/app/_site/site-shell";
import { getPublicToolDirectory } from "@/lib/public/intelligence";
import { isDeprecationChange } from "../tool-data";
import {
  DateChip,
  daysUntil,
  EmptyState,
  MoreTools,
  ToolHero,
  tools as s,
  verifiedLabel,
} from "../tool-parts";
import { ProviderFilter } from "./provider-filter";

export const revalidate = 300;
export const metadata: Metadata = {
  title: "Deprecation checker",
  description:
    "Upcoming deprecations, retirements and deadlines from official provider sources, verified by Auterim.",
  alternates: { canonical: "/tools/deprecation-checker" },
};
export const viewport: Viewport = { themeColor: "#e4ebf9" };

type Change = {
  id: string;
  canonicalSlug: string;
  label: string;
  headline: string;
  summary: string;
  effectiveAt: string | null;
  lastVerifiedAt: string;
  provider: { slug: string; name: string };
  days: number | null;
};

const byDate = (a: Change, b: Change) => (a.days ?? 0) - (b.days ?? 0);

export default async function DeprecationCheckerPage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string }>;
}) {
  const { provider } = await searchParams;
  const directory = await getPublicToolDirectory();
  const all: Change[] = directory.flatMap((item) =>
    item.approvedChanges.filter(isDeprecationChange).map((change) => ({
      ...change,
      provider: { slug: item.slug, name: item.name },
      days: change.effectiveAt ? daysUntil(change.effectiveAt) : null,
    })),
  );
  const selected = provider ? directory.find((item) => item.slug === provider) : undefined;
  const changes = (selected ? all.filter((c) => c.provider.slug === selected.slug) : all).slice(
    0,
    30,
  );

  const groups = [
    {
      title: "NEXT 30 DAYS",
      items: changes.filter((c) => c.days !== null && c.days >= 0 && c.days <= 30).sort(byDate),
    },
    { title: "LATER", items: changes.filter((c) => c.days !== null && c.days > 30).sort(byDate) },
    { title: "NO DATE ANNOUNCED", items: changes.filter((c) => c.days === null) },
    {
      title: "ALREADY IN EFFECT",
      items: changes.filter((c) => c.days !== null && c.days < 0).sort((a, b) => byDate(b, a)),
    },
  ].filter((group) => group.items.length);

  return (
    <SiteShell
      current="tools"
      hero={
        <ToolHero
          tool="deprecation"
          eyebrow="DEPRECATION CHECKER"
          title="What's ending, and when."
          lede="Deprecations, retirements and deadlines. Each one verified by Auterim before it shows here."
        />
      }
    >
      <ProviderFilter
        providers={directory.map(({ slug, name }) => ({ slug, name }))}
        selected={selected?.slug}
        count={changes.length}
      />
      <section aria-live="polite" className={s.changes}>
        {changes.length === 0 ? (
          <EmptyState
            title={
              selected
                ? `No approved deprecation changes for ${selected.name} right now.`
                : "No approved deprecation changes right now."
            }
            text="We won't fill the gap with guesses."
          />
        ) : selected ? (
          <article aria-labelledby="provider-name" className={`${s.card} ${s.provider}`}>
            <div className={s.providerHead}>
              <div className={s.providerName}>
                <ProviderMark provider={selected.name} size={44} />
                <div>
                  <h2 id="provider-name">{selected.name}</h2>
                  <span>
                    {changes.length} approved change{changes.length === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
              <Link
                href={`/tools/dependency-exposure?provider=${selected.slug}`}
                className={s.link}
              >
                See coverage <span aria-hidden="true">→</span>
              </Link>
            </div>
            <ul className={s.providerList}>
              {[...groups.flatMap((group) => group.items)].map((change) => (
                <li key={change.id}>
                  <div className={s.providerMeta}>
                    <span>
                      <span className={s.tag}>{change.label}</span>
                      <span className={s.fresh}>
                        Verified {verifiedLabel(change.lastVerifiedAt)}
                      </span>
                    </span>
                    {change.effectiveAt ? (
                      <DateChip iso={change.effectiveAt} />
                    ) : (
                      <span className={s.noDate}>No date announced</span>
                    )}
                  </div>
                  <h3 className={s.providerHeadline}>{change.headline}</h3>
                  <p className={s.providerSummary}>{change.summary}</p>
                  <Link
                    href={`/changes/${change.provider.slug}/${change.canonicalSlug}`}
                    className={s.link}
                    style={{ alignSelf: "flex-start" }}
                  >
                    View change <span aria-hidden="true">→</span>
                  </Link>
                </li>
              ))}
            </ul>
          </article>
        ) : (
          groups.map((group) => (
            <div key={group.title} className={s.group}>
              <div className={s.groupHead}>
                <h2 className={s.label}>{group.title}</h2>
                <span aria-hidden="true" className={s.groupRule} />
                <span className={s.groupCount}>{group.items.length}</span>
              </div>
              <ul className={s.changeGrid}>
                {group.items.map((change) => (
                  <li key={change.id}>
                    <article className={s.changeCard}>
                      <div className={s.changeTop}>
                        <span className={s.changeWho}>
                          <ProviderMark provider={change.provider.name} size={28} />
                          {change.provider.name}
                          <small>· {change.label}</small>
                        </span>
                        <span className={s.fresh}>{verifiedLabel(change.lastVerifiedAt)}</span>
                      </div>
                      <h3 className={s.changeTitle}>{change.headline}</h3>
                      <p className={s.changeText}>{change.summary}</p>
                      <div className={s.changeFoot}>
                        {change.effectiveAt ? (
                          <DateChip iso={change.effectiveAt} prefix="Effective" />
                        ) : (
                          <span className={s.noDate}>No date announced</span>
                        )}
                        <Link
                          href={`/changes/${change.provider.slug}/${change.canonicalSlug}`}
                          aria-label={`View change: ${change.headline}`}
                          className={s.link}
                        >
                          View change <span aria-hidden="true">→</span>
                        </Link>
                      </div>
                    </article>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
      <MoreTools current="deprecation" wide />
    </SiteShell>
  );
}
