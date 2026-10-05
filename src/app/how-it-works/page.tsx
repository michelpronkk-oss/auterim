import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ProviderMark } from "@/app/_home/marks";
import { RevealOnScroll } from "@/app/_home/reveal";
import {
  Badge,
  Card,
  CardFoot,
  CardHead,
  Closing,
  Code,
  Diff,
  FieldRows,
  Hero,
  History,
  MatchRows,
  Meta,
  PlanTag,
  SlackAlert,
  Watching,
  showcase as x,
} from "@/app/_site/showcase";
import { SiteShell } from "@/app/_site/site-shell";
import { JourneyProgress } from "./journey-progress";
import s from "./how-it-works.module.css";

export const metadata: Metadata = {
  title: { absolute: "How Auterim works — From a domain to a reviewed fix" },
  description:
    "One company, one provider change, followed the whole way through: discovery, monitoring, filtering, verification in code, a prepared fix and a record of what happened.",
  alternates: { canonical: "/how-it-works" },
};

export const viewport: Viewport = { themeColor: "#e4ebf9" };

const found: Array<[provider: string, category: string, conf: string, confirmed: boolean]> = [
  ["Vercel", "Hosting", "HIGH", true],
  ["Stripe", "Payments", "HIGH", true],
  ["Supabase", "Database", "MEDIUM", true],
  ["Resend", "Email", "MEDIUM", true],
  ["OpenAI", "AI", "ADDED BY YOU", true],
  ["Cloudflare", "CDN", "POSSIBLE", false],
];
const foundTone = {
  HIGH: "soft",
  MEDIUM: "sand",
  POSSIBLE: "muted",
  "ADDED BY YOU": "ink",
} as const;

const sources: Array<[name: string, url: string, checked: string]> = [
  ["Changelog", "platform.openai.com/docs/changelog", "2m ago"],
  ["Docs", "platform.openai.com/docs/api-reference", "4m ago"],
  ["Pricing", "openai.com/api/pricing", "6m ago"],
  ["Deprecations", "platform.openai.com/docs/deprecations", "9m ago"],
  ["Policies", "openai.com/policies", "12m ago"],
];

const you: Array<[task: string, when: string]> = [
  ["Confirm your dependencies", "ONCE"],
  ["Add context for critical ones", "ONCE"],
  ["Review and merge fixes", "WHEN ASKED"],
];
const auterim: Array<[task: string, when: string]> = [
  ["Watch providers’ own sources", "ALWAYS"],
  ["Filter out noise", "ALWAYS"],
  ["Match changes to your context", "ALWAYS"],
  ["Verify in your code", "PRO"],
  ["Prepare fixes for review", "PRO"],
];

const trust: Array<[key: string, value: string]> = [
  ["GITHUB", "Read-only access, only to repositories you select"],
  ["CREDENTIALS", "Encrypted at rest, never shown back to the browser"],
  ["CHANGES TO CODE", "Always a draft for human review. Never merged or deployed by Auterim."],
];

function Stage({
  num,
  title,
  plan,
  body,
  children,
}: {
  num: string;
  title: string;
  plan?: "PRO";
  body: string;
  children: ReactNode;
}) {
  return (
    <li className={s.stage} data-stage={num}>
      <span className={s.dot} aria-hidden="true">
        {num}
      </span>
      <div className={s.stageText} data-reveal>
        <span className={s.stageNum}>STEP {num}</span>
        <div className={s.stageTitleRow}>
          <h2>{title}</h2>
          {plan ? <PlanTag plan={plan} /> : null}
        </div>
        <p>{body}</p>
      </div>
      <div className={s.stageVisual} data-reveal="1">
        {children}
      </div>
    </li>
  );
}

