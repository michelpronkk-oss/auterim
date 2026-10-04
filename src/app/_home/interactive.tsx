"use client";

import { useEffect, useRef, useState } from "react";
import { catalog, coverageCategories, mapGroups, mapStatus, mapStatusStyle } from "./data";
import { ANALYZE_EVENT } from "./hero";
import { BrandMark, ProviderMark } from "./marks";
import s from "./home.module.css";

const levels = {
  action: { level: "ACTION REQUIRED", glyph: "■", color: "#A8402D", bg: "rgba(168,64,45,.1)" },
  review: { level: "REVIEW", glyph: "◆", color: "#2F5BD8", bg: "rgba(47,91,216,.1)" },
  none: { level: "NO ACTION", glyph: "○", color: "#3A4558", bg: "rgba(14,27,46,.07)" },
  assessing: { level: "ASSESSING", glyph: "…", color: "#3A4558", bg: "rgba(14,27,46,.07)" },
};

/** Change inbox: the low-impact item is assessed, then quietly filtered away. */
export function ChangeInbox() {
  const [tick, setTick] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  useEffect(() => {
    const interval = window.setInterval(() => setTick((value) => value + 1), 900);
    return () => window.clearInterval(interval);
  }, []);
  const phase = Math.floor(tick / 3) % 5;
  const assessing = phase === 0;
  const collapsed = phase >= 2;
  const rows = [
    {
      p: "Anthropic",
      t: "API deprecation announced",
      sub: "Affects AI processing · review before Nov 12",
      time: "14m ago",
      src: "docs.anthropic.com/deprecations",
      details: [
        { k: "Affects", v: "AI processing" },
        { k: "Review before", v: "Nov 12" },
        { k: "Confidence", v: "High" },
      ],
      ...levels.action,
    },
    {
      p: "Vercel",
      t: "Pricing updated",
      sub: "Potential impact: infrastructure spend",
      time: "2h ago",
      src: "vercel.com/pricing",
      details: [
        { k: "Potential impact", v: "Infrastructure spend" },
        { k: "Plan affected", v: "Pro" },
        { k: "Confidence", v: "High" },
      ],
      ...levels.review,
    },
    {
      p: "Supabase",
      t: "Documentation updated",
      sub: assessing ? "Assessing impact…" : "No meaningful impact detected",
      time: "3h ago",
      src: "supabase.com/docs",
      details: [
        { k: "Assessment", v: "No meaningful impact detected" },
        { k: "Action", v: "None. Filtered automatically" },
      ],
      ...(assessing ? levels.assessing : levels.none),
    },
  ];
  const detail = rows[selectedIndex];
  return (
    <div data-reveal className={s.inbox}>
      <div className={s.inboxList}>
        <div className={s.inboxBar}>
          <div className={s.inboxTitle}>
            <BrandMark size={16} />
            <span>Changes</span>
          </div>
          <div className={s.inboxTabs}>
            <span className={s.inboxTabOn}>Needs you · 2</span>
            <span className={s.inboxTab}>Filtered · {collapsed ? 24 : 23}</span>
          </div>
        </div>
        <div role="listbox" aria-label="Changes" className={s.inboxRows}>
          {rows.map((r, i) => {
            const hidden = i === 2 && collapsed;
            const on = selectedIndex === i;
            return (
              <div
                key={r.p}
                className={s.inboxCollapse}
                style={{ maxHeight: hidden ? 0 : 160, opacity: hidden ? 0 : i === 2 ? 0.75 : 1 }}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  tabIndex={hidden ? -1 : 0}
                  className={on ? `${s.inboxRow} ${s.inboxRowOn}` : s.inboxRow}
                  onClick={() => setSelectedIndex(i)}
                >
                  <span className={s.inboxRowMark}>
                    <ProviderMark provider={r.p} size={28} />
                  </span>
                  <span className={s.inboxRowTitle}>
                    {r.p} · {r.t}
                  </span>
                  <span className={s.levelPill} style={{ color: r.color, background: r.bg }}>
                    {r.glyph} {r.level}
                  </span>
                  <span className={s.inboxRowSub}>{r.sub}</span>
                  <span className={s.inboxRowTime}>{r.time}</span>
                </button>
              </div>
            );
          })}
          <div
            className={s.inboxCollapse}
            style={{
              maxHeight: collapsed ? 60 : 0,
              opacity: collapsed ? 1 : 0,
              transitionDelay: "0s, .2s",
            }}
          >
            <div className={s.filteredRow}>
              <ProviderMark provider="Supabase" size={18} />
              <span className={s.clip}>Supabase · Documentation updated</span>
              <span className={s.monoXs}>FILTERED · NO IMPACT</span>
            </div>
          </div>
        </div>
      </div>
      <div className={s.inboxDetail}>
        <div className={s.inboxDetailTop}>
          <span className={s.levelPillLg} style={{ color: detail.color, background: detail.bg }}>
            {detail.glyph} {detail.level}
          </span>
          <span className={s.monoSm}>{detail.time}</span>
        </div>
        <div className={s.inboxDetailHead}>
          <ProviderMark provider={detail.p} size={44} />
          <div className={s.rowText}>
            <span className={s.detailProvider}>{detail.p}</span>
            <span className={s.detailTitle}>{detail.t}</span>
          </div>
        </div>
        <div className={s.kvCard}>
          {detail.details.map((x) => (
            <div key={x.k} className={s.kvRow}>
              <span>{x.k}</span>
              <strong>{x.v}</strong>
            </div>
          ))}
        </div>
        <div className={s.verified}>
          <span>✓</span>Source verified · {detail.src}
        </div>
      </div>
    </div>
  );
}

