"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { ProviderMark } from "@/app/_home/marks";
import { emitPublicConversionEvent, readPublicAttribution } from "@/lib/public/conversion";
import {
  canonicalizePublicWebsiteUrl,
  WebsiteUrlInputError,
} from "@/lib/discovery/normalize-website-url";
import { signalTypesLabel } from "../tool-data";
import { ToolHero, tools as s } from "../tool-parts";

type Scan = {
  status: "completed" | "partial" | "failed";
  outcome: "complete" | "partial" | "empty" | "failed";
  candidateCount: number;
  candidates: Array<{
    provider: string;
    confidence: number;
    confidenceLabel: "low" | "medium" | "high";
    evidenceCount: number;
    signalTypes: string[];
  }>;
};

type Phase = "idle" | "scanning" | "done" | "error";

type ScanState = {
  input: string;
  setInput: (value: string) => void;
  phase: Phase;
  step: number;
  domain: string;
  scan: Scan | null;
  message: string;
  submit: (event: React.FormEvent<HTMLFormElement>) => void;
  continueUrl: string;
};

const ScanContext = createContext<ScanState | null>(null);

function useScan() {
  const value = useContext(ScanContext);
  if (!value) throw new Error("useScan must be used inside ScanProvider");
  return value;
}

/** What the scan does, in order. Steps advance on a timer while the request runs. */
const STEPS = [
  "Opening the homepage",
  "Reading response headers",
  "Reading script sources",
  "Checking the security policy",
  "Matching against the catalog",
];
const STEP_MS = 650;

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function ScanProvider({ children }: { children: ReactNode }) {
  const [input, setInputValue] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [step, setStep] = useState(0);
  const [domain, setDomain] = useState("");
  const [scannedUrl, setScannedUrl] = useState("");
  const [scan, setScan] = useState<Scan | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (phase !== "scanning") return;
    const timer = window.setInterval(
      () => setStep((current) => Math.min(current + 1, STEPS.length - 1)),
      STEP_MS,
    );
    return () => window.clearInterval(timer);
  }, [phase]);

  const continueParams = new URLSearchParams({ websiteUrl: scannedUrl || input.trim() });
  const search = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  for (const key of ["utm_source", "utm_medium", "utm_campaign"]) {
    const value = search.get(key);
    if (value && /^[\p{L}\p{N}._ -]{1,100}$/u.test(value)) continueParams.set(key, value);
  }
  const continueUrl = `/signup?${continueParams}`;

  const setInput = (value: string) => {
    setInputValue(value.replace(/^\s*https?:\/\//i, ""));
    if (phase === "error") setPhase(scan ? "done" : "idle");
  };

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase === "scanning") return;
    setMessage("");
    let normalizedUrl: string;
    try {
      normalizedUrl = canonicalizePublicWebsiteUrl(input);
    } catch (error) {
      setScan(null);
      setMessage(
        error instanceof WebsiteUrlInputError
          ? error.message
          : "Enter a website address, like acme.com.",
      );
      setPhase("error");
      return;
    }
    const attribution = readPublicAttribution(
      new URLSearchParams(window.location.search),
      window.location.pathname,
    );
    emitPublicConversionEvent("stack_scan_started", attribution);
    setDomain(hostOf(normalizedUrl));
    setScan(null);
    setScannedUrl("");
    setStep(0);
    setPhase("scanning");
    try {
      const response = await fetch("/api/public/stack-scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ websiteUrl: normalizedUrl }),
      });
      const body = (await response.json()) as Scan & { message?: string };
      if (!response.ok) throw new Error(body.message || "The scan could not be completed safely.");
      setScan(body);
      setScannedUrl(normalizedUrl);
      setPhase("done");
      emitPublicConversionEvent("stack_scan_completed", attribution);
    } catch (error) {
      setMessage(
        error instanceof Error && error.message
          ? error.message
          : `We couldn't reach ${hostOf(normalizedUrl)}. Check the address and try again.`,
      );
      setPhase("error");
    }
  }

  return (
    <ScanContext.Provider
      value={{
        input,
        setInput,
        phase,
        step,
        domain,
        scan,
        message,
        submit: (event) => void submit(event),
        continueUrl,
      }}
    >
      {children}
    </ScanContext.Provider>
  );
}

