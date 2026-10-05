import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { PublicPageView } from "@/app/public-page-view";
import {
  catalog,
  ctaPreview,
  discoverTable,
  mapStatusStyle,
  pricingDiff,
  publicSignals,
  quietStats,
  relevanceFilters,
  sourceChecked,
  sourceIcon,
  stream,
  surfaced,
} from "@/app/_home/data";
import { HeaderCta, HeroAnalyzer, HeroClouds } from "@/app/_home/hero";
import { ChangeInbox, CoverageCatalog, DependencyMap, FinalCtaForm } from "@/app/_home/interactive";
import { BrandMark, ProviderMark } from "@/app/_home/marks";
import { PricingSection } from "@/app/_home/pricing";
import { RevealOnScroll } from "@/app/_home/reveal";
import s from "@/app/_home/home.module.css";

const geist = Geist({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-geist",
});
const geistMono = Geist_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "Auterim — Know when what your business depends on changes",
  description:
    "Auterim watches the software, APIs and infrastructure behind your business, and tells you only when a change actually matters.",
  alternates: { canonical: "/" },
};

const openaiSources = catalog.OpenAI[1];

export default function Home() {
  return (
    <div className={`${geist.variable} ${geistMono.variable} ${s.page}`}>
      <PublicPageView event="homepage_view" />
      <RevealOnScroll />
      <main className={s.frame}>
        <div id="top" className={s.heroWrap}>
          <header className={s.header}>
            <Link href="/" aria-label="Auterim home" className={s.logo}>
              <BrandMark size={26} />
              <span>Auterim</span>
            </Link>
            <div className={s.headerActions}>
              <Link href="/login" className={s.signIn}>
                Sign in
              </Link>
              <HeaderCta />
            </div>
          </header>
          <HeroClouds />
          <section className={s.hero} aria-labelledby="hero-title">
            <div className={s.heroCopy}>
              <span className={s.heroBadge}>
                <span className={s.heroBadgeMark}>
                  <BrandMark size={13} tone="dark" />
                </span>
                <span>DEPENDENCY INTELLIGENCE</span>
              </span>
              <h1 id="hero-title" className={s.h1}>
                Know when your stack <span className={s.h1Accent}>changes.</span>
              </h1>
              <p className={s.heroLede}>
                Auterim watches every API, price and policy you rely on. You only hear about what
                matters.
              </p>
              <HeroAnalyzer />
            </div>
          </section>
        </div>

        {/* 02 Signal vs noise */}
        <section className={s.section} aria-labelledby="problem-title">
          <div data-reveal className={s.splitHead}>
            <div className={s.headCol}>
              <span className={s.eyebrow}>02 · THE PROBLEM</span>
              <h2 id="problem-title" className={s.h2}>
                Nothing stands still.
              </h2>
            </div>
            <div className={s.problemCopy}>
              <p>
                APIs break. Prices jump. Limits shrink. Most of it is noise.{" "}
                <strong>Some of it costs you.</strong>
              </p>
              <p className={s.problemPunch}>Auterim tells you which.</p>
            </div>
          </div>
          <div data-reveal className={s.pipe}>
            <div className={s.pipeIn}>
              <div className={s.laneHead}>
                <span>INCOMING · EXTERNAL CHANGES</span>
                <span>12 this week</span>
              </div>
              <div className={s.streamMask}>
                <div className={s.stream}>
                  {[...stream, ...stream].map(([p, t, time, src], i) => (
                    <div key={i} className={s.streamRow} aria-hidden={i >= stream.length}>
                      <ProviderMark provider={p} size={22} />
                      <div className={s.rowText}>
                        <span className={s.streamTitle}>{t}</span>
                        <span className={s.streamMeta}>
                          {time} · {src}
                        </span>
                      </div>
                      <span className={s.noImpact}>NO IMPACT</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className={s.pipeLayer}>
              <span className={s.monoLabelDark}>AUTERIM RELEVANCE LAYER</span>
              <span className={s.layerMark}>
                <span aria-hidden="true" className={s.pulseRing} />
                <BrandMark size={36} tone="dark" />
              </span>
              <div className={s.filterList}>
                {relevanceFilters.map((f) => (
                  <div key={f.k} className={s.filterRow}>
                    <span>{f.k}</span>
                    <span>{f.v}</span>
                  </div>
                ))}
              </div>
              <div className={s.inOut}>
                <span>12 in</span>
                <span>→</span>
                <span>2 out</span>
              </div>
            </div>
            <div className={s.pipeOut}>
              <div className={`${s.laneHead} ${s.laneHeadBlue}`}>
                <span>SURFACED · SIGNAL LANE</span>
                <span>2</span>
              </div>
              <div className={s.surfacedList}>
                {surfaced.map((c) => (
                  <div
                    key={c.p}
                    className={c.tone === "action" ? s.surfacedAction : s.surfacedReview}
                    style={{ animationDelay: c.delay }}
                  >
                    <div className={s.surfacedTop}>
                      <div className={s.surfacedProvider}>
                        <ProviderMark provider={c.p} size={28} />
                        <span>{c.p}</span>
                      </div>
                      <span className={s.surfacedTag}>{c.tag}</span>
                    </div>
                    <span className={s.surfacedTitle}>{c.t}</span>
                    <span className={s.monoXs}>{c.meta}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* 03 Discovery */}
        <section id="how" className={s.band} aria-labelledby="discover-title">
          <div className={s.bandInner}>
            <div data-reveal className={s.centerHead}>
              <span className={s.eyebrow}>03 · DISCOVER</span>
              <h2 id="discover-title" className={s.h2}>
                Start with your domain.
              </h2>
              <p className={s.lede}>Paste your URL. Auterim finds what you run on. You confirm.</p>
            </div>
            <div className={s.discoverGrid}>
              <div data-reveal className={s.browserCard}>
                <div className={s.browserBar}>
                  <span />
                  <span />
                  <span />
                  <span className={s.browserUrl}>yourcompany.com</span>
                </div>
                <div className={s.browserBody}>
                  <span className={s.monoBlueLabel}>01 · WEBSITE</span>
                  <span className={s.skel} style={{ width: "62%", height: 10 }} />
                  <span className={s.skelLight} style={{ width: "88%" }} />
                  <span className={s.skelLight} style={{ width: "74%" }} />
                  <span className={s.browserNote}>
                    One field. No integrations, no access to private systems.
                  </span>
                </div>
              </div>
              <div data-reveal="1" className={s.signalsCard}>
                <span className={s.monoBlueLabelDark}>02 · SIGNALS</span>
                {publicSignals.map((sig) => (
                  <div key={sig.k} className={s.signalRow}>
                    <span className={s.blinkDot} style={{ animationDelay: sig.delay }} />
                    <span>{sig.k}</span>
                    <span className={s.signalValue}>{sig.v}</span>
                  </div>
                ))}
              </div>
              <div data-reveal="2" className={s.discoverTable}>
                <div className={s.discoverHead}>
                  <span>DEPENDENCY</span>
                  <span>DISCOVERED</span>
                  <span>CONFIRMED BY YOU</span>
                </div>
                {discoverTable.map((d) => (
                  <div
                    key={d.name}
                    className={
                      d.state === "added" ? `${s.discoverRow} ${s.discoverRowAdded}` : s.discoverRow
                    }
                  >
                    <div className={s.discoverName}>
                      <ProviderMark provider={d.name} size={26} />
                      <span className={d.state === "rejected" ? s.struck : undefined}>
                        {d.name}
                      </span>
                    </div>
                    <span className={s[`disc_${d.discTone}`]}>{d.disc}</span>
                    <span className={s[`conf_${d.state}`]}>
                      <span aria-hidden="true">{d.glyph}</span>
                      {d.conf}
                    </span>
                  </div>
                ))}
                <div className={s.discoverFoot}>
                  Auterim discovers what it can. You confirm what&apos;s real.
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 04 Dependencies, not URLs */}
        <section className={`${s.section} ${s.splitSection}`} aria-labelledby="watches-title">
          <div data-reveal className={s.watchCopy}>
            <span className={s.eyebrow}>04 · WHAT IT WATCHES</span>
            <h2 id="watches-title" className={s.h2}>
              Dependencies, not URLs.
            </h2>
            <p className={s.lede}>Pick a service. Auterim watches every source behind it.</p>
            <div className={s.triStats}>
              <div>
                <span>1</span>
                <span>dependency selected</span>
              </div>
              <div className={s.triStatDark}>
                <span>5</span>
                <span>authoritative sources monitored</span>
              </div>
              <div>
                <span>0</span>
                <span>URLs manually configured</span>
              </div>
            </div>
          </div>
          <div data-reveal="1" className={s.treeCard}>
            <div className={s.treeRoot}>
              <ProviderMark provider="OpenAI" size={48} />
              <div className={s.rowText}>
                <span className={s.treeRootName}>OpenAI</span>
                <span className={s.monoSm}>AI · dependency · selected by you</span>
              </div>
              <span className={s.sourcesPill}>5 SOURCES</span>
            </div>
            <div className={s.treeBranches}>
              {openaiSources.map((src, i) => (
                <div key={src[0]} className={s.branch}>
                  <span className={s.branchLines}>
                    <span style={{ bottom: i === openaiSources.length - 1 ? "50%" : 0 }} />
                    <span />
                  </span>
                  <div className={s.branchCard} style={{ animationDelay: `${i * 90}ms` }}>
                    <span className={s.branchIcon}>{sourceIcon[src[1]]}</span>
                    <span className={s.branchLabel}>{src[0]}</span>
                    <span className={s.watching}>
                      <span className={s.blinkDot} />
                      watching
                    </span>
                    <span className={s.branchUrl}>{src[2]}</span>
                    <span className={s.branchChecked}>{sourceChecked[i]}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 05 Change inbox */}
        <section className={s.bandDark} aria-labelledby="inbox-title">
          <div className={s.bandInner}>
            <div data-reveal className={s.centerHead}>
              <span className={s.eyebrowDark}>05 · CHANGE INTELLIGENCE</span>
              <h2 id="inbox-title" className={s.h2}>
                Most changes can wait.
              </h2>
              <p className={s.ledeDark}>
                Auterim ranks every change by how you actually use it. The rest stays quiet.
              </p>
            </div>
            <ChangeInbox />
          </div>
        </section>

        {/* 06 Page vs meaning */}
        <section className={s.sectionCenter} aria-labelledby="difference-title">
          <div data-reveal className={s.centerHead}>
            <span className={s.eyebrow}>06 · THE DIFFERENCE</span>
            <h2 id="difference-title" className={s.h2}>
              Pages change. Dependencies matter.
            </h2>
          </div>
          <div className={s.compare}>
            <div data-reveal className={s.genericCard}>
              <div className={s.genericBar}>
                <span>GENERIC MONITOR</span>
                <span>diff #4821</span>
              </div>
              <div className={s.genericTitle}>OpenAI pricing page changed.</div>
              <div className={s.diff}>
                {pricingDiff.map((l, i) => (
                  <div key={i} className={s[`diff_${l.kind}`]}>
                    <span>{l.n}</span>
                    <span>{l.t}</span>
                  </div>
                ))}
              </div>
              <div className={s.genericFoot}>14 lines modified · no context</div>
            </div>
            <div data-reveal="1" className={s.compareArrow}>
              <span className={s.monoTiny}>PAGE CHANGE</span>
              <span className={s.arrowDot}>→</span>
              <span className={`${s.monoTiny} ${s.blueText}`}>BUSINESS MEANING</span>
            </div>
            <div data-reveal="2" className={s.meaningCard}>
              <div className={s.meaningBar}>
                <span>
                  <BrandMark size={12} tone="dark" />
                  AUTERIM
                </span>
                <span>14:02 UTC</span>
              </div>
              <div className={s.meaningBody}>
                <div className={s.meaningHead}>
                  <ProviderMark provider="OpenAI" size={36} tone="dark" />
                  <span>Pricing changed for a model used in your verification workflow.</span>
                </div>
                <div className={s.kvCardDark}>
                  <div>
                    <span>Used in</span>
                    <strong>Verification workflow</strong>
                  </div>
                  <div>
                    <span>Potential impact</span>
                    <strong>Higher processing costs</strong>
                  </div>
                  <div>
                    <span>Recommended</span>
                    <strong className={s.blueBright}>Review model routing</strong>
                  </div>
                  <div>
                    <span>Severity</span>
                    <span className={s.reviewPill}>◆ REVIEW</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 07 Dependency map */}
        <section className={s.bandMap} aria-labelledby="map-title">
          <div className={s.bandInnerLeft}>
            <div data-reveal className={s.splitHead}>
              <div className={s.headCol}>
                <span className={s.eyebrow}>07 · DEPENDENCY MAP</span>
                <h2 id="map-title" className={s.h2}>
                  Everything in context.
                </h2>
              </div>
              <div className={s.mapIntro}>
                <p className={s.lede}>
                  Tap any provider. See what&apos;s watched and what needs you.
                </p>
                <div className={s.legend}>
                  {Object.values(mapStatusStyle).map((l) => (
                    <span key={l.label}>
                      <span style={{ color: l.color }}>{l.glyph}</span>
                      {l.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <DependencyMap />
          </div>
        </section>

        {/* 08 Quiet */}
        <section className={s.quiet} aria-labelledby="quiet-title">
          <span data-reveal className={s.quietMark}>
            <span aria-hidden="true" className={s.quietPulse} />
            <BrandMark size={48} />
          </span>
          <h2 data-reveal id="quiet-title" className={s.h2Quiet}>
            Quiet by default. Clear when it matters.
          </h2>
          <div data-reveal className={s.quietCopy}>
            <p>Nothing important changed? Nothing to do.</p>
            <p>
              <strong>Something did? You&apos;ll know first.</strong>
            </p>
          </div>
          <div data-reveal className={s.quietStatus}>
            <span className={s.stable}>
              <span>●</span>All dependencies stable
            </span>
            <div className={s.quietStats}>
              {quietStats.map((q) => (
                <div key={q.k}>
                  <span>{q.v}</span>
                  <span>{q.k}</span>
                </div>
              ))}
            </div>
            <div className={s.toast} aria-hidden="true">
              <ProviderMark provider="OpenAI" size={28} />
              <div className={s.rowText}>
                <span className={s.toastTitle}>1 change needs your attention</span>
                <span className={s.monoXs}>OpenAI · pricing · just now</span>
              </div>
            </div>
          </div>
        </section>

        {/* 09 Coverage */}
        <section className={s.coverageSection} aria-labelledby="coverage-title">
          <div data-reveal className={s.headCol}>
            <span className={s.eyebrow}>09 · COVERAGE</span>
            <h2 id="coverage-title" className={`${s.h2} ${s.coverageH2}`}>
              Every service you rely on, in one place.
            </h2>
          </div>
          <CoverageCatalog />
        </section>

        {/* 10 Pricing */}
        <PricingSection />

        {/* 11 Final CTA */}
        <section className={s.finalCta} aria-labelledby="cta-title">
          <div className={s.finalInner}>
            <h2 data-reveal id="cta-title" className={s.h2Final}>
              See what you run on.
            </h2>
            <p data-reveal className={s.ledeDark}>
              Paste your domain. Confirm what you run on. Auterim watches the rest.
            </p>
            <FinalCtaForm />
            <div data-reveal aria-hidden="true" className={s.ctaPreview}>
              {ctaPreview.map((p) => (
                <div key={p.name} className={s.ctaPreviewRow} style={{ animationDelay: p.delay }}>
                  <ProviderMark provider={p.name} size={24} tone="dark" />
                  <span>{p.name}</span>
                  <span>{p.meta}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <footer className={s.footer}>
          <div className={s.footerBrand}>
            <div className={s.logo}>
              <BrandMark size={22} />
              <span>Auterim</span>
            </div>
            <span>Quiet intelligence for the systems your business depends on.</span>
          </div>
          <nav aria-label="Footer navigation" className={s.footerNav}>
            <Link href="/changes">Public changes</Link>
            <Link href="/tools">Free tools</Link>
            <a href="#pricing">Pricing</a>
            <Link href="/login">Sign in</Link>
          </nav>
          <span className={s.copyright}>© 2026 Auterim</span>
        </footer>
      </main>
    </div>
  );
}
