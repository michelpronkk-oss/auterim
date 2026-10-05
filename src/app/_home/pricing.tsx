import Link from "next/link";
import s from "./home.module.css";

type Plan = {
  name: string;
  price: number;
  line: string;
  features: string[];
  cta: string;
  note?: string;
  featured?: boolean;
};

const plans: Plan[] = [
  {
    name: "Core",
    price: 29,
    line: "Tell me what matters.",
    features: [
      "External dependency monitoring",
      "Material-change filtering",
      "Customer-specific impact",
      "Deadlines & guidance",
      "Protection reporting",
    ],
    cta: "Start protecting",
  },
  {
    name: "Pro",
    price: 79,
    line: "Prove what will break.",
    features: [
      "Everything in Core",
      "GitHub connection",
      "Automatic Preflight",
      "Verified code & config impact",
      "Manual Generate Fix",
      "Higher protection limits",
    ],
    cta: "Start 5-day Pro trial",
    note: "Your 5-day Pro trial starts when protection goes live.",
    featured: true,
  },
  {
    name: "Business",
    price: 199,
    line: "Prepare prevention automatically.",
    features: [
      "Everything in Pro",
      "Automatic remediation preparation",
      "Policy-driven Draft PR preparation",
      "Larger limits",
      "Stronger controls",
    ],
    cta: "Start with Business",
  },
];

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
          Pick how far Auterim goes.
        </h2>
        <p className={s.lede}>
          Every plan watches what you run on. Higher plans prove the impact and prepare the fix.
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
            <Link href="/signup" className={plan.featured ? s.planCtaPro : s.planCta}>
              {plan.cta}
            </Link>
            <p className={s.planNote} aria-hidden={plan.note ? undefined : true}>
              {plan.note ?? ""}
            </p>
          </article>
        ))}
      </div>
      <p data-reveal className={s.pricingFoot}>
        All plans start with dependency discovery. Your{" "}
        <span className={s.nowrap}>5-day Pro trial</span> begins when protection goes live.
      </p>
    </section>
  );
}
