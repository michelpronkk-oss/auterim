import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { BrandMark, ProviderMark } from "@/app/_home/marks";
import { SUPPORT_EMAIL } from "@/app/_site/legal";
import { SiteShell } from "@/app/_site/site-shell";
import { DetailIndex } from "./detail-index";
import s from "./security.module.css";

export const metadata: Metadata = {
  title: { absolute: "Auterim Security" },
  description:
    "What Auterim reads, what it keeps, what it refuses to keep, and where it stops: workspace isolation, encrypted credentials, read-only repository access and human review.",
  alternates: { canonical: "/security" },
};

export const viewport: Viewport = { themeColor: "#e4ebf9" };

type Input = {
  name: string;
  provider?: string;
  direction: "in" | "out";
  access: string;
  tone: "muted" | "blue" | "ink";
};

const inputs: Input[] = [
  { name: "Your website", direction: "in", access: "VISITOR VIEW ONLY", tone: "muted" },
  {
    name: "GitHub repositories",
    provider: "GitHub",
    direction: "in",
    access: "READ-ONLY · SELECTED REPOS",
    tone: "blue",
  },
  {
    name: "Sentry",
    provider: "Sentry",
    direction: "in",
    access: "CONNECTED BY YOU",
    tone: "muted",
  },
  { name: "Slack", provider: "Slack", direction: "out", access: "POST ALERTS ONLY", tone: "ink" },
  { name: "Linear", provider: "Linear", direction: "out", access: "CREATE ISSUES", tone: "ink" },
];

const stored: Array<[title: string, detail?: string]> = [
  ["Confirmed dependencies"],
  ["Detected changes"],
  ["Findings", "File path, line, commit and explanation"],
  ["Connector credentials", "Encrypted"],
  ["Audit trail", "Connector events"],
];

const neverStored: Array<[title: string, detail: string]> = [
  ["Your source code", "Read in memory, then discarded"],
  ["GitHub tokens", "Held in memory only"],
  ["Card details", "Sent to the payment provider only"],
];

const principles: Array<[key: string, title: string, body: string]> = [
  [
    "ISOLATION",
    "Every request checked, every table guarded.",
    "Server-side authorization on every request, plus row-level security on every table.",
  ],
  [
    "CREDENTIALS",
    "Encrypted, bound, rotatable.",
    "AES-256-GCM encryption, bound to the workspace and provider it belongs to. Keys can be rotated.",
  ],
  [
    "LEAST ACCESS",
    "Read-only, by your selection.",
    "GitHub access is read-only and scoped to the repositories you choose.",
  ],
  [
    "BOUNDED",
    "Read what is needed, keep none of it.",
    "Capped reads held in memory. Secret-shaped content is redacted. Code is not kept.",
  ],
  [
    "CONTAINED",
    "Scans stay outside your network.",
    "Private and internal networks are refused, and the discovery browser cannot make an unchecked request.",
  ],
  [
    "HUMAN REVIEW",
    "Prepared, never shipped.",
    "Auterim prepares fixes for your team. It never merges and never deploys.",
  ],
];

