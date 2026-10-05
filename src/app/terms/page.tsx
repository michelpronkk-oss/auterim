import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, Mail, type LegalSection } from "@/app/_site/legal";

export const metadata: Metadata = {
  title: { absolute: "Auterim Terms of Service" },
  description:
    "The terms for using Auterim: accounts, workspaces, plans, the Pro trial, billing, connected services and the limits of what monitoring can promise.",
  alternates: { canonical: "/terms" },
};

const sections: LegalSection[] = [
  {
    id: "acceptance",
    title: "Acceptance",
    body: (
      <p>
        These terms govern your use of Auterim, including the website, the free tools and the
        workspace application. By creating an account or using the service, you agree to them. If
        you use Auterim on behalf of a company, you confirm that you can accept these terms for it.
      </p>
    ),
  },
  {
    id: "accounts",
    title: "Eligibility and accounts",
    body: (
      <p>
        Auterim is intended for businesses and professionals. You need a valid email address to
        create an account. Keep your credentials private; you are responsible for activity under
        your account.
      </p>
    ),
  },
  {
    id: "workspaces",
    title: "Workspaces and authorized users",
    body: (
      <p>
        A workspace belongs to the customer that created it. Owners and admins decide who can access
        it and what each member can do. You are responsible for the people you invite and for
        removing access when it is no longer needed.
      </p>
    ),
  },
  {
    id: "plans",
    title: "Subscription plans",
    body: (
      <>
        <p>
          Auterim is offered on the Core, Pro and Business plans. Each plan includes the features
          and limits described on the <Link href="/#pricing">pricing</Link> section at the time you
          subscribe. Limits include things such as the number of monitored dependencies, connected
          repositories and workspace members.
        </p>
      </>
    ),
  },
  {
    id: "trial",
    title: "Pro trial",
    body: (
      <>
        <p>
          New workspaces can use Pro free for 5 days. The trial starts when protection goes live for
          your workspace, not when you sign up. There is no trial for Core or Business.
        </p>
        <p>
          When the trial ends, Pro features stop unless you choose a paid plan. We may change or end
          the trial offer for future workspaces.
        </p>
      </>
    ),
  },
  {
    id: "billing",
    title: "Billing",
    body: (
      <p>
        Paid plans are billed monthly in advance through our payment provider. Prices are shown
        before you check out. If a payment fails, we may keep your workspace readable for a short
        grace period while pausing work that costs us to run, and then restrict the plan until
        payment succeeds. Taxes may apply depending on your location.
      </p>
    ),
  },
  {
    id: "responsibilities",
    title: "Your responsibilities",
    body: (
      <ul>
        <li>Provide accurate information about your workspace and the services you rely on.</li>
        <li>Only connect accounts, repositories and channels you are authorized to connect.</li>
        <li>Review Auterim’s findings and recommendations before acting on them.</li>
        <li>Keep your own backups, testing and change-management practices in place.</li>
      </ul>
    ),
  },
  {
    id: "connected",
    title: "Connected services",
    body: (
      <p>
        When you connect GitHub, Slack, Linear or Sentry, you authorize Auterim to use that service
        on your behalf within the permissions you grant. Your use of those services stays subject to
        their own terms. You can disconnect them at any time, which stops the features that depend
        on them.
      </p>
    ),
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    body: (
      <>
        <p>You agree not to:</p>
        <ul>
          <li>
            scan websites or systems you are not entitled to analyze, or use Auterim to probe
            private networks;
          </li>
          <li>
            attempt to bypass limits, access other customers’ data, or interfere with the service;
          </li>
          <li>reverse engineer the service, except where the law allows it;</li>
          <li>use Auterim to break the law or anyone else’s rights.</li>
        </ul>
      </>
    ),
  },
  {
    id: "ip",
    title: "Intellectual property",
    body: (
      <p>
        Auterim, including its software, design, provider catalog and analysis, belongs to us and
        our licensors. We grant you a limited right to use the service during your subscription.
        Feedback you choose to share may be used to improve the product.
      </p>
    ),
  },
  {
    id: "customer-data",
    title: "Customer data",
    body: (
      <p>
        You keep ownership of the information you put into Auterim and of the content of your
        connected services. You allow us to process it to provide, secure and support the service,
        as described in the <Link href="/privacy">Privacy Policy</Link>.
      </p>
    ),
  },
  {
    id: "recommendations",
    title: "Product-generated recommendations",
    body: (
      <p>
        Auterim produces classifications, impact assessments, remediation guidance and, on some
        plans, prepared changes for your review. These are recommendations. Auterim does not merge
        code or deploy to your systems. You decide whether and how to act, and you are responsible
        for changes you make.
      </p>
    ),
  },
  {
    id: "detection",
    title: "No guarantee of complete detection",
    body: (
      <p>
        Auterim monitors the sources it can access and reports the changes it can detect and assess.
        It cannot guarantee that it will discover every service you use, detect every change, judge
        every change correctly, or prevent every incident. Treat it as one layer of protection, not
        the only one.
      </p>
    ),
  },
  {
    id: "availability",
    title: "Service availability",
    body: (
      <p>
        We work to keep Auterim available and reliable, but we do not promise uninterrupted service.
        Maintenance, provider outages or changes on monitored sources can delay or interrupt
        monitoring.
      </p>
    ),
  },
  {
    id: "suspension",
    title: "Suspension and termination",
    body: (
      <p>
        We may suspend or end access if you breach these terms, put the service or other customers
        at risk, or fail to pay. Where it is reasonable, we will tell you first and give you a
        chance to fix the problem.
      </p>
    ),
  },
  {
    id: "cancellation",
    title: "Cancellation",
    body: (
      <p>
        A workspace owner or admin can cancel a paid plan from the workspace. Cancellation takes
        effect at the end of the current billing period, and the plan stays active until then.
      </p>
    ),
  },
  {
    id: "disclaimers",
    title: "Disclaimers",
    body: (
      <p>
        Apart from what these terms expressly say, Auterim is provided as is and as available, to
        the extent the law allows. We do not make other promises about fitness for a particular
        purpose or about the accuracy of third-party sources.
      </p>
    ),
  },
  {
    id: "liability",
    title: "Limitation of liability",
    body: (
      <p>
        To the extent the law allows, we are not liable for indirect or consequential losses, such
        as lost profits, revenue or data, and our total liability for any claim is limited to the
        amount you paid for Auterim in the twelve months before the claim. Nothing in these terms
        limits liability that cannot be limited by law.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to the service and these terms",
    body: (
      <p>
        Auterim will evolve, and features may be added, changed or removed. We may update these
        terms; the date at the top shows the latest version. If a change materially affects you, we
        will tell account owners before it takes effect. Continuing to use Auterim after that means
        you accept the updated terms.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        Questions about these terms can go to <Mail />.
      </p>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalPage
      active="terms"
      title="Terms of Service"
      summary="Plain terms for a business service: what Auterim does, what it does not promise, and how plans, the trial and billing work."
      sections={sections}
    />
  );
}
