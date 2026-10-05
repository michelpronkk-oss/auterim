import type { Metadata } from "next";
import Link from "next/link";
import { SiteShell } from "@/app/_site/site-shell";
import s from "./product.module.css";

export const metadata: Metadata = {
  title: { absolute: "Auterim Product — How dependency protection works" },
  description:
    "How Auterim discovers what your business runs on, watches authoritative sources, filters for material change, verifies impact in your code and prepares the fix.",
  alternates: { canonical: "/product" },
};

const steps: Array<[num: string, title: string, body: string]> = [
  ["01", "Discover", "Find the services your business actually runs on."],
  ["02", "Watch", "Read each provider’s own sources, continuously."],
  ["03", "Decide", "Keep only changes that are material and relevant to you."],
  ["04", "Act", "Verify the impact, prepare the fix, hand it to the right place."],
];

type Capability = { title: string; body: string; tag: string };
type Chapter = { key: string; title: string; line: string; items: Capability[] };

const chapters: Chapter[] = [
  {
    key: "DISCOVER",
    title: "Know what you run on.",
    line: "Protection starts with an accurate list, not a guess.",
    items: [
      {
        title: "Dependency discovery",
        body: "Auterim scans your website the way a browser loads it, reading headers, scripts, linked hosts and markup, and suggests the services you appear to use with a confidence level for each. You confirm what is right and add what it cannot see from outside.",
        tag: "ALL PLANS",
      },
      {
        title: "Connectors",
        body: "Connect GitHub to verify impact in code, Slack to receive alerts, Linear to hand off work, and Sentry to add live error context. Each connection asks only for the access its feature needs and can be revoked at any time.",
        tag: "SLACK ON ALL PLANS · OTHERS ON PRO",
      },
    ],
  },
  {
    key: "WATCH",
    title: "Read the source, not the rumor.",
    line: "Every alert traces back to something the provider published.",
    items: [
      {
        title: "Authoritative monitoring",
        body: "For each dependency, Auterim follows the provider’s own changelogs, documentation, pricing, deprecation notices and policies, and checks them on a schedule.",
        tag: "ALL PLANS",
      },
      {
        title: "Change detection",
        body: "When a source changes, Auterim captures exactly what is different and keeps the excerpt as evidence, so every finding can be checked against the original.",
        tag: "ALL PLANS",
      },
    ],
  },
  {
    key: "DECIDE",
    title: "Ignore the noise.",
    line: "Most changes do not matter. Auterim says which ones do.",
    items: [
      {
        title: "Materiality filtering",
        body: "Each change is classified: does it alter behavior, pricing, limits, security, availability or terms, or is it a cosmetic edit? Cosmetic edits and page churn are filtered out before they reach you.",
        tag: "ALL PLANS",
      },
      {
        title: "Customer relevance",
        body: "Material changes are then weighed against your context: how critical the dependency is and which features, endpoints or models you use. A change only becomes an alert when it connects to how you actually use the service, with deadlines and guidance attached.",
        tag: "ALL PLANS",
      },
    ],
  },
  {
    key: "VERIFY",
    title: "Prove what will break.",
    line: "Relevance is a hypothesis. Your code is the answer.",
    items: [
      {
        title: "GitHub Preflight",
        body: "When a relevant change lands, Preflight searches the repositories you connected for the affected APIs, packages and settings, automatically and with read-only access.",
        tag: "PRO",
      },
      {
        title: "Verified code and config impact",
        body: "Matches become findings tied to a file, a line and a commit. You see whether a change really touches your code, not just whether it might.",
        tag: "PRO",
      },
    ],
  },
  {
    key: "ACT",
    title: "Prepare the fix. Route the work.",
    line: "Auterim does the preparation. Your team makes the call.",
    items: [
      {
        title: "Automatic fix preparation",
        body: "Once Preflight verifies exposure, Auterim prepares grounded remediation for that exact finding. On Business, policy can turn it into a draft pull request on a separate branch. Nothing is merged or deployed by Auterim.",
        tag: "PRO · DRAFT PRS ON BUSINESS",
      },
      {
        title: "Actions and handoffs",
        body: "Send alerts to Slack, open Linear issues for the changes that need work, and track each action from open to done inside the workspace.",
        tag: "SLACK ON ALL PLANS · LINEAR ON PRO",
      },
    ],
  },
  {
    key: "PROVE",
    title: "Show your work.",
    line: "A record of what changed and what you did about it.",
    items: [
      {
        title: "Protection history",
        body: "Every change, finding, decision and action stays on a timeline, with upcoming deadlines and protection reports for your team.",
        tag: "ALL PLANS",
      },
    ],
  },
];

