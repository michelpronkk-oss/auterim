import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, Mail, type LegalSection } from "@/app/_site/legal";

export const metadata: Metadata = {
  title: { absolute: "Auterim Privacy Policy" },
  description:
    "What information Auterim collects, why it is needed to monitor the services your business depends on, and how it is protected.",
  alternates: { canonical: "/privacy" },
};

const sections: LegalSection[] = [
  {
    id: "scope",
    title: "Who this policy applies to",
    body: (
      <>
        <p>
          This policy explains how Auterim handles information when you visit auterim.com, use the
          free tools, or create and use an Auterim workspace. It applies to account holders, the
          people they invite to a workspace, and visitors to the site.
        </p>
        <p>
          Auterim is a business service. It is built to monitor software, APIs and infrastructure,
          not to profile individuals.
        </p>
      </>
    ),
  },
  {
    id: "you-provide",
    title: "Information you provide",
    body: (
      <>
        <p>
          You give us information when you create an account, set up a workspace, confirm the
          dependencies you rely on, or contact us. We only ask for what the service needs to work.
        </p>
      </>
    ),
  },
  {
    id: "account",
    title: "Account information",
    body: (
      <ul>
        <li>
          Your email address and a password. Passwords are handled by our authentication provider
          and are never stored by Auterim in readable form.
        </li>
        <li>Your role within a workspace, such as owner, admin or member.</li>
      </ul>
    ),
  },
  {
    id: "workspace",
    title: "Company and workspace information",
    body: (
      <ul>
        <li>Your company website address and workspace name.</li>
        <li>
          Optional context you add to help Auterim judge relevance, such as how critical a
          dependency is, which features or endpoints you use, and short notes about your setup.
        </li>
      </ul>
    ),
  },
  {
    id: "dependencies",
    title: "Dependency information",
    body: (
      <p>
        The list of external services your business relies on, whether discovered by Auterim or
        added by you, along with the changes Auterim finds for them, deadlines, and the actions
        taken on each.
      </p>
    ),
  },
  {
    id: "discovery",
    title: "Website discovery",
    body: (
      <>
        <p>
          When you ask Auterim to scan a website, it reads the pages a browser would load from that
          site, such as markup, scripts, headers and linked hosts, to suggest services the site
          appears to use. It does not log in, submit forms or access anything behind authentication.
        </p>
        <p>
          A scan from the free scanner on our site is not saved against your identity. Scans you run
          inside a workspace are saved to that workspace so you can confirm the results.
        </p>
      </>
    ),
  },
  {
    id: "connected",
    title: "Connected service information",
    body: (
      <>
        <p>
          You can choose to connect GitHub, Slack, Linear or Sentry. Each connection asks only for
          the access its feature needs, and you can revoke it at any time.
        </p>
        <ul>
          <li>
            <strong>GitHub.</strong> Read-only access to the contents of the repositories you
            select. Auterim reads a bounded set of files to check whether a change affects your code
            or configuration. It does not keep copies of your source code. It stores the finding
            itself, such as the file path, line, commit and a short explanation, with secret-shaped
            content redacted.
          </li>
          <li>
            <strong>Slack.</strong> Permission to list channels and post the alerts you route there.
          </li>
          <li>
            <strong>Linear.</strong> Permission to read your workspace structure and create issues
            for changes you choose to hand off.
          </li>
          <li>
            <strong>Sentry.</strong> Read access to summaries of unresolved issues in a limited
            number of projects, used as a relevance signal.
          </li>
        </ul>
        <p>Access credentials for connected services are encrypted before they are stored.</p>
      </>
    ),
  },
  {
    id: "usage",
    title: "Usage and operational data",
    body: (
      <>
        <p>
          We keep the operational records needed to run the service, such as monitoring runs, scan
          results, delivery status of alerts, and an audit trail of connector events.
        </p>
        <p>
          On the public site we count a small set of first-party events, such as a page view or a
          started signup, together with the page and any campaign tags in the link. These events are
          not tied to a cookie or an advertising identifier. We do not use third-party analytics or
          advertising trackers.
        </p>
      </>
    ),
  },
  {
    id: "billing",
    title: "Billing information",
    body: (
      <p>
        Paid plans are billed through our payment provider. Auterim shares your email address and
        workspace reference with it to create your subscription. Card details are entered with the
        payment provider and are not received or stored by Auterim. We keep the plan, status and
        billing period of your subscription.
      </p>
    ),
  },
  {
    id: "use",
    title: "How we use information",
    body: (
      <ul>
        <li>To discover and monitor the services you depend on and detect changes to them.</li>
        <li>
          To decide whether a change is material and whether it is relevant to your workspace.
        </li>
        <li>
          To verify impact in connected repositories when you have enabled it, and to prepare
          remediation guidance for review.
        </li>
        <li>To send the alerts and handoffs you have configured.</li>
        <li>To run, secure and support the service, and to bill for it.</li>
      </ul>
    ),
  },
  {
    id: "ai",
    title: "Automated analysis",
    body: (
      <p>
        Auterim uses a language model provider to classify changes and to assess their impact on a
        workspace. Requests contain the change evidence and a bounded, redacted summary of the
        relevant workspace context. They are sent with storage disabled at the provider, and they
        are not used by Auterim to train models. Results are recommendations for people to review.
      </p>
    ),
  },
  {
    id: "security",
    title: "Authentication and security",
    body: (
      <p>
        Every request to your workspace is authorized on the server, and database access is
        restricted per workspace. See the <Link href="/security">Security</Link> page for how
        Auterim protects operational data.
      </p>
    ),
  },
  {
    id: "providers",
    title: "Service providers",
    body: (
      <p>
        We use a small number of providers to host and run Auterim, such as infrastructure,
        database, background processing, language model analysis, email and payments. They process
        information only to provide their service to us. We do not sell personal information.
      </p>
    ),
  },
  {
    id: "retention",
    title: "Data retention",
    body: (
      <p>
        We keep account and workspace information for as long as your account is active and as
        needed to provide the service, meet legal obligations, and resolve disputes. You can ask us
        to delete your account and workspace data by writing to <Mail />.
      </p>
    ),
  },
  {
    id: "rights",
    title: "Your rights",
    body: (
      <p>
        Depending on where you live, you may have the right to access, correct, export or delete
        your personal information, or to object to or restrict how it is used. To make a request,
        write to <Mail /> from the email address on your account. You can also disconnect any
        connected service from your workspace at any time.
      </p>
    ),
  },
  {
    id: "international",
    title: "International processing",
    body: (
      <p>
        Our service providers may process information in countries other than your own. Where that
        happens, we rely on the safeguards those providers offer for international transfers.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: (
      <p>
        We will update this page when our practices change and revise the date at the top. If a
        change is significant, we will tell account owners before it takes effect.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        For privacy questions or requests, write to <Mail />.
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      active="privacy"
      title="Privacy Policy"
      summary="Auterim needs to know what your business runs on to protect it. This is what we collect, why, and how it is kept safe."
      sections={sections}
    />
  );
}
