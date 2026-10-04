"use client";

import { useState } from "react";
import Link from "next/link";
import { emitPublicConversionEvent, readPublicAttribution } from "@/lib/public/conversion";
import {
  canonicalizePublicWebsiteUrl,
  WebsiteUrlInputError,
} from "@/lib/discovery/normalize-website-url";

type Scan = {
  status: "completed" | "failed";
  candidateCount: number;
  candidates: Array<{
    provider: string;
    confidence: number;
    confidenceLabel: "low" | "medium" | "high";
    evidenceCount: number;
    signalTypes: string[];
  }>;
};

export function StackScanner() {
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [scannedWebsiteUrl, setScannedWebsiteUrl] = useState("");
  const [scan, setScan] = useState<Scan | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setScan(null);
    setScannedWebsiteUrl("");
    const search = new URLSearchParams(window.location.search);
    const attribution = readPublicAttribution(search, window.location.pathname);
    emitPublicConversionEvent("stack_scan_started", attribution);
    try {
      const normalizedUrl = canonicalizePublicWebsiteUrl(websiteUrl);
      const response = await fetch("/api/public/stack-scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ websiteUrl: normalizedUrl }),
      });
      const body = (await response.json()) as Scan & { message?: string };
      if (!response.ok) throw new Error(body.message || "The scan could not be completed safely.");
      setScan(body);
      setScannedWebsiteUrl(normalizedUrl);
      emitPublicConversionEvent("stack_scan_completed", attribution);
    } catch (error) {
      setMessage(
        error instanceof WebsiteUrlInputError
          ? error.message
          : error instanceof Error
            ? error.message
            : "The scan could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  const continueParams = new URLSearchParams({
    websiteUrl: scannedWebsiteUrl || websiteUrl.trim(),
  });
  for (const key of ["utm_source", "utm_medium", "utm_campaign"]) {
    const value = new URLSearchParams(
      typeof window === "undefined" ? "" : window.location.search,
    ).get(key);
    if (value && /^[\p{L}\p{N}._ -]{1,100}$/u.test(value)) continueParams.set(key, value);
  }
  const continueUrl = `/signup?${continueParams}`;
  return (
    <div className="scanner-panel">
      <form className="scanner-form" onSubmit={submit} noValidate>
        <label htmlFor="websiteUrl">Company website</label>
        <div className="scanner-input-row">
          <input
            id="websiteUrl"
            name="websiteUrl"
            type="text"
            inputMode="url"
            autoComplete="url"
            placeholder="example.com"
            value={websiteUrl}
            onChange={(event) => {
              setWebsiteUrl(event.target.value);
              setScan(null);
              setScannedWebsiteUrl("");
            }}
            maxLength={2048}
          />
          <button className="primary-link scanner-submit" disabled={busy}>
            {busy ? "Checking…" : "Scan public signals"} <span aria-hidden="true">→</span>
          </button>
        </div>
        <p className="scanner-note">
          Fast pass only. We check public page metadata and linked resources; we do not sign in,
          crawl private pages, or claim a complete stack.
        </p>
      </form>
      {message && (
        <p className="public-alert" role="status">
          {message}
        </p>
      )}
      {scan && (
        <section className="scan-results" aria-live="polite" aria-labelledby="scan-results-title">
          <div className="public-section-heading">
            <div>
              <p className="eyebrow">PUBLIC SIGNALS FOUND</p>
              <h2 id="scan-results-title">{scan.candidateCount} likely dependencies</h2>
              <p>
                Signals are suggestions based on visible technical markers, not confirmation that
                your company uses a service.
              </p>
            </div>
          </div>
          {scan.candidates.length ? (
            <ul className="scan-candidate-list">
              {scan.candidates.map((candidate) => (
                <li key={candidate.provider}>
                  <span className="provider-monogram">{candidate.provider.slice(0, 1)}</span>
                  <span>
                    <strong>{candidate.provider}</strong>
                    <small>
                      {candidate.evidenceCount} public signal
                      {candidate.evidenceCount === 1 ? "" : "s"} ·{" "}
                      {candidate.signalTypes.join(", ")}
                    </small>
                  </span>
                  <span className={`confidence confidence-${candidate.confidenceLabel}`}>
                    {candidate.confidenceLabel} confidence
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="public-empty">
              No registered provider markers were found on this public page. That does not mean the
              company has no dependencies.
            </p>
          )}
          <Link
            className="primary-link"
            href={continueUrl}
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
        </section>
      )}
    </div>
  );
}
