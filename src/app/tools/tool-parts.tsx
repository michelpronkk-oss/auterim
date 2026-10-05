import Link from "next/link";
import type { ReactNode } from "react";
import s from "./tools.module.css";

/** Pieces shared by /tools and the three tool pages. */

export type ToolKey = "scanner" | "coverage" | "deprecation";

export const toolLinks: Record<ToolKey, { href: string; title: string; hint: string }> = {
  scanner: {
    href: "/tools/stack-scanner",
    title: "Stack scanner",
    hint: "What a website likely runs on.",
  },
  coverage: {
    href: "/tools/dependency-exposure",
    title: "Dependency coverage",
    hint: "How closely each service is watched.",
  },
  deprecation: {
    href: "/tools/deprecation-checker",
    title: "Deprecation checker",
    hint: "What's ending, and when.",
  },
};

export function ToolHero({
  tool,
  eyebrow,
  dot = false,
  title,
  lede,
  children,
}: {
  tool?: ToolKey;
  eyebrow: string;
  dot?: boolean;
  title: string;
  lede?: string;
  children?: ReactNode;
}) {
  return (
    <section className={tool ? s.hero : `${s.hero} ${s.heroHub}`}>
      {tool ? (
        <nav aria-label="Breadcrumb" className={s.crumbs}>
          <Link href="/tools">Tools</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{toolLinks[tool].title}</span>
        </nav>
      ) : null}
      <span className={s.pill}>
        {dot ? <i className={s.dot} aria-hidden="true" /> : null}
        {eyebrow}
      </span>
      <h1 className={s.h1}>{title}</h1>
      {lede ? <p className={s.lede}>{lede}</p> : null}
      {children ? <div className={s.heroSlot}>{children}</div> : null}
    </section>
  );
}

export function MoreTools({ current, wide = false }: { current: ToolKey; wide?: boolean }) {
  const others = (Object.keys(toolLinks) as ToolKey[]).filter((key) => key !== current);
  return (
    <section aria-label="More tools" className={wide ? `${s.more} ${s.moreWide}` : s.more}>
      {others.map((key) => (
        <Link key={key} href={toolLinks[key].href} className={s.moreCard}>
          <span className={s.moreText}>
            <span className={s.moreTitle}>{toolLinks[key].title}</span>
            <span className={s.moreHint}>{toolLinks[key].hint}</span>
          </span>
          <span aria-hidden="true" className={s.moreArrow}>
            →
          </span>
        </Link>
      ))}
    </section>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 86_400_000;

function utcDay(time: number) {
  const d = new Date(time);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function formatDate(iso: string) {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function monthDay(iso: string) {
  const d = new Date(iso);
  return { month: MONTHS[d.getUTCMonth()]!.toUpperCase(), day: d.getUTCDate() };
}

/** Whole days from today (UTC) until the date. Negative once it has passed. */
export function daysUntil(iso: string, now = Date.now()) {
  return Math.round((utcDay(new Date(iso).getTime()) - utcDay(now)) / DAY);
}

export function untilLabel(days: number) {
  if (days < 0) return "in effect";
  if (days === 0) return "today";
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

export function verifiedLabel(iso: string, now = Date.now()) {
  const days = Math.max(0, -daysUntil(iso, now));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  return `${weeks} weeks ago`;
}

export function DateChip({ iso, prefix }: { iso: string; prefix?: string }) {
  const days = daysUntil(iso);
  const tone = days >= 0 && days <= 14 ? "soon" : days > 14 && days <= 60 ? "mid" : undefined;
  return (
    <span className={s.chip} data-tone={tone}>
      <span>
        {prefix ? `${prefix} ` : ""}
        {formatDate(iso)}
      </span>
      <span aria-hidden="true" className={s.chipSep}>
        ·
      </span>
      <span>{untilLabel(days)}</span>
    </span>
  );
}

export function EmptyState({
  title,
  text,
  solid = false,
  children,
}: {
  title: string;
  text?: string;
  solid?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={solid ? `${s.empty} ${s.emptySolid}` : s.empty}>
      <span aria-hidden="true" className={s.emptyIcon}>
        <i />
      </span>
      <h2 className={s.emptyTitle}>{title}</h2>
      {text ? <p className={s.emptyText}>{text}</p> : null}
      {children}
    </div>
  );
}

export function Chevron() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14">
      <path
        d="M3 5l4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export { s as tools };
