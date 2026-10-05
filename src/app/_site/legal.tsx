import Link from "next/link";
import type { ReactNode } from "react";
import { SiteShell } from "./site-shell";
import s from "./legal.module.css";

export type LegalKey = "privacy" | "terms" | "cookies" | "security";

const legalNav: Array<{ key: LegalKey; label: string; href: string; hint: string; icon: string }> =
  [
    {
      key: "privacy",
      label: "Privacy Policy",
      href: "/privacy",
      hint: "What personal data is collected, and why.",
      icon: "M10 2.5 3.5 5v4.6c0 4 2.8 6.9 6.5 7.9 3.7-1 6.5-3.9 6.5-7.9V5L10 2.5Z",
    },
    {
      key: "terms",
      label: "Terms of Service",
      href: "/terms",
      hint: "The agreement for using Auterim.",
      icon: "M5.5 2.5h6l3 3v12h-9v-15ZM11.5 2.5v3h3M8 9.5h4.5M8 12.5h4.5",
    },
    {
      key: "cookies",
      label: "Cookie Policy",
      href: "/cookies",
      hint: "Every browser storage entry, explained.",
      icon: "M17 10.5A7 7 0 1 1 9.5 3a3 3 0 0 0 3.5 3.5 3 3 0 0 0 4 4ZM7.5 9.5h.01M11 13h.01M7.5 14h.01",
    },
    {
      key: "security",
      label: "Security",
      href: "/security",
      hint: "How your data and code are protected.",
      icon: "M5.5 9V6.5a4.5 4.5 0 0 1 9 0V9M4.5 9h11v8.5h-11V9ZM10 12.5v2",
    },
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
      <MorePolicies active={active} />
    </SiteShell>
  );
}

/** Closes every policy page with the other policies, so moving between them never needs a tab bar. */
function MorePolicies({ active }: { active: LegalKey }) {
  return (
    <nav aria-label="More policies" className={s.more}>
      <span className={s.moreHead}>MORE POLICIES</span>
      <ul className={s.moreList}>
        {legalNav
          .filter((item) => item.key !== active)
          .map((item) => (
            <li key={item.key}>
              <Link href={item.href} className={s.moreCard}>
                <span className={s.moreIcon} aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 20 20">
                    <path
                      d={item.icon}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <span className={s.moreText}>
                  <span className={s.moreTitle}>{item.label}</span>
                  <span className={s.moreHint}>{item.hint}</span>
                </span>
                <span className={s.moreArrow} aria-hidden="true">
                  →
                </span>
              </Link>
            </li>
          ))}
      </ul>
    </nav>
  );
}
