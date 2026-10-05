import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, Mail, type LegalSection } from "@/app/_site/legal";
import s from "@/app/_site/legal.module.css";

export const metadata: Metadata = {
  title: { absolute: "Auterim Security" },
  description:
    "How Auterim protects the operational context it works with: workspace isolation, encrypted credentials, read-only repository access and human review.",
  alternates: { canonical: "/security" },
};

const principles: Array<[key: string, title: string, body: string]> = [
  [
    "ISOLATION",
    "Every workspace is walled off",
    "Requests are authorized on the server, and row-level security on every table keeps one workspace’s data out of another’s.",
  ],
  [
    "CREDENTIALS",
    "Secrets are encrypted at rest",
    "Tokens for connected services are encrypted with AES-256-GCM, bound to their workspace, and never shown back to the browser.",
  ],
  [
    "LEAST ACCESS",
    "Read-only by default",
    "GitHub access is read-only and scoped to the repositories you choose. Each connector asks only for the permissions its feature needs.",
  ],
  [
    "BOUNDED",
    "Reads are capped and redacted",
    "Repository checks read a limited set of files in memory. Secret-shaped content is redacted, and source code is not kept.",
  ],
  [
    "CONTAINED",
    "Scans cannot reach inward",
    "Website scanning only talks to public internet addresses. Private networks and internal hosts are refused.",
  ],
  [
    "HUMAN REVIEW",
    "People make the change",
    "Auterim prepares fixes for review. It never merges code and never deploys to your systems.",
  ],
];

const sections: LegalSection[] = [
  {
    id: "isolation",
    title: "Workspace isolation and authorization",
    body: (
      <>
        <p>
          Each request to the workspace application is checked on the server against your signed
          session and your role in that workspace. Sensitive actions, such as changing billing, need
          an owner or admin.
        </p>
        <p>
          The database enforces row-level security on every table, so data is filtered to your
          workspace at the database itself as well as in the application. The most sensitive tables,
          such as stored credentials, cannot be read from the browser at all.
        </p>
      </>
    ),
  },
  {
    id: "credentials",
    title: "Connector credentials",
    body: (
      <ul>
        <li>
          Access tokens for Slack, Linear and Sentry are encrypted with AES-256-GCM before they are
          stored, using versioned keys that can be rotated.
        </li>
        <li>
          Each encrypted token is bound to its workspace and provider, so it cannot be moved to
          another workspace and still decrypt.
        </li>
        <li>
          GitHub uses short-lived installation tokens that are kept in memory only and never written
          to the database.
        </li>
        <li>
          Connection flows use single-use, short-lived state checks to stop someone else from
          completing your authorization.
        </li>
      </ul>
    ),
  },
  {
    id: "repositories",
    title: "Repository access",
    body: (
      <>
        <p>
          The GitHub connection requests read-only access to repository contents, and each token is
          limited to one repository you selected. Auterim confirms that the GitHub account
          installing the app is the one that authorized it.
        </p>
        <p>
          When Auterim checks whether a change affects your code, it reads a bounded number of files
          in memory and skips paths such as environment files, keys and build output. Findings are
          tied to a specific commit. Auterim stores the location and an explanation of a finding,
          not the code around it, and redacts anything that looks like a secret.
        </p>
      </>
    ),
  },
  {
    id: "scanning",
    title: "Website scanning",
    body: (
      <p>
        Scanning only connects to public internet addresses. Requests to private, local or reserved
        networks are refused, redirects are checked at every step, and the browser used for deeper
        discovery cannot make any network request that has not passed the same checks.
      </p>
    ),
  },
  {
    id: "analysis",
    title: "Automated analysis",
    body: (
      <p>
        Change classification and impact assessment use a language model provider. Auterim sends a
        bounded, redacted packet of evidence and workspace context, with storage disabled at the
        provider. Raw repository contents are not sent.
      </p>
    ),
  },
  {
    id: "remediation",
    title: "Remediation stays with people",
    body: (
      <p>
        Auterim prepares remediation guidance and, on plans that include it, draft changes on a
        separate branch for your team to review. It never merges, never deploys, and never changes
        production systems.
      </p>
    ),
  },
  {
    id: "integrity",
    title: "Integrity and audit trail",
    body: (
      <p>
        Webhooks from GitHub and our payment provider are signature-verified before they are
        trusted. Connector events, such as connecting, revoking and delivering alerts, are written
        to an audit trail for the workspace.
      </p>
    ),
  },
  {
    id: "payments",
    title: "Payments",
    body: (
      <p>
        Card details are entered with our payment provider and never reach Auterim. See the{" "}
        <Link href="/subprocessors">Subprocessors</Link> page for the providers that run Auterim.
      </p>
    ),
  },
  {
    id: "certifications",
    title: "Certifications",
    body: (
      <p>
        Auterim does not currently hold third-party security certifications. When that changes, it
        will be listed here.
      </p>
    ),
  },
  {
    id: "disclosure",
    title: "Reporting a vulnerability",
    body: (
      <p>
        If you believe you have found a security issue, please write to <Mail /> with the details
        and steps to reproduce it. Please do not access other customers’ data or disrupt the service
        while testing.
      </p>
    ),
  },
];

export default function SecurityPage() {
  return (
    <LegalPage
      active="security"
      eyebrow="SECURITY · TRUST"
      title={
        <>
          Built to be trusted with <em>operational context.</em>
        </>
      }
      summary="Auterim sees what your business runs on. These are the controls that keep that context contained, minimal and in your hands."
      intro={
        <div className={s.principles}>
          {principles.map(([key, title, body]) => (
            <div key={key} className={s.principle}>
              <span className={s.principleKey}>{key}</span>
              <h2>{title}</h2>
              <p>{body}</p>
            </div>
          ))}
        </div>
      }
      sections={sections}
    />
  );
}