const details: Array<{ id: string; title: string; body: string[]; report?: boolean }> = [
  {
    id: "isolation",
    title: "Workspace isolation",
    body: [
      "Every request is authorized on the server against the workspace it belongs to and your role in it. Nothing relies on the browser to decide what you can see.",
      "Underneath that, row-level security is enabled on every table, so a query can only return rows for its own workspace even if an application check were missed.",
    ],
  },
  {
    id: "credentials",
    title: "Connector credentials",
    body: [
      "Credentials for Slack, Linear and Sentry are encrypted with AES-256-GCM before they are stored. Each one is bound to its workspace and its provider, so it cannot be decrypted in another context.",
      "Encryption keys are versioned and can be rotated. Stored credentials are never sent back to the browser.",
    ],
  },
  {
    id: "repository",
    title: "Repository access",
    body: [
      "GitHub access is read-only and limited to the repositories you choose when you connect.",
      "GitHub tokens are short-lived, held in memory for the duration of a check, and never written to storage.",
    ],
  },
  {
    id: "scanning",
    title: "Website scanning",
    body: [
      "Discovery reads your website the way a visitor would. Requests to private, local or reserved networks are refused, and redirects are checked at every step.",
      "The browser used for discovery runs contained: every request it makes is checked before it leaves, and anything that fails the check is blocked.",
    ],
  },
  {
    id: "analysis",
    title: "Automated analysis",
    body: [
      "Some steps use a language model provider. It receives a bounded packet of change evidence and workspace context, with secret-shaped content redacted, sent with storage disabled.",
      "Raw repository contents are never sent. Reads from your code are capped, held in memory, and discarded once the finding is recorded.",
    ],
  },
  {
    id: "integrity",
    title: "Integrity",
    body: [
      "Incoming webhooks from GitHub and the payment provider are verified by signature before they are processed. Unsigned or mismatched requests are rejected.",
      "Connector activity, such as connecting, revoking and delivering alerts, is recorded in an audit trail for the workspace.",
    ],
  },
  {
    id: "payments",
    title: "Payments",
    body: [
      "Card details go directly to the payment provider. They never pass through or rest on Auterim systems.",
    ],
  },
  {
    id: "certifications",
    title: "Certifications",
    body: [
      "Auterim does not currently hold third-party security certifications. When that changes, it will be listed here.",
    ],
  },
  {
    id: "report",
    title: "Reporting a vulnerability",
    body: [
      "If you believe you have found a security issue, email the details and steps to reproduce it. Please do not access other customers’ data or disrupt the service while testing.",
    ],
    report: true,
  },
];

function Connector({ dark = false }: { dark?: boolean }) {
  return <span aria-hidden="true" className={dark ? `${s.wire} ${s.wireDark}` : s.wire} />;
}