/** Dependency map with a selectable provider and its monitored sources. */
export function DependencyMap() {
  const [selected, setSelected] = useState("OpenAI");
  const status = mapStatusStyle[mapStatus[selected]];
  const sources = catalog[selected][1];
  const item = (name: string, compact: boolean) => {
    const st = mapStatusStyle[mapStatus[name]];
    const on = selected === name;
    return (
      <button
        key={name}
        type="button"
        aria-pressed={on}
        className={on ? `${s.mapItem} ${s.mapItemOn}` : s.mapItem}
        onClick={() => setSelected(name)}
      >
        <ProviderMark provider={name} size={26} />
        {compact ? (
          <>
            <span className={s.mapItemNameWide}>{name}</span>
            <span className={s.mapItemStatus} style={{ color: st.color }}>
              {st.glyph} {st.label}
            </span>
          </>
        ) : (
          <span className={s.rowText}>
            <span className={s.mapItemName}>{name}</span>
            <span className={s.mapItemStatus} style={{ color: st.color }}>
              <span>{st.glyph}</span>
              {st.label}
            </span>
          </span>
        )}
      </button>
    );
  };
  return (
    <div data-reveal className={s.mapGrid}>
      <div className={s.mapCanvas}>
        <div className={s.mapWide}>
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
            className={s.mapLines}
          >
            {mapGroups.map((g) => (
              <line
                key={g.name}
                x1="50"
                y1="50"
                x2={g.left}
                y2={g.top}
                stroke={g.items.includes(selected) ? "rgba(47,91,216,.7)" : "rgba(14,27,46,.18)"}
                strokeWidth="1.2"
                vectorEffect="non-scaling-stroke"
                strokeDasharray="4 4"
                className={s.dash}
              />
            ))}
          </svg>
          <div className={s.mapCenter}>
            <BrandMark size={22} tone="dark" />
            <div className={s.rowText}>
              <span className={s.mapCenterName}>Your company</span>
              <span className={s.mapCenterMeta}>7 dependencies · 27 sources</span>
            </div>
          </div>
          {mapGroups.map((g) => (
            <div
              key={g.name}
              className={s.mapGroup}
              style={{ left: `${g.left}%`, top: `${g.top}%` }}
            >
              <span className={s.mapGroupName}>{g.name}</span>
              {g.items.map((name) => item(name, false))}
            </div>
          ))}
        </div>
        <div className={s.mapNarrow}>
          <div className={s.mapNarrowRoot}>
            <BrandMark size={20} tone="dark" />
            <span>Your company</span>
          </div>
          {mapGroups.map((g) => (
            <div key={g.name} className={s.mapNarrowGroup}>
              <span className={s.mapGroupName}>{g.name}</span>
              {g.items.map((name) => item(name, true))}
            </div>
          ))}
        </div>
      </div>
      <div className={s.mapSide} aria-live="polite">
        <div className={s.mapSideHead}>
          <ProviderMark provider={selected} size={40} tone="dark" />
          <div className={s.rowText}>
            <span className={s.mapSideName}>{selected}</span>
            <span className={s.monoXs} style={{ color: status.dark }}>
              {status.glyph} {status.label}
            </span>
          </div>
        </div>
        <span className={s.monoLabelDark}>{sources.length} MONITORED SOURCES</span>
        <div className={s.mapSideList}>
          {sources.map((src) => {
            const changed = mapStatus[selected] === "change" && src[1] === "P";
            const review = mapStatus[selected] === "review" && src[1] === "D";
            return (
              <div key={`${selected}-${src[0]}`} className={s.mapSideRow}>
                <span>{src[0]}</span>
                <span
                  className={s.monoXs}
                  style={{ color: changed ? "#D9A54A" : review ? "#E07A66" : "#8FA3C2" }}
                >
                  {changed ? "◆ changed 14m ago" : review ? "▲ review" : "○ watching"}
                </span>
              </div>
            );
          })}
        </div>
        <span className={s.mapSideFoot}>Last checked 2m ago</span>
      </div>
    </div>
  );
}

