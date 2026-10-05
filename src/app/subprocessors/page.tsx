import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, Mail, type LegalSection } from "@/app/_site/legal";
import s from "@/app/_site/legal.module.css";

export const metadata: Metadata = {
  title: { absolute: "Auterim Subprocessors" },
  description:
    "The service providers that host and run Auterim, what each one does, and the kind of data it processes.",
  alternates: { canonical: "/subprocessors" },
};

const vendors: Array<{
  name: string;
  kind: string;
  purpose: string;
  data: string;
  site: string;
}> = [
  {
    name: "Vercel",
    kind: "HOSTING",
    purpose: "Hosts the Auterim website and application and serves every request.",
    data: "Request data such as IP address and browser details, and the data passing through each request.",
    site: "https://vercel.com",
  },
  {
    name: "Supabase",
    kind: "DATABASE · AUTH",
    purpose: "Authentication and the primary database for accounts and workspaces.",
    data: "Account email and password hash, workspace settings, dependencies, changes, findings and encrypted connector credentials.",
    site: "https://supabase.com",
  },
  {
    name: "Trigger.dev",
    kind: "BACKGROUND JOBS",
    purpose: "Runs scheduled monitoring, website discovery and analysis jobs.",
    data: "The workspace and dependency data each job needs while it runs.",
    site: "https://trigger.dev",
  },
  {
    name: "OpenAI",
    kind: "ANALYSIS",
    purpose: "Classifies changes and assesses their impact on a workspace.",
    data: "Change evidence and a bounded, redacted summary of workspace context. Sent with storage disabled.",
    site: "https://openai.com",
  },
  {
    name: "Resend",
    kind: "EMAIL",
    purpose: "Delivers alert notification emails.",
    data: "Recipient email address, alert title and a short summary.",
    site: "https://resend.com",
  },
  {
    name: "Dodo Payments",
    kind: "BILLING",
    purpose: "Subscription checkout, payments and the billing portal.",
    data: "Account email, workspace reference, plan, and the payment details you enter with them.",
    site: "https://dodopayments.com",
  },
];

function Vendors() {
  return (
    <div className={s.vendors} role="table" aria-label="Auterim subprocessors">
      <div className={s.vendorHead} role="row">
        <span role="columnheader">PROVIDER</span>
        <span role="columnheader">PURPOSE</span>
        <span role="columnheader">DATA PROCESSED</span>
        <span role="columnheader">
          <span className={s.srOnly}>Website</span>
        </span>
      </div>
      {vendors.map((v) => (
        <div key={v.name} className={s.vendor} role="row">
          <div className={s.vendorName} role="cell">
            <strong>{v.name}</strong>
            <span>{v.kind}</span>
          </div>
          <div role="cell">
            <span className={s.cellLabel}>PURPOSE</span>
            {v.purpose}
          </div>
          <div role="cell">
            <span className={s.cellLabel}>DATA PROCESSED</span>
            {v.data}
          </div>
          <div role="cell">
            <a className={s.vendorLink} href={v.site} target="_blank" rel="noopener noreferrer">
              {v.site.replace("https://", "")} ↗
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}

const sections: LegalSection[] = [
  {
    id: "about",
    title: "About this list",
    body: (
      <p>
        These are the providers Auterim relies on to host and run the service and that may process
        customer data on our behalf. Each processes data only to provide its service to us. How
        Auterim handles information overall is described in the{" "}
        <Link href="/privacy">Privacy Policy</Link>.
      </p>
    ),
  },
  {
    id: "connected",
    title: "Services you connect",
    body: (
      <p>
        GitHub, Slack, Linear and Sentry are not on this list. They are services you choose to
        connect to your workspace, under your own account with them. Auterim uses them only within
        the permissions you grant, and you can disconnect them at any time.
      </p>
    ),
  },
  {
    id: "monitored",
    title: "Providers Auterim monitors",
    body: (
      <p>
        Auterim watches the public changelogs, documentation, pricing and policies of many software
        providers. Monitoring a provider does not make it a subprocessor; no customer data is shared
        with the services Auterim watches.
      </p>
    ),
  },
  {
    id: "updates",
    title: "Changes to this list",
    body: (
      <p>We update this page when we add or replace a provider, and change the date at the top.</p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        Questions about our providers can go to <Mail />.
      </p>
    ),
  },
];

export default function SubprocessorsPage() {
  return (
    <LegalPage
      active="subprocessors"
      title="Subprocessors"
      summary="The short list of providers that host and run Auterim, what each one does, and what it sees."
      intro={<Vendors />}
      sections={sections}
    />
  );
}