const evidence: Array<[key: string, title: string, body: string]> = [
  [
    "GLOBAL",
    "What changed",
    "An excerpt from the provider’s own source, classified for materiality. The same for every customer.",
  ],
  [
    "WORKSPACE",
    "Why it matters to you",
    "The connection between that change and your recorded context. Unknowns stay unknown; Auterim does not fill gaps with guesses.",
  ],
  [
    "VERIFIED",
    "Where it hits",
    "A finding in your repository, bound to a file, a line and a commit. The strongest evidence, and the basis for any fix.",
  ],
];

export default function ProductPage() {
  return (
    <SiteShell
      current="product"
      hero={
        <div className={s.hero}>
          <span className={s.eyebrow}>PRODUCT</span>
          <h1 className={s.h1}>
            How Auterim protects what <span className={s.accent}>you run on.</span>
          </h1>
          <p className={s.lede}>
            From the first scan to a reviewed fix, every step is grounded in evidence you can check.
          </p>
          <div className={s.heroActions}>
            <Link href="/#scan" className={s.btnInk}>
              Scan your company
            </Link>
            <Link href="/#pricing" className={s.btnGhost}>
              See pricing
            </Link>
          </div>
        </div>
      }
    >
      <section id="how-it-works" className={s.how} aria-labelledby="how-title">
        <div className={s.sectionHead}>
          <span className={s.eyebrow}>HOW IT WORKS</span>
          <h2 id="how-title" className={s.h2}>
            Four steps. One quiet loop.
          </h2>
        </div>
        <ol className={s.steps}>
          {steps.map(([num, title, body]) => (
            <li key={num} className={s.step}>
              <span className={s.stepNum}>{num}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <div className={s.chapters}>
        {chapters.map((chapter, i) => (
          <section
            key={chapter.key}
            className={s.chapter}
            aria-labelledby={`chapter-${chapter.key.toLowerCase()}`}
          >
            <div className={s.chapterHead}>
              <span className={s.chapterKey}>
                {String(i + 1).padStart(2, "0")} · {chapter.key}
              </span>
              <h2 id={`chapter-${chapter.key.toLowerCase()}`} className={s.chapterTitle}>
                {chapter.title}
              </h2>
              <p>{chapter.line}</p>
            </div>
            <div className={s.items}>
              {chapter.items.map((item) => (
                <article key={item.title} className={s.item}>
                  <span className={s.itemTag}>{item.tag}</span>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>

      <section className={s.evidence} aria-labelledby="evidence-title">
        <div className={s.evidenceInner}>
          <div className={s.sectionHead}>
            <span className={s.eyebrowDark}>THE EVIDENCE MODEL</span>
            <h2 id="evidence-title" className={s.h2}>
              Every claim has a source.
            </h2>
            <p className={s.ledeDark}>
              Auterim separates what is true for everyone from what is true for you, and what is
              proven in your code. Each layer only builds on the one before it.
            </p>
          </div>
          <ol className={s.layers}>
            {evidence.map(([key, title, body], i) => (
              <li key={key} className={s.layer}>
                <span className={s.layerKey}>
                  {String(i + 1).padStart(2, "0")} · {key}
                </span>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className={s.final} aria-labelledby="final-title">
        <h2 id="final-title" className={s.h2}>
          See what you run on.
        </h2>
        <p className={s.lede}>
          Paste your domain. Confirm what you run on. Auterim watches the rest.
        </p>
        <div className={s.heroActions}>
          <Link href="/#scan" className={s.btnInk}>
            Scan your company
          </Link>
          <Link href="/security" className={s.btnGhost}>
            How we handle your data
          </Link>
        </div>
      </section>
    </SiteShell>
  );
}