export default function HowItWorksPage() {
  return (
    <SiteShell
      current="how"
      hero={
        <Hero
          eyebrow="HOW IT WORKS"
          title={
            <>
              From a domain to a <em>reviewed fix.</em>
            </>
          }
          lede="One company, one provider change, followed the whole way through. This is what using Auterim looks like."
        />
      }
    >
      <RevealOnScroll />
      <JourneyProgress targetId="journey" />

      <section className={s.journeyWrap} aria-label="Walkthrough">
        <p className={s.exampleNote}>EXAMPLE · YOURCOMPANY.COM</p>
        <div id="journey" className={s.journey}>
          <span className={s.rail} aria-hidden="true">
            <span className={s.railFill} />
          </span>
          <ol className={s.stages}>
            <Stage
              num="01"
              title="Paste your domain."
              body="That is the whole setup. No agent to install, no code to share. Auterim starts from what your website already shows."
            >
              <div className={s.grid}>
                <div className={s.urlBar}>
                  <span className={s.urlScheme}>https://</span>
                  <span className={s.urlHost}>yourcompany.com</span>
                  <span className={s.urlButton}>Analyze</span>
                </div>
              </div>
            </Stage>

            <Stage
              num="02"
              title="Confirm what you run on."
              body="Auterim lists what it found and how sure it is. You confirm what is right, and add what a scan cannot see, like an AI provider called from your backend."
            >
              <Card>
                <CardHead>
                  <span>yourcompany.com</span>
                  <span className={x.dim}>5 confirmed</span>
                </CardHead>
                {found.map(([provider, category, conf, confirmed]) => (
                  <div key={provider} className={x.row}>
                    <span
                      className={s.check}
                      data-on={confirmed ? "" : undefined}
                      aria-hidden="true"
                    >
                      {confirmed ? "✓" : ""}
                    </span>
                    <ProviderMark provider={provider} size={28} />
                    <span className={confirmed ? x.rowTitle : `${x.rowTitle} ${x.dim}`}>
                      {provider} <i>· {category}</i>
                      {confirmed ? null : <span className={x.srOnly}> (not confirmed)</span>}
                    </span>
                    <span className={s.pushRight}>
                      <Badge tone={foundTone[conf as keyof typeof foundTone]}>{conf}</Badge>
                    </span>
                  </div>
                ))}
                <div className={s.addRow}>
                  <span aria-hidden="true">+</span>Add a dependency
                </div>
              </Card>
            </Stage>

            <Stage
              num="03"
              title="Auterim starts watching."
              body="Each provider is tied to the pages it publishes about itself. Those pages are checked continuously. Nothing else is needed from you."
            >
              <Card>
                <CardHead tint>
                  <ProviderMark provider="OpenAI" size={28} />
                  <span className={x.rowTitle}>OpenAI</span>
                  <Watching />
                </CardHead>
                {sources.map(([name, url, checked]) => (
                  <div key={name} className={x.source}>
                    <span>{name}</span>
                    <span>{url}</span>
                    <span>{checked}</span>
                  </div>
                ))}
                <CardFoot tint="paper">
                  <span className={s.others}>
                    <span className={s.stack}>
                      {["Vercel", "Stripe", "Supabase", "Resend"].map((p) => (
                        <ProviderMark key={p} provider={p} size={22} />
                      ))}
                    </span>
                    4 more providers · 19 sources
                  </span>
                </CardFoot>
              </Card>
            </Stage>

            <Stage
              num="04"
              title="A provider changes something."
              body="Weeks later, OpenAI updates its deprecations page. Auterim captures exactly what moved, word for word, and when."
            >
              <Card>
                <CardHead>
                  <span>OpenAI · Deprecations</span>
                  <span className={x.dim}>5 Oct · 14:02 UTC</span>
                </CardHead>
                <Diff
                  table
                  lines={[
                    { sign: " ", text: "Shutdown      Model                Replacement" },
                    { sign: "−", text: "TBD           gpt-4o-2024-05-13    TBD" },
                    { sign: "+", text: "2026-11-04    gpt-4o-2024-05-13    gpt-4.1" },
                  ]}
                />
              </Card>
            </Stage>

            <Stage
              num="05"
              title="Noise is filtered."
              body="That same week, your providers published 148 changes. Most were redesigns, blog posts and copy edits. Two changed something that could affect you."
            >
              <Card>
                <div className={s.stats}>
                  <div>
                    <b>148</b>
                    <span>READ</span>
                  </div>
                  <div data-tone="muted">
                    <b>146</b>
                    <span>FILTERED</span>
                  </div>
                  <div data-tone="blue">
                    <b>2</b>
                    <span>NEED YOU</span>
                  </div>
                </div>
                <div className={s.ratio} aria-hidden="true">
                  <span />
                  <span />
                </div>
                <div className={x.row}>
                  <ProviderMark provider="OpenAI" size={26} />
                  <span className={`${x.rowTitle} ${s.grow}`}>
                    gpt-4o-2024-05-13 shutdown scheduled
                  </span>
                  <Badge tone="blue">MATERIAL</Badge>
                </div>
                <div className={x.row}>
                  <ProviderMark provider="Stripe" size={26} />
                  <span className={`${x.rowTitle} ${s.grow}`}>Webhook retry window shortened</span>
                  <Badge tone="soft">MATERIAL</Badge>
                </div>
              </Card>
            </Stage>

            <Stage
              num="06"
              title="It is matched to you."
              body="You marked OpenAI as critical and named the model you use. Auterim lines the change up against that, and is plain about what it does not know."
            >
              <Card>
                <CardHead tint>
                  <ProviderMark provider="OpenAI" size={26} />
                  <span className={x.rowTitle}>gpt-4o-2024-05-13 shutdown scheduled</span>
                </CardHead>
                <MatchRows
                  rows={[
                    { key: "CRITICALITY", value: "Critical, marked by you", status: "MATCH" },
                    { key: "MODEL IN USE", value: "gpt-4o-2024-05-13", status: "MATCH" },
                    { key: "REPLACEMENT", value: "gpt-4.1, per OpenAI", status: "FROM SOURCE" },
                    { key: "MONTHLY VOLUME", value: "Not provided", status: "UNKNOWN" },
                  ]}
                />
                <CardFoot tint="blue">
                  <span>Deadline · 4 Nov 2026</span>
                  <Badge tone="blue">30 DAYS</Badge>
                </CardFoot>
              </Card>
            </Stage>

            <Stage
              num="07"
              title="Your code is checked."
              plan="PRO"
              body="With GitHub connected read-only, Auterim searches your selected repositories for the model name. It finds it, and points to the exact place."
            >
              <Card>
                <CardHead>
                  <Badge tone="ink">VERIFIED</Badge>
                  <span className={s.path}>yourcompany/api · src/lib/llm.ts</span>
                </CardHead>
                <Meta
                  items={[
                    ["LINE", "42"],
                    ["COMMIT", "a3f9c21"],
                    ["BRANCH", "main"],
                  ]}
                />
                <Code
                  mark={42}
                  lines={[
                    [41, "  return client.chat.completions.create({"],
                    [42, "    model: 'gpt-4o-2024-05-13',"],
                    [43, "    messages: input,"],
                  ]}
                />
              </Card>
            </Stage>

            <Stage
              num="08"
              title="The fix is prepared for review."
              body="Auterim drafts the change the provider’s own notice recommends. On Business, it opens as a draft pull request on its own branch. Auterim never merges or deploys."
            >
              <Card>
                <CardHead>
                  <span className={s.path}>src/lib/llm.ts</span>
                  <Badge tone="outline">FOR REVIEW</Badge>
                </CardHead>
                <Diff
                  lines={[
                    { sign: "−", text: "    model: 'gpt-4o-2024-05-13'," },
                    { sign: "+", text: "    model: 'gpt-4.1'," },
                    { sign: " ", text: "    messages: input," },
                  ]}
                />
                <div className={s.draft}>
                  <span className={s.draftTitle}>
                    <PlanTag plan="BUSINESS" />
                    Draft pull request #214
                  </span>
                  <code>auterim/replace-gpt-4o-2024-05-13 → main</code>
                </div>
              </Card>
            </Stage>

            <Stage
              num="09"
              title="The right people hear about it."
              body="One message in the channel you chose. One issue in the team that owns it, with the evidence and the deadline attached."
            >
              <div className={x.handoffs}>
                <Card>
                  <div className={x.handoffHead}>
                    <span>
                      <ProviderMark provider="Slack" size={22} />
                      #eng-alerts
                    </span>
                  </div>
                  <SlackAlert text="OpenAI shuts down gpt-4o-2024-05-13 on 4 Nov. Found in yourcompany/api. A fix is ready for review." />
                </Card>
                <Card>
                  <div className={x.handoffHead}>
                    <span>
                      <ProviderMark provider="Linear" size={22} />
                      ENG-128
                    </span>
                  </div>
                  <div className={x.issue}>
                    <span className={x.issueTitle}>Replace gpt-4o-2024-05-13 before 4 Nov</span>
                    <FieldRows
                      rows={[
                        ["DUE", "3 Nov 2026"],
                        ["PR", "#214 · draft"],
                      ]}
                    />
                  </div>
                </Card>
              </div>
            </Stage>

            <Stage
              num="10"
              title="It is on the record."
              body="Your engineer reviews and merges the pull request on Thursday. Every step stays in your history, with its source, ready when someone asks."
            >
              <Card>
                <CardHead>
                  <span>Protection history</span>
                  <span className={x.blueText}>RESOLVED</span>
                </CardHead>
                <History
                  items={[
                    {
                      text: "Pull request #214 merged by your team",
                      when: "9 Oct · 11:24",
                      kind: "key",
                    },
                    { text: "Linear issue ENG-128 created", when: "5 Oct · 14:10", kind: "auto" },
                    { text: "Draft pull request #214 opened", when: "5 Oct · 14:09", kind: "auto" },
                    { text: "Verified in yourcompany/api", when: "5 Oct · 14:06", kind: "auto" },
                    {
                      text: "Matched: critical, model in use",
                      when: "5 Oct · 14:03",
                      kind: "auto",
                    },
                    {
                      text: "Change detected · OpenAI Deprecations",
                      when: "5 Oct · 14:02",
                      kind: "auto",
                    },
                    { text: "Watching started · 5 providers", when: "14 Aug", kind: "muted" },
                  ]}
                />
              </Card>
            </Stage>
          </ol>
        </div>
      </section>

      <section className={x.band} aria-labelledby="split-title">
        <div className={`${x.bandInner} ${s.splitInner}`}>
          <div className={s.splitHead}>
            <span className={x.eyebrowDark}>WHO DOES WHAT</span>
            <h2 id="split-title" className={x.bandTitle}>
              You make the decisions. Auterim does the watching.
            </h2>
          </div>
          <div className={s.split}>
            <div className={s.splitCol}>
              <h3>YOU</h3>
              <ul>
                {you.map(([task, when]) => (
                  <li key={task}>
                    <span>{task}</span>
                    <span>{when}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className={`${s.splitCol} ${s.splitAuterim}`}>
              <h3>AUTERIM</h3>
              <ul>
                {auterim.map(([task, when]) => (
                  <li key={task}>
                    <span>{task}</span>
                    <span data-pro={when === "PRO" ? "" : undefined}>{when}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className={s.trustWrap} aria-label="Access and safety">
        <div className={s.trust}>
          {trust.map(([key, value]) => (
            <div key={key} className={s.trustItem}>
              <span>{key}</span>
              {value}
            </div>
          ))}
          <Link href="/security" className={s.trustLink}>
            Read about security <span aria-hidden="true">→</span>
          </Link>
        </div>
      </section>

      <Closing
        title="Start with your domain."
        lede="See what Auterim finds, confirm it, and let it watch from there."
        secondary={{ href: "/#pricing", label: "See pricing", ghost: true }}
      />
    </SiteShell>
  );
}
