import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { ProviderMark } from "@/app/_home/marks";
import { SiteShell } from "@/app/_site/site-shell";
import { getPublicToolDirectory } from "@/lib/public/intelligence";
import { coverageTypes, isDeprecationChange } from "./tool-data";
import { daysUntil, monthDay, ToolHero, toolLinks, tools as s, untilLabel } from "./tool-parts";

export const revalidate = 300;
export const metadata: Metadata = {
  title: "Free dependency tools",
  description:
    "Scan a website for likely dependencies, check how closely a service is monitored, and see upcoming deprecations.",
  alternates: { canonical: "/tools" },
};
export const viewport: Viewport = { themeColor: "#e4ebf9" };

const scanExample: Array<[provider: string, signal: string, level: number]> = [
  ["Vercel", "x-vercel-id", 3],
  ["Stripe", "js.stripe.com", 3],
  ["Supabase", "*.supabase.co", 2],
];

export default async function ToolsPage() {
  const directory = await getPublicToolDirectory();

  // Previews use live catalog data: the best-covered service, and the nearest dated deprecations.
  const covered = [...directory].sort((a, b) => b.authoritativeSources - a.authoritativeSources);
  const featured =
    covered.find((item) => item.name === "Stripe" && item.authoritativeSources > 0) ??
    covered.find((item) => item.authoritativeSources > 0);
  const featuredTypes = featured ? coverageTypes(featured.sourcesByType) : [];
  const upcoming = directory
    .flatMap((item) =>
      item.approvedChanges
        .filter((change) => isDeprecationChange(change) && change.effectiveAt)
        .map((change) => ({
          provider: item.name,
          ...change,
          days: daysUntil(change.effectiveAt!),
        })),
    )
    .filter((change) => change.days >= 0)
    .sort((a, b) => a.days - b.days)
    .slice(0, 3);
  const lead = upcoming[0];

  return (
    <SiteShell
      current="tools"
      hero={
        <ToolHero
          eyebrow="FREE TOOLS"
          title="Your dependencies, at a glance."
          lede="Three quick looks at what you run on and what's about to change. No account."
        />
      }
    >
      <section aria-label="Tools" className={s.grid}>
        <Link href={toolLinks.scanner.href} className={s.tool}>
          <div aria-hidden="true" className={`${s.preview} ${s.previewTop}`}>
            <div className={s.pvInput}>
              <span>acme.com</span>
              <span className={s.pvBtn}>Scan</span>
            </div>
            <span className={s.pvLabel}>3 LIKELY DEPENDENCIES</span>
            <div className={s.pvRows}>
              {scanExample.map(([provider, signal, level]) => (
                <div key={provider} className={s.pvRow}>
                  <ProviderMark provider={provider} size={22} />
                  <span className={s.pvName}>
                    {provider}
                    <small>{signal}</small>
                  </span>
                  <span className={s.bars}>
                    {[0, 1, 2].map((i) => (
                      <i key={i} data-on={i < level || undefined} />
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className={s.toolText}>
            <span className={s.toolTag}>NO ACCOUNT</span>
            <span className={s.toolName}>Stack scanner</span>
            <span className={s.toolDesc}>
              Enter a website. See which services it likely runs on, from signals on its homepage.
            </span>
            <span className={s.toolGo}>
              Scan a website <span aria-hidden="true">→</span>
            </span>
          </div>
        </Link>

        <Link href={toolLinks.coverage.href} className={s.tool}>
          <div aria-hidden="true" className={s.preview}>
            {featured ? (
              <>
                <span className={s.pvProvider}>
                  <ProviderMark provider={featured.name} size={30} />
                  {featured.name}
                </span>
                <span className={s.pvBig}>
                  <b>{featured.authoritativeSources}</b>
                  <span>official sources monitored</span>
                </span>
                <span className={s.pvStack}>
                  {featuredTypes.map((type) => (
                    <i key={type.key} style={{ flex: type.count, background: type.color }} />
                  ))}
                </span>
                <span className={s.pvTypes}>
                  {featuredTypes.slice(0, 4).map((type) => (
                    <span key={type.key}>
                      <span>{type.label}</span>
                      <b>{type.count}</b>
                    </span>
                  ))}
                </span>
              </>
            ) : (
              <span className={s.pvQuiet}>Official sources, counted by type.</span>
            )}
          </div>
          <div className={s.toolText}>
            <span className={s.toolTag}>
              <i className={s.dot} />
              LIVE CATALOG
            </span>
            <span className={s.toolName}>Dependency coverage</span>
            <span className={s.toolDesc}>
              Pick a service. See how many official sources Auterim watches for it, by type.
            </span>
            <span className={s.toolGo}>
              Check coverage <span aria-hidden="true">→</span>
            </span>
          </div>
        </Link>

        <Link href={toolLinks.deprecation.href} className={s.tool}>
          <div aria-hidden="true" className={s.preview}>
            {lead ? (
              <>
                <div className={s.pvLead}>
                  <span className={s.pvCal}>
                    <small>{monthDay(lead.effectiveAt!).month}</small>
                    <b>{monthDay(lead.effectiveAt!).day}</b>
                  </span>
                  <span className={s.pvLeadText}>
                    <span className={s.pvMeta}>
                      {lead.provider} · {lead.label}
                    </span>
                    <span className={s.pvHead}>{lead.headline}</span>
                    <span className={s.pvUntil}>{untilLabel(lead.days).toUpperCase()}</span>
                  </span>
                </div>
                {upcoming.slice(1).map((change) => {
                  const { month, day } = monthDay(change.effectiveAt!);
                  return (
                    <div key={change.id} className={s.pvNext}>
                      <span>
                        {month} {String(day).padStart(2, "0")}
                      </span>
                      <span>
                        {change.provider} · {change.headline}
                      </span>
                    </div>
                  );
                })}
              </>
            ) : (
              <span className={s.pvQuiet}>No dated deadlines right now.</span>
            )}
          </div>
          <div className={s.toolText}>
            <span className={s.toolTag}>APPROVED CHANGES</span>
            <span className={s.toolName}>Deprecation checker</span>
            <span className={s.toolDesc}>
              Upcoming deprecations, retirements and deadlines, verified by Auterim. Filter by
              provider.
            </span>
            <span className={s.toolGo}>
              See what&apos;s ending <span aria-hidden="true">→</span>
            </span>
          </div>
        </Link>
      </section>

      <section className={s.closing}>
        <div className={s.closingInner}>
          <h2 className={s.closingTitle}>Now check it against your code.</h2>
          <p className={s.closingText}>
            Auterim watches every change, finds where it hits your code, and prepares the fix for
            review.
          </p>
          <div className={s.closingActions}>
            <Link href="/#scan" className={s.btnCream}>
              Scan your company
            </Link>
            <Link href="/how-it-works" className={s.btnLine}>
              See how it works
            </Link>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
