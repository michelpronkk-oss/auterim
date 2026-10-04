"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import {
  canonicalizePublicWebsiteUrl,
  WebsiteUrlInputError,
} from "@/lib/discovery/normalize-website-url";
import { emitPublicConversionEvent, readPublicAttribution } from "@/lib/public/conversion";
import { catalog, catalogEntry, demoDefs, suggestedProviders, type CatalogSource } from "./data";
import { BrandMark, ProviderMark } from "./marks";
import s from "./home.module.css";

export const ANALYZE_EVENT = "auterim:home-analyze";
const HERO_INPUT_ID = "hero-url";

type Stage = "idle" | "analyzing" | "found" | "confirm" | "coverage" | "error";

type ScanResponse = {
  status: "completed" | "partial" | "failed";
  candidates: Array<{
    provider: string;
    confidenceLabel: "low" | "medium" | "high";
    signalTypes: string[];
  }>;
  message?: string;
};

type Found = { name: string; category: string; signal: string; high: boolean };

const signalLabel: Record<string, string> = {
  response_header: "response headers",
  script_host: "script source",
  script_path: "script source",
  document_host: "linked hosts",
  embedded_url: "embedded URL",
  markup_marker: "page markup",
  resource_host: "resource host",
  csp_host: "security policy",
  redirect_host: "redirects",
};

const checkLabels = [
  "Website infrastructure",
  "Public technology signals",
  "External services",
  "Dependency candidates",
];

const CHECK_STEP_MS = 520;
const SCAN_FALLBACK_MESSAGE = "This public website could not be scanned safely.";

/** Only messages the scan API wrote for people are shown; transport errors get a plain fallback. */
class ScanError extends Error {}

function attribution() {
  return readPublicAttribution(
    new URLSearchParams(window.location.search),
    window.location.pathname,
  );
}

function sourcesFor(name: string): readonly CatalogSource[] {
  return catalogEntry(name)?.[1][1] ?? [];
}

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
function subscribeReducedMotion(onChange: () => void) {
  const media = window.matchMedia(reducedMotionQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
function useReducedMotion() {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(reducedMotionQuery).matches,
    () => false,
  );
}

export function focusHeroInput() {
  window.scrollTo({ top: 0, behavior: "smooth" });
  window.setTimeout(
    () => document.getElementById(HERO_INPUT_ID)?.focus({ preventScroll: true }),
    350,
  );
}

export function HeaderCta() {
  return (
    <button type="button" className={s.navCta} onClick={focusHeroInput}>
      <span className={s.navCtaLong}>Analyze your company</span>
      <span className={s.navCtaShort}>Analyze</span>
    </button>
  );
}

/** Soft cloud band behind the hero that fades and drifts as the page scrolls. */
export function HeroClouds() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const y = window.scrollY;
      if (!ref.current) return;
      ref.current.style.opacity = Math.max(0, 1 - y / 520).toFixed(3);
      ref.current.style.transform = `translateY(${Math.round(y * 0.25)}px)`;
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <div ref={ref} aria-hidden="true" className={s.clouds}>
      <div className={s.cloudsSoft} />
      <div className={s.cloudsCrisp} />
    </div>
  );
}

