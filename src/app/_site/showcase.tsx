import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "@/app/_home/marks";
import s from "./showcase.module.css";

/** Building blocks shared by /product and /how-it-works: hero, product cards, diffs and timelines. */

export type Plan = "ALL PLANS" | "PRO" | "BUSINESS";

export function PlanTag({ plan }: { plan: Plan }) {
  return (
    <span className={s.tag} data-plan={plan}>
      {plan}
    </span>
  );
}

export function Hero({
  eyebrow,
  title,
  lede,
  secondary,
}: {
  eyebrow: string;
  title: ReactNode;
  lede: string;
  secondary?: { href: string; label: string };
}) {
  return (
    <section className={s.hero}>
      <span className={s.eyebrow}>{eyebrow}</span>
      <h1 className={s.h1}>{title}</h1>
      <p className={s.lede}>{lede}</p>
      <div className={s.actions}>
        <Link href="/#scan" className={s.btnInk}>
          Scan your company
        </Link>
        {secondary ? (
          <Link href={secondary.href} className={s.btnGhost}>
            {secondary.label}
          </Link>
        ) : null}
      </div>
    </section>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `${s.card} ${className}` : s.card}>{children}</div>;
}

export function CardHead({ children, tint }: { children: ReactNode; tint?: boolean }) {
  return <div className={tint ? `${s.cardHead} ${s.cardHeadTint}` : s.cardHead}>{children}</div>;
}

export function CardFoot({ children, tint }: { children: ReactNode; tint?: "paper" | "blue" }) {
  return (
    <div className={s.cardFoot} data-tint={tint}>
      {children}
    </div>
  );
}

export function Watching() {
  return (
    <span className={s.watching}>
      <span className={s.liveDot} aria-hidden="true" />
      WATCHING
    </span>
  );
}

export type DiffLine = { sign: " " | "−" | "+"; text: string };

/** `table` keeps column alignment: the diff scrolls sideways on narrow screens instead of wrapping. */
export function Diff({ lines, table = false }: { lines: DiffLine[]; table?: boolean }) {
  return (
    <div
      className={table ? `${s.mono} ${s.table}` : s.mono}
      tabIndex={table ? 0 : undefined}
      role={table ? "region" : undefined}
      aria-label={table ? "Captured excerpt" : undefined}
    >
      {lines.map((line) => (
        <div
          key={line.sign + line.text}
          className={s.diffLine}
          data-kind={line.sign === "+" ? "add" : line.sign === "−" ? "del" : "ctx"}
        >
          <span className={s.diffSign} aria-hidden="true">
            {line.sign}
          </span>
          <span className={s.diffText}>
            {line.sign === "+" ? <span className={s.srOnly}>Added: </span> : null}
            {line.sign === "−" ? <span className={s.srOnly}>Removed: </span> : null}
            {line.text}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Code({ lines, mark }: { lines: Array<[number, string]>; mark: number }) {
  return (
    <div className={`${s.mono} ${s.code}`}>
      {lines.map(([n, text]) => (
        <div key={n} className={s.codeLine} data-mark={n === mark ? "" : undefined}>
          <span className={s.lineNo} aria-hidden="true">
            {n}
          </span>
          <span className={s.diffText}>{text}</span>
        </div>
      ))}
    </div>
  );
}

export function Meta({ items }: { items: Array<[label: string, value: string]> }) {
  return (
    <div className={s.meta}>
      {items.map(([label, value]) => (
        <span key={label}>
          {label} <b>{value}</b>
        </span>
      ))}
    </div>
  );
}

export function Badge({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "blue" | "soft" | "sand" | "ink" | "outline" | "muted";
}) {
  return (
    <span className={s.badge} data-tone={tone}>
      {children}
    </span>
  );
}

export type HistoryItem = { text: string; when: string; kind: "key" | "auto" | "muted" };

export function History({ items }: { items: HistoryItem[] }) {
  return (
    <ol className={s.history}>
      {items.map((item) => (
        <li key={item.text} data-kind={item.kind}>
          <span className={s.historyDot} aria-hidden="true" />
          <span className={s.historyText}>{item.text}</span>
          <span className={s.historyWhen}>{item.when}</span>
        </li>
      ))}
    </ol>
  );
}

export function SlackAlert({ text, action }: { text: string; action?: string }) {
  return (
    <div className={s.slackBody}>
      <span className={s.appIcon}>
        <BrandMark size={17} tone="dark" />
      </span>
      <div className={s.slackText}>
        <span>
          <b>Auterim</b> <span className={s.time}>14:10</span>
        </span>
        <span className={s.slackMsg}>{text}</span>
        {action ? <span className={s.slackBtn}>{action}</span> : null}
      </div>
    </div>
  );
}

export function FieldRows({ rows }: { rows: Array<[label: string, value: ReactNode]> }) {
  return (
    <dl className={s.fields}>
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export type MatchRow = {
  key: string;
  value: string;
  status: "MATCH" | "FROM SOURCE" | "UNKNOWN";
};

export function MatchRows({ rows }: { rows: MatchRow[] }) {
  return (
    <dl className={s.matches}>
      {rows.map((row) => (
        <div key={row.key} data-status={row.status}>
          <dt>{row.key}</dt>
          <dd>{row.value}</dd>
          <dd className={s.matchStatus}>{row.status}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Closing({
  title,
  lede,
  secondary,
}: {
  title: string;
  lede: string;
  secondary: { href: string; label: string; ghost?: boolean };
}) {
  return (
    <section className={s.closing}>
      <h2 className={s.closingTitle}>{title}</h2>
      <p className={s.lede}>{lede}</p>
      <div className={s.actions}>
        <Link href="/#scan" className={s.btnInk}>
          Scan your company
        </Link>
        <Link href={secondary.href} className={secondary.ghost ? s.btnGhost : s.textLink}>
          {secondary.label}
        </Link>
      </div>
    </section>
  );
}

export { s as showcase };