export default function SecurityPage() {
  return (
    <SiteShell
      current="legal"
      hero={
        <section className={s.hero}>
          <span className={s.eyebrow}>SECURITY · TRUST</span>
          <h1 className={s.h1}>Built to be trusted with operational context.</h1>
          <p className={s.lede}>
            What Auterim reads, what it keeps, what it refuses to keep, and where it stops.
          </p>
          <a href="#details" className={s.heroLink}>
            Read the details <span aria-hidden="true">↓</span>
          </a>
        </section>
      }
    >
      <section className={s.section} aria-labelledby="flow-title">
        <div className={s.sectionHead}>
          <h2 id="flow-title" className={s.h2}>
            What Auterim touches, and what it never keeps.
          </h2>
          <p className={s.sectionNote}>
            Every connection has one direction and one level of access.
          </p>
        </div>

        <div className={s.board}>
          <div className={s.flow}>
            <div className={s.side}>
              <span className={s.label}>YOUR SIDE</span>
              <ul className={s.inputs}>
                {inputs.map((input) => (
                  <li key={input.name} className={s.input}>
                    {input.provider ? (
                      <ProviderMark provider={input.provider} size={30} />
                    ) : (
                      <span className={s.siteMark} aria-hidden="true">
                        www
                      </span>
                    )}
                    <span className={s.inputText}>
                      <span className={s.inputName}>{input.name}</span>
                      <span className={s.access} data-tone={input.tone}>
                        <span aria-hidden="true">{input.direction === "in" ? "→" : "←"}</span>{" "}
                        <span className={s.srOnly}>
                          {input.direction === "in" ? "Auterim reads:" : "Auterim writes:"}
                        </span>
                        {input.access}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <Connector />

            <div className={s.coreWrap}>
              <div className={s.core}>
                <span className={s.coreMark}>
                  <span className={s.pulse} aria-hidden="true" />
                  <BrandMark size={30} tone="dark" />
                </span>
                <span className={s.coreName}>Auterim</span>
                <span className={s.coreRules}>
                  <span>→ READS IN</span>
                  <span>← WRITES OUT</span>
                  <span>NOTHING ELSE</span>
                </span>
              </div>
            </div>

            <Connector />

            <div className={s.ledgers}>
              <div className={s.ledger}>
                <div className={s.ledgerHead}>
                  <span>STORED</span>
                  <span className={s.ledgerMeta}>per workspace</span>
                </div>
                <ul>
                  {stored.map(([title, detail]) => (
                    <li key={title}>
                      <span className={s.dot} aria-hidden="true" />
                      <span className={s.ledgerText}>
                        <span className={s.ledgerTitle}>{title}</span>
                        {detail ? <span className={s.ledgerDetail}>{detail}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className={`${s.ledger} ${s.ledgerNever}`}>
                <div className={s.ledgerHead}>
                  <span>NEVER STORED</span>
                </div>
                <ul>
                  {neverStored.map(([title, detail]) => (
                    <li key={title}>
                      <span className={s.dash} aria-hidden="true" />
                      <span className={s.ledgerText}>
                        <span className={s.ledgerTitle}>{title}</span>
                        <span className={s.ledgerDetail}>{detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={s.section} aria-label="Security principles">
        <ul className={s.principles}>
          {principles.map(([key, title, body], i) => (
            <li key={key} className={s.principle}>
              <span className={s.principleKey}>
                {String(i + 1).padStart(2, "0")} · {key}
              </span>
              <h3>{title}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className={s.review} aria-labelledby="review-title">
        <div className={s.reviewInner}>
          <div className={s.reviewHead}>
            <span className={s.eyebrowDark}>HUMAN REVIEW</span>
            <h2 id="review-title" className={s.h2}>
              Remediation stays with people.
            </h2>
            <p className={s.reviewLede}>
              Auterim can prepare a fix. Everything after that is a decision your team makes.
            </p>
          </div>
          <ol className={s.handoff}>
            <li className={`${s.stage} ${s.stageAuterim}`}>
              <span className={s.stageKey}>01 · AUTERIM</span>
              <h3>Prepared</h3>
              <p>
                A proposed change, with the evidence behind it. On plans that include it, a draft
                change on its own branch.
              </p>
            </li>
            <li className={s.boundary}>
              <Connector dark />
              <span className={s.boundaryLabel}>AUTERIM STOPS HERE</span>
              <Connector dark />
            </li>
            <li className={s.stage}>
              <span className={s.stageKey}>02 · YOUR TEAM</span>
              <h3>Under review</h3>
              <p>An engineer reads it, changes it, or closes it. Nothing moves without them.</p>
            </li>
            <li className={s.stage}>
              <span className={s.stageKey}>03 · YOU</span>
              <h3>Merged by you</h3>
              <p>
                You merge and deploy through your own process. Auterim never merges and never
                deploys.
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section id="details" className={s.details} aria-label="Security details">
        <DetailIndex items={details.map(({ id, title }) => ({ id, title }))} />
        <div className={s.articles}>
          {details.map((detail, i) => (
            <article key={detail.id} id={detail.id} data-detail={detail.id} className={s.article}>
              <span className={s.articleNum}>{String(i + 1).padStart(2, "0")}</span>
              <h2 className={s.articleTitle}>{detail.title}</h2>
              {detail.body.map((paragraph) => (
                <p key={paragraph.slice(0, 32)}>{paragraph}</p>
              ))}
              {detail.report ? (
                <a href={`mailto:${SUPPORT_EMAIL}`} className={s.mailChip}>
                  {SUPPORT_EMAIL}
                </a>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className={s.section} aria-label="Related pages">
        <div className={s.related}>
          <Link href="/terms" className={s.relatedCard}>
            <span className={s.relatedText}>
              <span className={s.relatedTitle}>Terms</span>
              <span className={s.relatedBody}>The agreement for using Auterim.</span>
            </span>
            <span className={s.relatedArrow} aria-hidden="true">
              →
            </span>
          </Link>
          <Link href="/privacy" className={s.relatedCard}>
            <span className={s.relatedText}>
              <span className={s.relatedTitle}>Privacy</span>
              <span className={s.relatedBody}>What personal data is collected, and why.</span>
            </span>
            <span className={s.relatedArrow} aria-hidden="true">
              →
            </span>
          </Link>
        </div>
      </section>
    </SiteShell>
  );
}