export function ScanHero() {
  const { input, setInput, phase, message, submit } = useScan();
  const inputId = useId();
  const errorId = useId();
  const noteId = useId();
  const isError = phase === "error";
  return (
    <ToolHero tool="scanner" eyebrow="STACK SCANNER" title="See what a website runs on.">
      <form className={s.form} onSubmit={submit} noValidate>
        <label htmlFor={inputId} className={`${s.label} ${s.formLabel}`}>
          COMPANY WEBSITE
        </label>
        <div className={s.field} data-invalid={isError || undefined}>
          <span aria-hidden="true" className={s.prefix}>
            https://
          </span>
          <input
            id={inputId}
            name="websiteUrl"
            type="text"
            inputMode="url"
            autoComplete="url"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="yourcompany.com"
            className={s.input}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            maxLength={2048}
            aria-invalid={isError || undefined}
            aria-describedby={isError ? `${errorId} ${noteId}` : noteId}
          />
          <button type="submit" className={s.submit} disabled={phase === "scanning"}>
            {phase === "scanning" ? "Scanning…" : "Scan"}
          </button>
        </div>
        {isError ? (
          <p id={errorId} role="alert" className={s.error}>
            <span aria-hidden="true" className={s.errorIcon}>
              !
            </span>
            {message}
          </p>
        ) : null}
        <p id={noteId} className={s.formNote}>
          Fast pass of the homepage only. No sign-in. No private pages.
        </p>
      </form>
    </ToolHero>
  );
}

const reads = [
  {
    title: "Response headers",
    text: "What the server says about itself.",
    example: "x-vercel-id · cf-ray",
  },
  {
    title: "Script sources",
    text: "Where the page loads code from.",
    example: "js.stripe.com",
  },
  {
    title: "Security policy",
    text: "Which services the page is allowed to call.",
    example: "*.supabase.co · api.openai.com",
  },
];

const confidenceLevel = { low: 1, medium: 2, high: 3 } as const;
const confidenceText = { low: "Low", medium: "Medium", high: "High" } as const;