export function HeroAnalyzer() {
  const [stage, setStage] = useState<Stage>("idle");
  const [url, setUrl] = useState("");
  const [formError, setFormError] = useState("");
  const [scanError, setScanError] = useState("");
  const [partial, setPartial] = useState(false);
  const [domain, setDomain] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [check, setCheck] = useState(0);
  const [found, setFound] = useState<Found[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [extra, setExtra] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [tick, setTick] = useState(0);
  const runId = useRef(0);
  const timers = useRef<number[]>([]);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (stage !== "idle" || reducedMotion) return;
    const interval = window.setInterval(() => setTick((value) => value + 1), 900);
    return () => window.clearInterval(interval);
  }, [stage, reducedMotion]);

  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);

  async function run(raw: string) {
    let canonical: string;
    try {
      canonical = canonicalizePublicWebsiteUrl(raw);
    } catch (error) {
      setFormError(
        error instanceof WebsiteUrlInputError ? error.message : "Enter a valid company website.",
      );
      return;
    }
    const id = ++runId.current;
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    setFormError("");
    setScanError("");
    setDomain(new URL(canonical).hostname.replace(/^www\./i, ""));
    setWebsiteUrl(canonical);
    setCheck(0);
    setFound([]);
    setPartial(false);
    setSelected([]);
    setExtra([]);
    setSearch("");
    setStage("analyzing");
    for (const step of [1, 2, 3]) {
      timers.current.push(window.setTimeout(() => setCheck(step), step * CHECK_STEP_MS));
    }
    const minimum = new Promise((resolve) => window.setTimeout(resolve, 4 * CHECK_STEP_MS));
    const attr = attribution();
    emitPublicConversionEvent("stack_scan_started", attr);
    try {
      const [body] = await Promise.all([
        fetch("/api/public/stack-scan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ websiteUrl: canonical }),
        }).then(async (response) => {
          const json = (await response.json().catch(() => null)) as ScanResponse | null;
          if (!response.ok || !json) throw new ScanError(json?.message || SCAN_FALLBACK_MESSAGE);
          if (json.status === "failed" && json.candidates.length === 0)
            throw new ScanError("Its public pages could not be reached or inspected.");
          return json;
        }),
        minimum,
      ]);
      if (id !== runId.current) return;
      const results = body.candidates.map((candidate): Found => {
        const entry = catalogEntry(candidate.provider);
        const name = entry?.[0] ?? candidate.provider;
        const signals = [
          ...new Set(candidate.signalTypes.map((t) => signalLabel[t] ?? t.replace(/_/g, " "))),
        ];
        return {
          name,
          category: entry?.[1][0] ?? "Detected service",
          signal: signals.join(", ") || "public signal",
          high: candidate.confidenceLabel === "high",
        };
      });
      const unique = results.filter(
        (item, index) => results.findIndex((other) => other.name === item.name) === index,
      );
      setCheck(4);
      setPartial(body.status !== "completed");
      setFound(unique);
      setSelected(unique.filter((item) => item.high).map((item) => item.name));
      setStage("found");
      emitPublicConversionEvent("stack_scan_completed", attr);
    } catch (error) {
      if (id !== runId.current) return;
      setScanError(error instanceof ScanError ? error.message : SCAN_FALLBACK_MESSAGE);
      setStage("error");
    }
  }

  const onExternalAnalyze = useEffectEvent((value: string) => {
    setUrl(value);
    void run(value);
  });
  useEffect(() => {
    const listener = (event: Event) => {
      const value = (event as CustomEvent<{ url: string }>).detail?.url ?? "";
      onExternalAnalyze(value);
    };
    window.addEventListener(ANALYZE_EVENT, listener);
    return () => window.removeEventListener(ANALYZE_EVENT, listener);
  }, []);

  // Idle demo: a 16-beat loop through discover → confirm → coverage.
  const dt = reducedMotion ? 15 : tick % 16;
  const dPhase = dt < 6 ? 0 : dt < 9 ? 1 : 2;
  const stepIdx =
    stage === "idle" ? dPhase : stage === "confirm" ? 1 : stage === "coverage" ? 2 : 0;

  const toggle = (name: string) =>
    setSelected((current) =>
      current.includes(name) ? current.filter((n) => n !== name) : [...current, name],
    );

  const foundNames = found.map((item) => item.name);
  const optionNames = [
    ...foundNames,
    ...suggestedProviders.filter((n) => !foundNames.includes(n)),
    ...extra.filter((n) => !foundNames.includes(n) && !suggestedProviders.includes(n)),
  ];
  const query = search.trim().toLowerCase();
  const results = query
    ? Object.keys(catalog)
        .filter((n) => n.toLowerCase().includes(query) && !optionNames.includes(n))
        .slice(0, 4)
    : [];
  const selectedSources = selected.flatMap((n) => sourcesFor(n));
  const breakdown = (
    [
      ["Pricing", "P"],
      ["Changelogs", "C"],
      ["API / Docs", "A"],
      ["Deprecations", "D"],
      ["Policies / limits", "L"],
    ] as const
  ).map(([label, kind]) => ({
    label,
    n: selectedSources.filter((src) => src[1] === kind).length,
  }));
  const breakdownMax = Math.max(1, ...breakdown.map((b) => b.n));

  const continueParams = new URLSearchParams({ websiteUrl });
  if (typeof window !== "undefined") {
    const search = new URLSearchParams(window.location.search);
    for (const key of ["utm_source", "utm_medium", "utm_campaign"]) {
      const value = search.get(key);
      if (value && /^[\p{L}\p{N}._ -]{1,100}$/u.test(value)) continueParams.set(key, value);
    }
  }

  return (
    <>
      <form
        className={s.heroForm}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void run(url);
        }}
      >
        <div className={s.urlField}>
          <label htmlFor={HERO_INPUT_ID} className={s.srOnly}>
            Company website
          </label>
          <span aria-hidden="true" className={s.urlPrefix}>
            https://
          </span>
          <input
            id={HERO_INPUT_ID}
            type="text"
            inputMode="url"
            autoComplete="url"
            placeholder="yourcompany.com"
            maxLength={2048}
            value={url}
            aria-invalid={formError ? true : undefined}
            aria-describedby={formError ? "hero-url-error" : undefined}
            onChange={(event) => {
              setUrl(event.target.value.replace(/^\s*https?:\/\//i, ""));
              setFormError("");
            }}
          />
          <button type="submit" className={s.btnInk} disabled={stage === "analyzing"}>
            Analyze
          </button>
        </div>
        {formError ? (
          <p id="hero-url-error" role="alert" className={s.formError}>
            {formError}
          </p>
        ) : null}
        <div className={s.heroMicro}>
          <span>No setup. See what Auterim finds in seconds.</span>
          <a href="#how">See how it works ↓</a>
        </div>
      </form>

      <div className={s.panel}>
        <div className={s.panelBar}>
          <div className={s.panelDomain}>
            <BrandMark size={16} />
            <span>{domain || "yourcompany.com"}</span>
          </div>
          <ol aria-label="Progress" className={s.steps}>
            {["DISCOVER", "CONFIRM", "COVERAGE"].map((label, i) => (
              <li
                key={label}
                aria-current={i === stepIdx ? "step" : undefined}
                className={i === stepIdx ? s.stepOn : i < stepIdx ? s.stepDone : s.step}
              >
                {label}
              </li>
            ))}
          </ol>
        </div>

        <div className={s.panelBody}>
          {/* Invisible, fully expanded copies of each demo phase share one grid cell, so the panel
              always reserves the tallest phase and the page below never shifts. */}
          {[0, 1, 2].map((phase) => (
            <div key={phase} aria-hidden="true" inert className={s.panelGhost}>
              <IdleDemo dt={15} dPhase={phase} />
            </div>
          ))}
          <div aria-live="polite" className={s.panelLayer}>
            {/* Keyed per loop so each pass starts fresh instead of collapsing the last one. */}
            {stage === "idle" ? (
              <IdleDemo key={Math.floor(tick / 16)} dt={dt} dPhase={dPhase} />
            ) : null}

            {stage === "analyzing" ? (
              <>
                <div className={s.analyzing}>
                  <span className={s.stageTitleLg}>Analyzing {domain}…</span>
                  <div className={s.checkList}>
                    {checkLabels.map((label, i) => (
                      <div
                        key={label}
                        className={s.checkRow}
                        style={{ color: check >= i ? "#0E1B2E" : "#7C8697" }}
                      >
                        <span className={s.checkIcon}>
                          {check > i ? (
                            <span className={s.tick}>✓</span>
                          ) : check === i ? (
                            <span className={s.spinner} />
                          ) : (
                            <span className={s.pendingDot} />
                          )}
                        </span>
                        {label}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : null}

            {stage === "error" ? (
              <div className={s.stageCol}>
                <div className={s.stageHead}>
                  <span className={s.stageTitle}>We couldn&apos;t scan {domain} right now.</span>
                  <span className={s.stageSub}>{scanError}</span>
                </div>
                <div className={s.stageFoot}>
                  <span className={s.footNote}>
                    You can still choose the services your business depends on.
                  </span>
                  <button type="button" className={s.btnInkSm} onClick={() => setStage("confirm")}>
                    Choose dependencies →
                  </button>
                </div>
              </div>
            ) : null}

            {stage === "found" ? (
              <div className={s.stageCol}>
                <div className={s.stageHead}>
                  <span className={s.stageTitle}>
                    {found.length
                      ? `We found ${found.length} likely ${found.length === 1 ? "dependency" : "dependencies"}.`
                      : "No public provider markers found."}
                  </span>
                  <span className={s.stageSub}>
                    {found.length
                      ? `Each one is based on a public signal from ${domain}.`
                      : `That doesn't mean ${domain} has no dependencies. Many are not publicly visible.`}
                    {partial
                      ? " The scan reached an inspection limit, so results may be incomplete."
                      : ""}
                  </span>
                </div>
                {found.length ? (
                  <div className={s.foundGrid}>
                    {found.map((item, i) => (
                      <div
                        key={item.name}
                        className={s.foundCard}
                        style={{ animationDelay: `${i * 80}ms` }}
                      >
                        <ProviderMark provider={item.name} size={28} />
                        <div className={s.rowText}>
                          <span className={s.rowName}>{item.name}</span>
                          <span className={s.rowMetaClip}>
                            {item.category} · {item.signal}
                          </span>
                        </div>
                        <span className={item.high ? s.pillHigh : s.pillPossible}>
                          {item.high ? "High confidence" : "Possible"}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className={s.stageFoot}>
                  <span className={s.footNote}>
                    Auterim can identify public signals. Confirm what your business actually relies
                    on to complete your coverage.
                  </span>
                  <button type="button" className={s.btnInkSm} onClick={() => setStage("confirm")}>
                    Confirm dependencies →
                  </button>
                </div>
              </div>
            ) : null}

            {stage === "confirm" ? (
              <div className={s.stageCol}>
                <div className={s.stageHead}>
                  <span className={s.stageTitle}>What does your business actually depend on?</span>
                  <span className={s.stageSub}>
                    Select services, not URLs. Auterim finds the sources behind each one.
                  </span>
                </div>
                <div className={s.searchWrap}>
                  <label htmlFor="dep-search" className={s.srOnly}>
                    Search software or service
                  </label>
                  <input
                    id="dep-search"
                    type="text"
                    className={s.searchInput}
                    placeholder="Search software or service…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  {results.length ? (
                    <div className={s.searchResults}>
                      {results.map((name) => (
                        <button
                          key={name}
                          type="button"
                          className={s.searchResult}
                          onClick={() => {
                            setExtra((current) => [...current, name]);
                            setSelected((current) => [...current, name]);
                            setSearch("");
                          }}
                        >
                          <ProviderMark provider={name} size={22} />
                          <span className={s.grow}>{name}</span>
                          <span className={s.monoXs}>{catalog[name][0]} · + Add</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className={s.optionGrid}>
                  {optionNames.map((name) => {
                    const on = selected.includes(name);
                    const item = found.find((f) => f.name === name);
                    const hint = item
                      ? item.high
                        ? "High confidence"
                        : "Possible"
                      : extra.includes(name)
                        ? "Added by you"
                        : "Not publicly visible";
                    return (
                      <button
                        key={name}
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        className={on ? `${s.option} ${s.optionOn}` : s.option}
                        onClick={() => toggle(name)}
                      >
                        <span className={s.optionBox}>{on ? "✓" : ""}</span>
                        <ProviderMark provider={name} size={22} />
                        <span className={s.rowText}>
                          <span className={s.optionName}>{name}</span>
                          <span className={s.optionHint}>{hint}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className={s.stageFoot}>
                  <span className={s.selSummary}>
                    <strong>{selected.length} selected</strong> · {selectedSources.length} source
                    types to watch
                  </span>
                  <button
                    type="button"
                    className={s.btnInkSm}
                    disabled={selected.length === 0}
                    onClick={() => setStage("coverage")}
                  >
                    See my coverage →
                  </button>
                </div>
              </div>
            ) : null}

            {stage === "coverage" ? (
              <div className={s.stageCol}>
                <div className={s.coverageStats}>
                  <div className={s.statCol}>
                    <span className={s.eyebrowBlue}>YOUR COVERAGE</span>
                    <span className={s.bigNum}>{selected.length}</span>
                    <span className={s.statLabel}>
                      {selected.length === 1 ? "dependency" : "dependencies"}
                    </span>
                  </div>
                  <div className={s.statCol}>
                    <span className={s.bigNum}>{selectedSources.length}</span>
                    <span className={s.statLabel}>source types to watch</span>
                  </div>
                </div>
                <div className={s.coverageGrid}>
                  <div className={s.breakdown}>
                    {breakdown.map((b) => (
                      <div key={b.label} className={s.breakdownRow}>
                        <span>{b.label}</span>
                        <span className={s.meter}>
                          <span style={{ width: `${Math.round((b.n / breakdownMax) * 100)}%` }} />
                        </span>
                        <span className={s.breakdownN}>{b.n}</span>
                      </div>
                    ))}
                  </div>
                  <div className={s.treePreview}>
                    {selected.slice(0, 2).map((name) => {
                      const srcs = sourcesFor(name);
                      return (
                        <div key={name} className={s.treeItem}>
                          <div className={s.treeHead}>
                            <ProviderMark provider={name} size={20} tone="dark" />
                            <span>{name}</span>
                          </div>
                          {srcs.length ? (
                            srcs.map((src, i) => (
                              <span key={src[0]} className={s.treeLine}>
                                <span>{i === srcs.length - 1 ? "└" : "├"}</span> {src[0]}
                              </span>
                            ))
                          ) : (
                            <span className={s.treeLine}>
                              <span>└</span> sources mapped during setup
                            </span>
                          )}
                        </div>
                      );
                    })}
                    {selected.length > 2 ? (
                      <span className={s.treeMore}>
                        + {selected.length - 2} more{" "}
                        {selected.length === 3 ? "dependency" : "dependencies"}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className={s.convertBar}>
                  <span>
                    Create your workspace to confirm the exact sources and start monitoring.
                  </span>
                  <Link
                    className={s.btnBlue}
                    href={`/signup?${continueParams}`}
                    onClick={() => emitPublicConversionEvent("scan_result_continue", attribution())}
                  >
                    Protect these dependencies
                  </Link>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

function IdleDemo({ dt, dPhase }: { dt: number; dPhase: number }) {
  const rows = demoDefs.map(([name, conf, signal], i) => {
    const shown = dt >= i;
    const confirmed = dPhase >= 1 && dt >= 6 + Math.min(i, 2);
    const covered = dPhase === 2 && dt >= 9 + i;
    const [category, sources] = catalog[name];
    return { name, conf, signal, shown, confirmed, covered, category, sources };
  });
  const shownN = Math.min(4, dt + 1);
  const coveredSources = rows.filter((r) => r.covered).reduce((a, r) => a + r.sources.length, 0);
  const title =
    dPhase === 0
      ? `Discovering · ${shownN} likely ${shownN === 1 ? "dependency" : "dependencies"}`
      : dPhase === 1
        ? "Confirm what you rely on"
        : "Coverage";
  const meta =
    dPhase === 0
      ? "public signals only"
      : dPhase === 1
        ? "confirmed by you"
        : `${coveredSources} sources · watching`;
  const foot =
    dPhase === 0
      ? "Reading response headers, page markup and script sources."
      : dPhase === 1
        ? "OpenAI isn't visible publicly. You add what Auterim can't see."
        : "Each dependency expands into the sources Auterim will watch.";
  return (
    <div className={s.stageCol}>
      <div className={s.demoHead}>
        <span className={s.demoTitle}>{title}</span>
        <span className={s.demoMeta}>
          {dPhase === 0 ? <span aria-hidden="true" className={s.liveDot} /> : null}
          {meta}
        </span>
      </div>
      <div className={s.demoRows}>
        {rows.map((r) => (
          <div
            key={r.name}
            className={s.demoRow}
            style={{
              opacity: r.shown ? 1 : 0,
              transform: r.shown ? "none" : "translateY(8px)",
              maxHeight: r.shown ? 160 : 0,
              marginBottom: r.shown ? 8 : 0,
              boxShadow: r.covered
                ? "0 0 0 1.5px rgba(47,91,216,.45)"
                : "0 0 0 1px rgba(14,27,46,.08)",
            }}
          >
            <div className={s.demoRowMain}>
              <ProviderMark provider={r.name} size={30} />
              <div className={s.rowText}>
                <span className={s.rowName}>{r.name}</span>
                <span className={s.rowMeta}>
                  {r.category} · {r.signal}
                </span>
              </div>
              <span
                className={
                  r.confirmed ? s.pillConfirmed : r.conf === "high" ? s.pillHigh : s.pillPossible
                }
              >
                {r.confirmed ? "✓ Confirmed" : r.conf === "high" ? "High confidence" : "Possible"}
              </span>
            </div>
            <div
              className={s.demoSources}
              style={{ maxHeight: r.covered ? 80 : 0, opacity: r.covered ? 1 : 0 }}
            >
              <div className={s.demoSourcesInner}>
                <span className={s.monoBlue}>{r.sources.length} authoritative sources</span>
                <div className={s.chips}>
                  {r.sources.map((src) => (
                    <span key={src[0]} className={s.chip}>
                      {src[0]}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ))}
        {dPhase === 0 && shownN < rows.length ? (
          <div key={shownN} aria-hidden="true" className={s.demoSkeleton}>
            <span />
            <span>
              <span />
              <span />
            </span>
          </div>
        ) : null}
      </div>
      <div className={s.stageFoot}>
        <span className={s.footNote}>{foot}</span>
        <span className={s.monoXsMuted}>Example · enter your website to run it</span>
      </div>
    </div>
  );
}
