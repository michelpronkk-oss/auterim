import Link from "next/link";
import { PLAN_CATALOG } from "@/lib/billing/plan-catalog";
import s from "./home.module.css";

type Plan = {
  name: string;
  price: number;
  line: string;
  features: string[];
  cta: string;
  ctaHref: "/signup";
  note?: string;
  featured?: boolean;
};

const plans: Plan[] = (["core", "pro", "business"] as const).map((slug) => {
  const plan = PLAN_CATALOG[slug];
  return {
    name: plan.name,
    price: plan.priceUsdMonthly,
    line: plan.tagline,
    features: plan.highlights,
    cta: plan.ctaLabel,
    ctaHref: plan.ctaHref,
    note: plan.trialNote,
    featured: slug === "pro",
  };
});

function Check() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" className={s.planCheck}>
      <path
        d="M3 7.4 5.8 10 11 4.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 10 Pricing: launch plans. Every CTA enters the existing signup flow. */
export function PricingSection() {
  return (
    <section id="pricing" className={s.pricingSection} aria-labelledby="pricing-title">
      <div data-reveal className={s.pricingHead}>
        <span className={s.eyebrow}>10 · PRICING</span>
        <h2 id="pricing-title" className={s.h2}>
          Choose your level of protection.
        </h2>
        <p className={s.lede}>
          Every plan monitors what your business depends on. Higher plans verify the impact and
          prepare the fix.
        </p>
      </div>
      <div className={s.planGrid}>
        {plans.map((plan, i) => (
          <article
            key={plan.name}
            data-reveal={String(i)}
            className={plan.featured ? s.planCardPro : s.planCard}
            aria-labelledby={`plan-${plan.name.toLowerCase()}`}
          >
            <div className={s.planTop}>
              <h3 id={`plan-${plan.name.toLowerCase()}`} className={s.planName}>
                {plan.name}
              </h3>
              {plan.featured ? <span className={s.planBadge}>MOST POPULAR</span> : null}
            </div>
            <p className={s.planPrice}>
              <span className={s.planAmount}>${plan.price}</span>
              <span className={s.planPer}>/ month</span>
            </p>
            <p className={s.planLine}>{plan.line}</p>
            <ul className={s.planFeatures}>
              {plan.features.map((f) => (
                <li key={f} className={f.startsWith("Everything in") ? s.planInherit : undefined}>
                  <Check />
                  {f}
                </li>
              ))}
            </ul>
            <Link href={plan.ctaHref} className={plan.featured ? s.planCtaPro : s.planCta}>
              {plan.cta}
            </Link>
            <p className={s.planNote} aria-hidden={plan.note ? undefined : true}>
              {plan.note ?? ""}
            </p>
          </article>
        ))}
      </div>
      <p data-reveal className={s.pricingFoot}>
        All plans start with dependency discovery. A protected product can include its website, app,
        docs, API and associated first-party surfaces.
      </p>
    </section>
  );
}