/** Coverage catalog with category tabs. */
/** Constellation slots (percent of the square): an inner ring of 6 and an outer ring of 8. */
const orbitSlots = [
  ...Array.from({ length: 6 }, (_, i) => ({ r: 23, a: -90 + i * 60 })),
  ...Array.from({ length: 8 }, (_, i) => ({ r: 39, a: -67.5 + i * 45 })),
].map(({ r, a }) => ({
  x: +(50 + r * Math.cos((a * Math.PI) / 180)).toFixed(2),
  y: +(50 + r * Math.sin((a * Math.PI) / 180)).toFixed(2),
}));

const TOUR_MS = 3200;

function OrbitDetailBody({ provider }: { provider: string }) {
  const [category, sources] = catalog[provider];
  return (
    <>
      <div className={s.orbitDetailHead}>
        <ProviderMark provider={provider} size={44} />
        <div className={s.rowText}>
          <span className={s.orbitName}>{provider}</span>
          <span className={s.orbitCat}>{category}</span>
        </div>
        <span className={s.orbitCount}>
          <b>{sources.length}</b> source types
        </span>
      </div>
      <ul className={s.orbitChips}>
        {sources.map((src, i) => (
          <li key={src[0]} style={{ animationDelay: `${0.05 + i * 0.04}s` }}>
            <span aria-hidden="true" className={s.orbitChipDot} />
            {src[0]}
          </li>
        ))}
      </ul>
    </>
  );
}

