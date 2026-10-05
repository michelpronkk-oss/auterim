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
  type Plan,
} from "@/app/_site/showcase";
import { SiteShell } from "@/app/_site/site-shell";
import s from "./product.module.css";

export const metadata: Metadata = {
  title: { absolute: "Auterim Product — How dependency protection works" },
  description:
    "What each part of Auterim does: discovery, authoritative monitoring, materiality filtering, verification in your code, fix preparation and protection history.",
  alternates: { canonical: "/product" },
};

export const viewport: Viewport = { themeColor: "#e4ebf9" };

const overview: Array<[num: string, title: string, body: string, href: string]> = [
  [
    "01",
    "Discover",
    "Find the services you run on, from a scan and the tools you connect.",
    "#discover",
  ],
  ["02", "Watch", "Read each provider’s own changelogs, docs, pricing and policies.", "#watch"],
  ["03", "Decide", "Set aside the noise, then match what remains to your context.", "#decide"],
  ["04", "Act", "Verify in your code, prepare a fix for review, hand it to your team.", "#act"],
];

type Confidence = "HIGH" | "MEDIUM" | "POSSIBLE";
const confTone = { HIGH: "soft", MEDIUM: "sand", POSSIBLE: "muted" } as const;

const discovery: Array<[provider: string, category: string, signal: string, conf: Confidence]> = [
  ["Vercel", "Hosting", "x-vercel-id response header", "HIGH"],
  ["Cloudflare", "CDN", "cf-ray response header", "HIGH"],
  ["Stripe", "Payments", "js.stripe.com on /checkout", "HIGH"],
  ["Supabase", "Database", "requests to *.supabase.co", "MEDIUM"],
  ["OpenAI", "AI", "api.openai.com in page config", "POSSIBLE"],
];

const connectors: Array<[provider: string, plan: Plan, scope: string, permission: string]> = [
  ["GitHub", "PRO", "READ-ONLY", "Contents of the repositories you select"],
  ["Slack", "ALL PLANS", "WRITE · ONE CHANNEL", "Post alerts to a channel you choose"],
  ["Linear", "PRO", "WRITE · ONE TEAM", "Create issues in a team you choose"],
  ["Sentry", "PRO", "READ-ONLY", "Projects and issues, for runtime context"],
];

const sources: Array<[name: string, url: string, checked: string]> = [
  ["Changelog", "platform.openai.com/docs/changelog", "2m ago"],
  ["Docs", "platform.openai.com/docs/api-reference", "4m ago"],
  ["Pricing", "openai.com/api/pricing", "6m ago"],
  ["Deprecations", "platform.openai.com/docs/deprecations", "9m ago"],
  ["Policies", "openai.com/policies/usage-policies", "12m ago"],
];

const stream: Array<[provider: string, title: string, source: string, material?: boolean]> = [
  ["Vercel", "Dashboard navigation redesigned", "changelog"],
  ["Stripe", "New payment method available in Japan", "changelog"],
  ["OpenAI", "gpt-4o-2024-05-13 shutdown scheduled", "deprecations", true],
  ["Supabase", "Typo fixes in Auth guides", "docs"],
  ["Resend", "Blog: new template gallery", "blog"],
  ["Cloudflare", "Status page styling update", "status"],
];

const repos: Array<[repo: string, state: "none" | "found" | "busy", label: string]> = [
  ["yourcompany/web", "none", "NO MATCHES"],
  ["yourcompany/api", "found", "2 MATCHES"],
  ["yourcompany/workers", "busy", "SEARCHING"],
];

const layers = [
  {
    key: "GLOBAL",
    title: "What changed",
    body: "An excerpt from the provider’s own source, with where and when it was captured. The same for every customer.",
    example: [
      ["source", "openai.com · deprecations"],
      ["excerpt", "gpt-4o-2024-05-13 · 2026-11-04"],
    ],
  },
  {
    key: "WORKSPACE",
    title: "Why it matters to you",
    body: "Matched against what you told Auterim. Unknowns stay unknown; nothing is guessed to fill a gap.",
    example: [
      ["match", "critical · model in use"],
      ["unknown", "monthly volume"],
    ],
  },
  {
    key: "VERIFIED",
    title: "Where it hits",
    body: "A finding bound to a file, line and commit in your connected code. Present only when it can be shown.",
    example: [
      ["file", "src/lib/llm.ts:42"],
      ["commit", "a3f9c21"],
    ],
  },
];

