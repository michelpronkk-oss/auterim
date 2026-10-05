import type { Metadata } from "next";
import { LegalPage, Mail, type LegalSection } from "@/app/_site/legal";
import s from "@/app/_site/legal.module.css";

export const metadata: Metadata = {
  title: { absolute: "Auterim Cookie Policy" },
  description:
    "The few cookies and browser storage entries Auterim uses, what each one is for, and what Auterim does not use.",
  alternates: { canonical: "/cookies" },
};

function StorageTable({ rows }: { rows: Array<[name: string, kind: string, purpose: string]> }) {
  return (
    <table className={s.table}>
      <thead>
        <tr>
          <th scope="col">NAME</th>
          <th scope="col">TYPE</th>
          <th scope="col">PURPOSE</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, kind, purpose]) => (
          <tr key={name}>
            <td>
              <span className={s.tLabel}>NAME</span>
              <code>{name}</code>
            </td>
            <td>
              <span className={s.tLabel}>TYPE</span>
              {kind}
            </td>
            <td>
              <span className={s.tLabel}>PURPOSE</span>
              {purpose}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const sections: LegalSection[] = [
  {
    id: "summary",
    title: "The short version",
    body: (
      <>
        <p>
          Auterim keeps browser storage to the minimum the product needs. There are no advertising
          cookies, no third-party analytics and no cross-site tracking.
        </p>
        <p>
          Because everything listed here is needed for the site or your workspace to work, there is
          no cookie banner to accept.
        </p>
      </>
    ),
  },
  {
    id: "authentication",
    title: "Authentication",
    body: (
      <>
        <p>
          When you sign in, your session is kept in your browser’s local storage, not in a cookie.
          It is used only to prove to Auterim who you are, and it is removed when you sign out.
        </p>
        <StorageTable
          rows={[["sb-…-auth-token", "Local storage", "Keeps you signed in to your workspace."]]}
        />
      </>
    ),
  },
  {
    id: "essential",
    title: "Essential cookies",
    body: (
      <>
        <p>
          Auterim sets a cookie only while you connect Slack, Linear or Sentry. It links the
          connection request to your browser so the authorization cannot be completed by anyone
          else. It is HttpOnly, limited to the connection callback, expires after ten minutes, and
          is deleted as soon as the connection finishes.
        </p>
        <StorageTable
          rows={[
            [
              "auterim_connector_{provider}",
              "Cookie, 10 minutes",
              "Protects the connection flow for Slack, Linear or Sentry.",
            ],
          ]}
        />
      </>
    ),
  },
  {
    id: "preferences",
    title: "Preferences",
    body: (
      <>
        <p>
          Inside the workspace application, two entries in local storage keep things consistent.
        </p>
        <StorageTable
          rows={[
            ["auterim-workspace-id", "Local storage", "Remembers which workspace you had open."],
            [
              "auterim-onboarding-idempotency-key",
              "Local storage",
              "Prevents a workspace from being created twice if setup is retried.",
            ],
          ]}
        />
      </>
    ),
  },
  {
    id: "analytics",
    title: "Analytics",
    body: (
      <p>
        Auterim counts a few first-party events on the public site, such as page views and started
        signups. These counts do not use cookies or local storage, and they are not shared with
        analytics or advertising companies.
      </p>
    ),
  },
  {
    id: "third-party",
    title: "Third-party services",
    body: (
      <p>
        Fonts are served from Auterim’s own domain. When you go to our payment provider to
        subscribe, or to GitHub, Slack, Linear or Sentry to connect an account, those sites set
        their own cookies under their own policies.
      </p>
    ),
  },
  {
    id: "control",
    title: "Your choices",
    body: (
      <p>
        You can clear cookies and local storage in your browser settings at any time. Doing so signs
        you out and resets the workspace you had open.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        Questions about this policy can go to <Mail />.
      </p>
    ),
  },
];

export default function CookiesPage() {
  return (
    <LegalPage
      active="cookies"
      title="Cookie Policy"
      summary="Auterim uses very little browser storage, and only what the product needs to work. Here is every entry and what it does."
      sections={sections}
    />
  );
}
