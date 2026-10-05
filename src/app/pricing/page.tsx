import type { Metadata } from "next";
import Link from "next/link";
import { PublicShell } from "@/app/public-surfaces";
import { PLAN_CATALOG } from "@/lib/billing/plan-catalog";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Compare Auterim Core, Pro, and Business plans for protecting software dependencies.",
  alternates: { canonical: "/pricing" },
};

export default function PricingPage() {
  return (
    <PublicShell current="pricing">
      <section className="public-page-intro">
        <p className="eyebrow">PRICING</p>
        <h1>Protection that grows with your team.</h1>
        <p>
          Start with the dependencies you rely on. Upgrade when you need repository verification and
          deeper action workflows.
        </p>
        <p className="public-microcopy">
          Your 5-day Pro trial starts when protection goes live. Signing up or visiting this page
          does not start the trial.
        </p>
      </section>
      <section className="public-pricing-grid" aria-label="Auterim plans">
        {Object.values(PLAN_CATALOG).map((plan) => (
          <article
            className={`public-plan-card${plan.slug === "pro" ? " featured" : ""}`}
            key={plan.slug}
          >
            {plan.slug === "pro" && <p className="plan-badge">MOST POPULAR</p>}
            <p className="eyebrow">{plan.name.toUpperCase()}</p>
            <h2>
              ${plan.priceUsdMonthly}
              <small> / month</small>
            </h2>
            <p>{plan.tagline}</p>
            <ul>
              {plan.highlights.map((highlight) => (
                <li key={highlight}>{highlight}</li>
              ))}
            </ul>
            <Link
              className={plan.slug === "pro" ? "primary-link" : "button-secondary"}
              href={plan.ctaHref}
            >
              {plan.ctaLabel}
            </Link>
          </article>
        ))}
      </section>
      <p className="pricing-footnote">
        A protected product can include its website, app, docs, API and associated first-party
        surfaces. Plan prices and included product and repository allowances come from Auterim’s
        plan catalog.
      </p>
    </PublicShell>
  );
}