function Feature({
  title,
  plan,
  body,
  children,
}: {
  title: string;
  plan?: Plan;
  body: string;
  children: ReactNode;
}) {
  return (
    <div className={s.feature} data-reveal>
      <div className={s.featureHead}>
        <h3>{title}</h3>
        {plan ? <PlanTag plan={plan} /> : null}
      </div>
      <p>{body}</p>
      {children}
    </div>
  );
}

function Chapter({
  id,
  num,
  keyName,
  title,
  lede,
  children,
}: {
  id: string;
  num: string;
  keyName: string;
  title: string;
  lede: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={s.chapter} aria-labelledby={`${id}-title`}>
      <div className={s.chapterHead}>
        <span className={x.eyebrow}>
          <span className={x.blueText}>{num}</span>
          {keyName}
        </span>
        <h2 id={`${id}-title`} className={s.chapterTitle}>
          {title}
        </h2>
        <p>{lede}</p>
      </div>
      <div className={s.chapterBody}>{children}</div>
    </section>
  );
}

export default function ProductPage() {
  return (
    <SiteShell
      current="product"
      hero={
        <Hero
          eyebrow="PRODUCT"
          title="How Auterim protects what you run on."
          lede="From finding your dependencies to proving what was handled: what each part of Auterim does, and where it stops."
          secondary={{ href: "/#pricing", label: "See pricing" }}
        />
      }
    >
      <RevealOnScroll />

      <section id="how-it-works" className={s.overview} aria-label="Overview">
        <div className={s.overviewGrid}>
          {overview.map(([num, title, body, href]) => (
            <a key={num} href={href} className={s.overviewCard}>
              <span className={s.overviewNum}>{num}</span>
              <span className={s.overviewTitle}>
                {title}
                <span aria-hidden="true">↓</span>
              </span>
              <span className={s.overviewBody}>{body}</span>
            </a>
          ))}
        </div>
        <Link href="/how-it-works" className={s.walkthrough}>
          Read the full walkthrough on How it works <span aria-hidden="true">→</span>
        </Link>
      </section>

      <Chapter
        id="discover"
        num="01"
        keyName="DISCOVER"
        title="Start from what is already visible."
        lede="Auterim builds your dependency list from what your website shows first, then from the tools you choose to connect. You confirm every entry."
      >
        <Feature
          title="Dependency discovery"
          plan="ALL PLANS"
          body="A scan of your website reads response headers, scripts, linked hosts and pages. Each finding carries the signal it came from and how sure Auterim is."
        >
          <Card>
            <CardHead>
              <span>yourcompany.com · scan complete</span>
              <span className={x.dim}>5 likely dependencies</span>
            </CardHead>
            {discovery.map(([provider, category, signal, conf]) => (
              <div key={provider} className={x.row}>
                <ProviderMark provider={provider} size={30} />
                <span className={x.rowMain}>
                  <span className={x.rowTitle}>
                    {provider} <i>· {category}</i>
                  </span>
                  <span className={x.rowSub}>{signal}</span>
                </span>
                <Badge tone={confTone[conf]}>{conf}</Badge>
              </div>
            ))}
            <CardFoot tint="paper">
              Possible matches stay unconfirmed until you confirm them.
            </CardFoot>
          </Card>
        </Feature>
        <Feature
          title="Connectors"
          body="Connect the tools that see what a scan can’t. Each one asks for the narrowest permission it needs."
        >
          <div className={s.connectors}>
            {connectors.map(([provider, plan, scope, permission]) => (
              <div key={provider} className={s.connector}>
                <div className={s.connectorHead}>
                  <span>
                    <ProviderMark provider={provider} size={30} />
                    {provider}
                  </span>
                  <PlanTag plan={plan} />
                </div>
                <div className={s.connectorScope}>
                  <span>{scope}</span>
                  {permission}
                </div>
              </div>
            ))}
          </div>
        </Feature>
      </Chapter>

      <Chapter
        id="watch"
        num="02"
        keyName="WATCH"
        title="Read the source, not the rumour."
        lede="Each dependency is tied to the pages its provider maintains. Auterim checks them continuously and keeps the exact text that changed."
      >
        <Feature
          title="Authoritative monitoring"
          plan="ALL PLANS"
          body="Every dependency maps to the pages its provider publishes. Auterim reads those, not news, forums or social posts."
        >
          <Card>
            <CardHead tint>
              <ProviderMark provider="OpenAI" size={34} />
              <span className={x.rowMain}>
                <span className={x.rowTitle}>OpenAI</span>
                <span className={x.rowSub}>AI provider · marked critical</span>
              </span>
              <Watching />
            </CardHead>
            {sources.map(([name, url, checked]) => (
              <div key={name} className={x.source}>
                <span>{name}</span>
                <span>{url}</span>
                <span>{checked}</span>
              </div>
            ))}
          </Card>
        </Feature>
        <Feature
          title="Change detection"
          plan="ALL PLANS"
          body="When a page changes, Auterim keeps the exact excerpt that moved, captured from the provider’s own source."
        >
          <Card>
            <CardHead>
              <span>OpenAI · Deprecations</span>
              <span className={x.dim}>captured 5 Oct, 14:02 UTC</span>
            </CardHead>
            <Diff
              table
              lines={[
                { sign: " ", text: "Shutdown date   Model                 Replacement" },
                { sign: "−", text: "TBD             gpt-4o-2024-05-13     TBD" },
                { sign: "+", text: "2026-11-04      gpt-4o-2024-05-13     gpt-4.1" },
                { sign: " ", text: "2026-07-14      gpt-4-0613            gpt-4.1" },
              ]}
            />
            <CardFoot>
              Excerpt from platform.openai.com/docs/deprecations. Nothing paraphrased.
            </CardFoot>
          </Card>
        </Feature>
      </Chapter>

      <Chapter
        id="decide"
        num="03"
        keyName="DECIDE"
        title="Most changes are not your problem."
        lede="Two filters run on every change: is it material at all, and does it touch the way you use this provider."
      >
        <Feature
          title="Materiality filtering"
          plan="ALL PLANS"
          body="Redesigns, marketing posts and typo fixes are read and set aside. Changes to behaviour, price, limits, deadlines or terms move forward."
        >
          <Card>
            <CardHead>
              <span>Today · 24 changes read</span>
              <span className={x.blueText}>1 material</span>
            </CardHead>
            {stream.map(([provider, title, source, material]) => (
              <div key={title} className={`${x.row} ${material ? s.material : s.noise}`}>
                <span className={s.streamMark}>
                  <ProviderMark provider={provider} size={26} />
                </span>
                <span className={x.rowMain}>
                  <span className={material ? x.rowTitle : s.streamTitle}>{title}</span>
                  <span className={x.rowSub}>
                    {provider} · {source}
                  </span>
                </span>
                <Badge tone={material ? "blue" : "muted"}>
                  {material ? "MATERIAL" : "NO IMPACT"}
                </Badge>
              </div>
            ))}
          </Card>
        </Feature>
        <Feature
          title="Customer relevance"
          plan="ALL PLANS"
          body="A material change is matched against what you told Auterim. Where you haven’t said, it says so instead of guessing."
        >
          <Card>
            <CardHead tint>
              <ProviderMark provider="OpenAI" size={30} />
              <span className={x.rowTitle}>gpt-4o-2024-05-13 shutdown scheduled</span>
            </CardHead>
            <MatchRows
              rows={[
                { key: "CRITICALITY", value: "Critical, marked by you", status: "MATCH" },
                { key: "MODEL IN USE", value: "gpt-4o-2024-05-13", status: "MATCH" },
                { key: "ENDPOINT", value: "/v1/chat/completions", status: "MATCH" },
                { key: "DEADLINE", value: "4 Nov 2026 · in 30 days", status: "FROM SOURCE" },
                { key: "MONTHLY VOLUME", value: "Not provided", status: "UNKNOWN" },
              ]}
            />
            <CardFoot tint="blue">
              <span>Relevant to yourcompany.com</span>
              <Badge tone="blue">HIGH URGENCY · 30 DAYS</Badge>
            </CardFoot>
          </Card>
        </Feature>
      </Chapter>

      <Chapter
        id="verify"
        num="04"
        keyName="VERIFY"
        title="Find where it actually lands."
        lede="With GitHub connected, a relevant change is checked against your code. Either it appears, with a location, or it does not."
      >
        <Feature
          title="GitHub Preflight"
          plan="PRO"
          body="For a relevant change, Auterim searches the repositories you connected for the exact identifiers it names: models, endpoints, SDK versions, config keys."
        >
          <Card>
            <CardHead tint>
              <ProviderMark provider="GitHub" size={24} />
              <span className={`${x.rowSub} ${s.search}`}>
                search &quot;gpt-4o-2024-05-13&quot;
              </span>
              <span className={`${x.rowSub} ${s.pushRight}`}>3 repositories</span>
            </CardHead>
            {repos.map(([repo, state, label]) => (
              <div key={repo} className={x.row}>
                <span className={`${x.rowSub} ${s.repo}`}>{repo}</span>
                {state === "busy" ? <span className={x.spinner} aria-hidden="true" /> : null}
                <span className={s.repoState} data-state={state}>
                  {label}
                </span>
              </div>
            ))}
            <CardFoot>Read-only. Code is read in memory and not stored.</CardFoot>
          </Card>
        </Feature>
        <Feature
          title="Verified impact"
          plan="PRO"
          body="A finding is bound to a file, a line and a commit, so anyone can open it and check."
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
                [40, "export async function complete(input) {"],
                [41, "  return client.chat.completions.create({"],
                [42, "    model: 'gpt-4o-2024-05-13',"],
                [43, "    messages: input,"],
                [44, "  });"],
              ]}
            />
            <CardFoot>1 more finding · src/jobs/summarize.ts:18</CardFoot>
          </Card>
        </Feature>
      </Chapter>

      <Chapter
        id="act"
        num="05"
        keyName="ACT"
        title="Prepared for review. Never shipped for you."
        lede="Auterim drafts the fix and routes the work. A person on your team decides what merges and what deploys."
      >
        <Feature
          title="Fix preparation"
          plan="PRO"
          body="A proposed change for that exact finding, grounded in the provider’s own guidance. It waits for a person to review it."
        >
          <Card>
            <CardHead>
              <span className={s.path}>src/lib/llm.ts</span>
              <Badge tone="outline">FOR REVIEW</Badge>
            </CardHead>
            <Diff
              lines={[
                { sign: " ", text: "  return client.chat.completions.create({" },
                { sign: "−", text: "    model: 'gpt-4o-2024-05-13'," },
                { sign: "+", text: "    model: 'gpt-4.1'," },
                { sign: " ", text: "    messages: input," },
              ]}
            />
            <div className={s.grounded}>
              <span>GROUNDED IN</span>
              OpenAI’s deprecation notice names gpt-4.1 as the recommended replacement.
            </div>
            <div className={s.draftRow}>
              <span>Auterim never merges or deploys.</span>
              <span className={s.draftAction}>
                <PlanTag plan="BUSINESS" />
                <span className={s.fakeButton}>Open draft pull request</span>
              </span>
            </div>
          </Card>
        </Feature>
        <Feature
          title="Handoffs"
          body="The change, the evidence and the deadline go where your team already works."
        >
          <div className={x.handoffs}>
            <Card>
              <div className={x.handoffHead}>
                <span>
                  <ProviderMark provider="Slack" size={22} />
                  #eng-alerts
                </span>
                <PlanTag plan="ALL PLANS" />
              </div>
              <SlackAlert
                text="OpenAI shuts down gpt-4o-2024-05-13 on 4 Nov. Verified in 2 files in yourcompany/api. A fix is ready for review."
                action="View change"
              />
            </Card>
            <Card>
              <div className={x.handoffHead}>
                <span>
                  <ProviderMark provider="Linear" size={22} />
                  ENG-128
                </span>
                <PlanTag plan="PRO" />
              </div>
              <div className={x.issue}>
                <span className={x.issueTitle}>Replace gpt-4o-2024-05-13 before 4 Nov</span>
                <FieldRows
                  rows={[
                    ["DUE", "3 Nov 2026"],
                    ["FILES", <code key="f">llm.ts:42, summarize.ts:18</code>],
                    ["SOURCE", "Auterim change #A-2291"],
                  ]}
                />
              </div>
            </Card>
          </div>
        </Feature>
      </Chapter>

      <Chapter
        id="prove"
        num="06"
        keyName="PROVE"
        title="A record of what changed and what you did."
        lede="When someone asks whether you were affected, the answer is already written down, with sources."
      >
        <Feature
          title="Protection history"
          plan="ALL PLANS"
          body="Every change, decision and action is kept with its evidence. Upcoming deadlines stay pinned until someone closes them."
        >
          <Card>
            <div className={s.subHead}>UPCOMING</div>
            <div className={s.upcoming}>
              <span className={s.upDate} data-live="">
                4 Nov 2026
              </span>
              <span className={s.upText}>OpenAI · gpt-4o-2024-05-13 shutdown</span>
              <Badge tone="soft">FIX IN REVIEW</Badge>
            </div>
            <div className={s.upcoming}>
              <span className={s.upDate}>1 Feb 2027</span>
              <span className={s.upText}>Supabase · legacy API keys retired</span>
              <Badge tone="muted">NOT AFFECTED</Badge>
            </div>
            <div className={s.subHead}>HISTORY</div>
            <History
              items={[
                { text: "Linear issue ENG-128 created", when: "5 Oct · 14:10", kind: "auto" },
                { text: "Fix prepared for review", when: "5 Oct · 14:09", kind: "auto" },
                {
                  text: "Verified in 2 files, yourcompany/api",
                  when: "5 Oct · 14:06",
                  kind: "auto",
                },
                { text: "Marked material and relevant", when: "5 Oct · 14:03", kind: "auto" },
                {
                  text: "Change detected · OpenAI Deprecations",
                  when: "5 Oct · 14:02",
                  kind: "auto",
                },
                {
                  text: "Supabase pricing update reviewed · no action",
                  when: "28 Sep",
                  kind: "muted",
                },
                { text: "Stripe API version change resolved", when: "12 Sep", kind: "muted" },
              ]}
            />
          </Card>
        </Feature>
      </Chapter>

      <section className={`${x.band} ${s.evidence}`} aria-labelledby="evidence-title">
        <div className={x.bandInner}>
          <div className={s.evidenceHead}>
            <span className={x.eyebrowDark}>EVIDENCE MODEL</span>
            <h2 id="evidence-title" className={x.bandTitle}>
              Every claim shows its source.
            </h2>
            <p className={x.bandLede}>
              Three layers, each built on the one before. Auterim only says as much as the evidence
              at that layer supports.
            </p>
          </div>
          <ol className={s.layers}>
            {layers.map((layer, i) => (
              <li key={layer.key} className={s.layer} data-verified={i === 2 ? "" : undefined}>
                <div className={s.layerTop}>
                  <span className={s.layerKey}>{layer.key}</span>
                  <span className={s.layerNum}>{i + 1} / 3</span>
                </div>
                <div className={s.layerText}>
                  <h3>{layer.title}</h3>
                  <p>{layer.body}</p>
                </div>
                <div className={s.layerExample}>
                  {layer.example.map(([k, v]) => (
                    <div key={k}>
                      <span>{k}</span> {v}
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <Closing
        title="See what you run on."
        lede="Start with a scan of your website. Confirm what’s right, add what’s missing."
        secondary={{ href: "/security", label: "How Auterim handles your data →" }}
      />
    </SiteShell>
  );
}