export function CoverageCatalog() {
  const [category, setCategory] = useState("All");
  const providers = Object.keys(catalog).filter((n) => coverageCategories.includes(catalog[n][0]));
  const inCategory = (p: string) => category === "All" || catalog[p][0] === category;
  const rows = providers.filter(inCategory);
  const orbitProviders = providers.slice(0, orbitSlots.length);
  const [focus, setFocus] = useState(orbitProviders[0]);
  // The square tours its logos on its own while it is on screen; a tap takes over for a while.
  const [touring, setTouring] = useState(false);
  const [held, setHeld] = useState(false);
  const orbitRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = orbitRef.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(([entry]) => setTouring(entry.isIntersecting), {
      threshold: 0.4,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!touring || held) return;
    const id = window.setTimeout(() => {
      setFocus((cur) => orbitProviders[(orbitProviders.indexOf(cur) + 1) % orbitProviders.length]);
    }, TOUR_MS);
    return () => window.clearTimeout(id);
  }, [touring, held, focus, orbitProviders]);
  useEffect(() => {
    if (!held) return;
    const id = window.setTimeout(() => setHeld(false), 9000);
    return () => window.clearTimeout(id);
  }, [held, focus]);
  return (
    <div data-reveal className={s.catalog}>
      <div role="tablist" aria-label="Categories" className={s.catalogTabs}>
        {["All", ...coverageCategories].map((name) => {
          const on = category === name;
          return (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls="coverage-panel"
              className={on ? `${s.catalogTab} ${s.catalogTabOn}` : s.catalogTab}
              onClick={() => setCategory(name)}
            >
              <span>{name}</span>
              <span className={s.catalogTabN}>
                {name === "All"
                  ? providers.length
                  : providers.filter((p) => catalog[p][0] === name).length}
              </span>
            </button>
          );
        })}
      </div>
      <div id="coverage-panel" role="tabpanel" className={s.catalogPanel}>
        {/* Phones: every provider floats in one square around Auterim; tap one to see what it covers. */}
        <div ref={orbitRef} className={s.orbit}>
          <div className={s.orbitSquare}>
            <svg aria-hidden="true" viewBox="0 0 100 100" className={s.orbitLines}>
              <circle cx="50" cy="50" r="23" />
              <circle cx="50" cy="50" r="39" />
              {orbitProviders.map((p, i) => (
                <line
                  key={p}
                  x1="50"
                  y1="50"
                  x2={orbitSlots[i].x}
                  y2={orbitSlots[i].y}
                  className={p === focus ? s.orbitLineOn : s.orbitLine}
                />
              ))}
            </svg>
            <span aria-hidden="true" className={s.orbitCore}>
              <span className={s.pulseRing} />
              <BrandMark size={26} tone="dark" />
            </span>
            {orbitProviders.map((p, i) => (
              <button
                key={p}
                type="button"
                aria-label={`${p}, ${catalog[p][0]}`}
                aria-pressed={p === focus}
                aria-controls="coverage-focus"
                className={p === focus ? `${s.orbitTile} ${s.orbitTileOn}` : s.orbitTile}
                style={{
                  left: `${orbitSlots[i].x}%`,
                  top: `${orbitSlots[i].y}%`,
                  animationDelay: `${-((i * 0.83) % 6).toFixed(2)}s`,
                  animationDuration: `${5 + (i % 4) * 0.7}s`,
                }}
                onClick={() => {
                  setFocus(p);
                  setHeld(true);
                }}
              >
                <ProviderMark provider={p} size={34} />
              </button>
            ))}
          </div>
          {/* Every provider's card is laid out invisibly underneath, so the card keeps the
              height of the tallest one and nothing below it moves while the tour runs. */}
          <div id="coverage-focus" className={s.orbitDetail} aria-live={held ? "polite" : "off"}>
            {touring && !held ? (
              <span
                key={focus}
                aria-hidden="true"
                className={s.orbitProgress}
                style={{ animationDuration: `${TOUR_MS}ms` }}
              />
            ) : null}
            {orbitProviders.map((p) => (
              <div key={p} aria-hidden="true" className={s.orbitGhost}>
                <OrbitDetailBody provider={p} />
              </div>
            ))}
            <div key={focus} className={s.orbitDetailBody}>
              <OrbitDetailBody provider={focus} />
            </div>
          </div>
        </div>
        <div className={s.catalogTable}>
          <div className={s.catalogHead}>
            <span>PROVIDER</span>
            <span className={s.catalogSrcsHead}>SOURCE TYPES</span>
            <span>COVERAGE</span>
          </div>
          {rows.map((p) => (
            <div key={`${category}-${p}`} className={s.catalogRow}>
              <div className={s.catalogProvider}>
                <ProviderMark provider={p} size={28} />
                <div className={s.rowText}>
                  <span className={s.rowName}>{p}</span>
                  <span className={s.catalogCat}>{catalog[p][0]}</span>
                </div>
              </div>
              <span className={s.catalogSrcs}>
                {catalog[p][1].map((src) => src[0].toLowerCase()).join(" · ")}
              </span>
              <span className={s.catalogN}>{catalog[p][1].length} types</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Final CTA: hands the website to the hero analyzer and scrolls back up to it. */
export function FinalCtaForm() {
  const [url, setUrl] = useState("");
  return (
    <form
      className={s.ctaForm}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        window.scrollTo({ top: 0, behavior: "smooth" });
        window.dispatchEvent(new CustomEvent(ANALYZE_EVENT, { detail: { url } }));
      }}
    >
      <div className={s.urlFieldDark}>
        <label htmlFor="cta-url" className={s.srOnly}>
          Company website
        </label>
        <span aria-hidden="true" className={s.urlPrefixDark}>
          https://
        </span>
        <input
          id="cta-url"
          type="text"
          inputMode="url"
          autoComplete="url"
          placeholder="yourcompany.com"
          maxLength={2048}
          value={url}
          onChange={(event) => setUrl(event.target.value.replace(/^\s*https?:\/\//i, ""))}
        />
        <button type="submit" className={s.btnBlueLg}>
          Analyze
        </button>
      </div>
    </form>
  );
}
