import Link from "next/link";
import type { ReactNode } from "react";
import { SiteShell } from "./site-shell";
import s from "./legal.module.css";

export type LegalKey = "privacy" | "terms" | "cookies" | "security" | "subprocessors";

const legalNav: Array<[key: LegalKey, label: string, href: string]> = [
  ["privacy", "Privacy", "/privacy"],
  ["terms", "Terms", "/terms"],
  ["cookies", "Cookies", "/cookies"],
  ["security", "Security", "/security"],
  ["subprocessors", "Subprocessors", "/subprocessors"],
];

export type LegalSection = { id: string; title: string; body: ReactNode };

export const SUPPORT_EMAIL = "support@auterim.com";
export const LAST_UPDATED = "October 2026";

export function Mail() {
  return <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;
}

/** Shared layout for the policy and trust pages: hero, policy tabs, section index, numbered clauses. */
export function LegalPage({
  active,
  eyebrow = "LEGAL · TRUST",
  title,
  summary,
  intro,
  sections,
}: {
  active: LegalKey;
  eyebrow?: string;
  title: ReactNode;
  summary: ReactNode;
  intro?: ReactNode;
  sections: LegalSection[];
}) {
  return (
    <SiteShell
      current="legal"
      hero={
        <div className={s.hero}>
          <span className={s.eyebrow}>{eyebrow}</span>
          <h1 className={s.title}>{title}</h1>
          <p className={s.summary}>{summary}</p>
          <p className={s.updated}>
            <span>LAST UPDATED</span>
            <span aria-hidden="true">·</span>
            <time dateTime="2026-10">{LAST_UPDATED}</time>
          </p>
          <nav aria-label="Policies" className={s.tabs}>
            {legalNav.map(([key, label, href]) => (
              <Link
                key={key}
                href={href}
                className={s.tab}
                aria-current={key === active ? "page" : undefined}
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
      }
    >
      {intro ? <div className={s.intro}>{intro}</div> : null}
      <div className={s.body}>
        <aside className={s.index} aria-label="On this page">
          <span className={s.indexHead}>ON THIS PAGE</span>
          <ol>
            {sections.map((section, i) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>
                  <span className={s.indexNum}>{String(i + 1).padStart(2, "0")}</span>
                  {section.title}
                </a>
              </li>
            ))}
          </ol>
        </aside>
        <div className={s.content}>
          {sections.map((section, i) => (
            <section key={section.id} id={section.id} className={s.clause}>
              <span className={s.clauseNum}>{String(i + 1).padStart(2, "0")}</span>
              <h2 className={s.clauseTitle}>{section.title}</h2>
              <div className={s.prose}>{section.body}</div>
            </section>
          ))}
          {sections.some((section) => section.id === "contact") ? null : (
            <p className={s.closing}>
              Questions about this page? Write to <Mail />.
            </p>
          )}
        </div>
      </div>
    </SiteShell>
  );
}
