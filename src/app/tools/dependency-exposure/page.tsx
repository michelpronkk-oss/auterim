import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { ProviderMark } from "@/app/_home/marks";
import { SiteShell } from "@/app/_site/site-shell";
import { getPublicToolDirectory } from "@/lib/public/intelligence";
import { coverageTypes } from "../tool-data";
import {
  DateChip,
  EmptyState,
  MoreTools,
  ToolHero,
  tools as s,
  verifiedLabel,
} from "../tool-parts";
import { ServicePicker } from "./service-picker";

export const revalidate = 300;
export const metadata: Metadata = {
  title: "Dependency coverage",
  description: "See how many official sources Auterim monitors for a service, by type.",
  alternates: { canonical: "/tools/dependency-exposure" },
};
export const viewport: Viewport = { themeColor: "#e4ebf9" };

export default async function DependencyCoveragePage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string }>;
}) {
  const { provider } = await searchParams;
  const directory = await getPublicToolDirectory();
  const selected = provider ? directory.find((item) => item.slug === provider) : undefined;
  const services = directory.map((item) => ({
    slug: item.slug,
    name: item.name,
    category: item.category,
    total: item.authoritativeSources,
    aliases: item.aliases,
    coverageStatus: item.coverageStatus,
  }));
  const quick = [...directory]
    .sort((a, b) => b.authoritativeSources - a.authoritativeSources)
    .filter((item) => item.authoritativeSources > 0)
    .slice(0, 6);
  const types = selected ? coverageTypes(selected.sourcesByType) : [];
  const total = selected?.authoritativeSources ?? 0;

  return (
    <SiteShell
      current="tools"
      hero={
        <ToolHero
          tool="coverage"
          eyebrow="DEPENDENCY COVERAGE"
          dot
          title="How closely is it watched?"
          lede="Pick a service. See every official source Auterim monitors for it."
        >
          <ServicePicker
            key={selected?.slug ?? "none"}
            services={services}
            selected={selected?.slug}
          />
        </ToolHero>
      }
    >
      <section aria-live="polite" className={s.body}>
        {!selected && quick.length ? (
          <>
            {provider ? (
              <p role="status" className={s.notice}>
                That service isn&apos;t in the catalog yet. Try one of these.
              </p>
            ) : null}
            <span className={s.label}>MOST WATCHED</span>
            <ul className={s.tiles}>
              {quick.map((item) => (
                <li key={item.slug}>
                  <Link
                    href={`/tools/dependency-exposure?provider=${item.slug}`}
                    scroll={false}
                    className={s.tile}
                  >
                    <span className={s.tileTop}>
                      <ProviderMark provider={item.name} size={32} />
                      <span className={s.tileName}>{item.name}</span>
                      <span aria-hidden="true" className={s.tileArrow}>
                        →
                      </span>
                    </span>
                    <span className={s.tileCount}>
                      <b>{item.authoritativeSources}</b> official sources
                    </span>
                    <span aria-hidden="true" className={s.pvStack}>
                      {coverageTypes(item.sourcesByType).map((type) => (
                        <i key={type.key} style={{ flex: type.count, background: type.color }} />
                      ))}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : !selected ? (
          <EmptyState
            title={
              provider
                ? "That service isn't in the catalog yet."
                : "The catalog is updating. Check back shortly."
            }
          />
        ) : (
          <article aria-labelledby="coverage-name" className={s.card}>
            <div className={s.covTop}>
              <div className={s.covLeft}>
                <div className={s.covName}>
                  <ProviderMark provider={selected.name} size={44} />
                  <h2 id="coverage-name">{selected.name}</h2>
                </div>
                <div className={s.covTotal}>
                  {selected.sourceCoveragePartial ? (
                    <span className={s.atLeast}>AT LEAST</span>
                  ) : null}
                  <b>{total}</b>
                  official source{total === 1 ? "" : "s"} monitored
                </div>
              </div>
              {types.length ? (
                <div className={s.covRight}>
                  <span className={s.label}>BY SOURCE TYPE</span>
                  <div aria-hidden="true" className={s.stack}>
                    {types.map((type) => (
                      <i key={type.key} style={{ flex: type.count, background: type.color }} />
                    ))}
                  </div>
                  <dl className={s.types}>
                    {types.map((type) => (
                      <div key={type.key}>
                        <i
                          aria-hidden="true"
                          className={s.swatch}
                          style={{ background: type.color }}
                        />
                        <dt>{type.label}</dt>
                        <dd>
                          {selected.sourceCoveragePartial ? "≥ " : ""}
                          {type.count}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ) : null}
            </div>

            <div className={s.covChanges}>
              <h3 className={`${s.label} ${s.covChangesHead}`}>
                CURRENT APPROVED CHANGES · {selected.approvedChanges.length}
              </h3>
              {selected.approvedChanges.length ? (
                <ul className={s.changeLinks}>
                  {selected.approvedChanges.map((change) => (
                    <li key={change.id}>
                      <Link
                        href={`/changes/${selected.slug}/${change.canonicalSlug}`}
                        className={s.changeLink}
                      >
                        <span className={s.changeLinkText}>
                          <span className={s.changeLinkTitle}>{change.headline}</span>
                          <span className={s.changeLinkMeta}>
                            {change.label} · Verified {verifiedLabel(change.lastVerifiedAt)}
                          </span>
                        </span>
                        <span className={s.changeLinkEnd}>
                          {change.effectiveAt ? <DateChip iso={change.effectiveAt} /> : null}
                          <span className={s.link}>
                            View change <span aria-hidden="true">→</span>
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className={s.covNone}>
                  <b>No approved changes for {selected.name} right now.</b>
                  {total > 0
                    ? `Auterim is watching ${total === 1 ? "its source" : `all ${total} sources`}. Anything it verifies lands here.`
                    : selected.coverageStatus === "coverage_unknown"
                      ? "Coverage status is unknown because the public source list is incomplete."
                      : "Coverage pending: no authoritative provider sources are cataloged for this service yet."}
                </div>
              )}
            </div>
          </article>
        )}
      </section>
      <MoreTools current="coverage" />
    </SiteShell>
  );
}