export function ScanResults() {
  const { phase, step, domain, scan, continueUrl } = useScan();

  const showIntro = phase === "idle" || (phase === "error" && !scan);
  const rows = scan?.candidates ?? [];
  const signalTotal = rows.reduce((sum, row) => sum + row.evidenceCount, 0);
  const pct = Math.round((Math.min(step + 0.5, STEPS.length - 0.4) / STEPS.length) * 100);

  return (
    <section aria-live="polite" className={s.body}>
      {showIntro ? (
        <>
          <span className={s.label}>WHAT THE SCAN READS</span>
          <div className={s.reads}>
            {reads.map((read) => (
              <div key={read.title} className={s.read}>
                <span className={s.readTitle}>{read.title}</span>
                <span className={s.readText}>{read.text}</span>
                <span className={s.readEx}>{read.example}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {phase === "scanning" ? (
        <div role="status" aria-label={`Scanning ${domain}`} className={s.card}>
          <div className={s.scanHead}>
            <span className={s.scanDomain}>
              <span className={s.pulse} aria-hidden="true" />
              <span>{domain}</span>
            </span>
            <span className={s.pct} aria-hidden="true">
              {pct}%
            </span>
          </div>
          <div className={s.track} aria-hidden="true">
            <div className={s.fill} style={{ width: `${pct}%` }} />
            <div className={s.sweep} />
          </div>
          <ol className={s.steps}>
            {STEPS.map((label, i) => {
              const state = i < step ? "done" : i === step ? "active" : "pending";
              return (
                <li key={label} className={s.step} data-state={state}>
                  <span aria-hidden="true" className={s.stepIcon} />
                  <span>{label}</span>
                  <span className={s.srOnly}>
                    {state === "done" ? " (done)" : state === "active" ? " (in progress)" : ""}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      {phase !== "scanning" && scan ? (
        <>
          {scan.status === "partial" ? (
            <div role="note" className={s.note}>
              <span aria-hidden="true" className={s.noteMark} />
              <span className={s.noteText}>
                <b>Reached an inspection limit.</b>
                This is what we found before the scan stopped. There may be more.
              </span>
            </div>
          ) : null}
          {scan.status === "failed" ? (
            <div role="note" className={s.note}>
              <span aria-hidden="true" className={s.noteMark} />
              <span className={s.noteText}>
                <b>The page couldn&apos;t be fully inspected.</b>
                Anything listed here is unconfirmed.
              </span>
            </div>
          ) : null}

          {rows.length ? (
            <>
              <div className={s.resultsHead}>
                <h2 className={s.resultsTitle}>
                  {rows.length} likely {rows.length === 1 ? "dependency" : "dependencies"}
                </h2>
                <span className={s.resultsMeta}>
                  {domain} · {signalTotal} signal{signalTotal === 1 ? "" : "s"}
                </span>
              </div>
              <p className={s.resultsNote}>
                <strong>Likely, not confirmed.</strong> Read from signals on the homepage. Auterim
                confirms each one against your code once you connect.
              </p>
              <div className={s.card}>
                <div className={s.tableHead} aria-hidden="true">
                  <span>PROVIDER</span>
                  <span>CONFIDENCE</span>
                  <span>SIGNALS</span>
                  <span>SIGNAL TYPES</span>
                </div>
                <ul className={s.table} aria-label="Likely dependencies">
                  {rows.map((row) => (
                    <li key={row.provider} className={s.row}>
                      <span className={s.rowName}>
                        <ProviderMark provider={row.provider} size={32} />
                        {row.provider}
                      </span>
                      <span className={s.conf}>
                        <span className={s.bars} aria-hidden="true">
                          {[0, 1, 2].map((i) => (
                            <i
                              key={i}
                              data-on={i < confidenceLevel[row.confidenceLabel] || undefined}
                            />
                          ))}
                        </span>
                        {confidenceText[row.confidenceLabel]}
                        <span className={s.srOnly}> confidence</span>
                      </span>
                      <span className={s.rowCount}>
                        {row.evidenceCount}
                        <span className={s.rowCountLabel}>
                          {" "}
                          {row.evidenceCount === 1 ? "signal" : "signals"} ·{" "}
                          {signalTypesLabel(row.signalTypes)}
                        </span>
                      </span>
                      <span className={s.rowTypes} aria-hidden="true">
                        {signalTypesLabel(row.signalTypes)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <div className={`${s.empty} ${s.emptySolid}`}>
              <span aria-hidden="true" className={s.emptyIcon}>
                <i />
              </span>
              <h2 className={s.emptyTitle}>No signals found on {domain}.</h2>
              <p className={s.emptyText}>
                The homepage didn&apos;t show any. Services behind sign-in or on other pages
                won&apos;t appear in a fast pass.
              </p>
            </div>
          )}

          <div className={s.cta}>
            <span className={s.ctaText}>
              <b>Confirm it against your code.</b>
              Auterim checks each one and watches it from here.
            </span>
            <Link
              href={continueUrl}
              className={s.btnCream}
              onClick={() =>
                emitPublicConversionEvent(
                  "scan_result_continue",
                  readPublicAttribution(
                    new URLSearchParams(window.location.search),
                    window.location.pathname,
                  ),
                )
              }
            >
              Continue with this website <span aria-hidden="true">→</span>
            </Link>
          </div>
        </>
      ) : null}
    </section>
  );
}
