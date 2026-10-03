import type { Metadata } from "next";
import Link from "next/link";
import { PublicPageView } from "@/app/public-page-view";
import { PublicShell } from "@/app/public-surfaces";

export const metadata: Metadata = {
  title: "Auterim — Know what will break before it breaks",
  description:
    "Auterim monitors changes in the software your business depends on, verifies repository exposure, and helps teams act before deadlines.",
  alternates: { canonical: "/" },
};

const capabilities = [
  {
    number: "01",
    title: "Detect the change",
    copy: "Track authoritative provider sources and separate material changes from routine noise.",
  },
  {
    number: "02",
    title: "Understand your exposure",
    copy: "Connect a change to the dependencies and usage context your team has confirmed.",
  },
  {
    number: "03",
    title: "Verify the repository",
    copy: "Use GitHub-backed Preflight to check whether a dependency appears in connected repositories.",
  },
  {
    number: "04",
    title: "See the deadline",
    copy: "Keep upcoming deprecations and effective dates visible while there is time to respond.",
  },
  {
    number: "05",
    title: "Prepare a grounded action",
    copy: "Review evidence-backed remediation and create an engineering action when you choose.",
  },
];

export default function Home() {
  return (
    <PublicShell>
      <PublicPageView event="homepage_view" />
      <section className="public-hero" aria-labelledby="hero-title">
        <p className="eyebrow">
          <span className="status-dot" /> Software dependency protection
        </p>
        <h1 id="hero-title">Know what will break before it breaks.</h1>
        <p className="public-hero-copy">
          Auterim protects businesses from changes in the external software they depend on—from the
          first authoritative signal to customer impact, verified repository exposure, and a clear
          next action.
        </p>
        <div className="public-hero-actions">
          <Link className="primary-link" href="/tools/stack-scanner">
            Scan your public stack <span aria-hidden="true">→</span>
          </Link>
          <Link className="public-text-link" href="/signup">
            Set up protection
          </Link>
        </div>
        <p className="public-microcopy">
          Start with a public URL scan. No account is needed to see the first signals.
        </p>
      </section>
      <section className="public-proof-band" aria-label="How Auterim works">
        <div>
          <strong>External change</strong>
          <span>→</span>
          <strong>Material signal</strong>
          <span>→</span>
          <strong>Your impact</strong>
          <span>→</span>
          <strong>Verified action</strong>
        </div>
        <p>
          Monitoring a changelog is only the beginning. Auterim connects what changed to where it
          may matter in your business.
        </p>
      </section>
      <section className="public-section" aria-labelledby="protection-title">
        <div className="public-section-heading">
          <div>
            <p className="eyebrow">FROM SIGNAL TO PREVENTION</p>
            <h2 id="protection-title">A clearer path from change to action.</h2>
          </div>
          <Link className="public-text-link" href="/changes">
            Browse approved public changes →
          </Link>
        </div>
        <div className="capability-grid">
          {capabilities.map((item) => (
            <article className="capability-card" key={item.number}>
              <span>{item.number}</span>
              <h3>{item.title}</h3>
              <p>{item.copy}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="public-scan-cta">
        <div>
          <p className="eyebrow">A USEFUL FIRST STEP</p>
          <h2>See the public signals already visible on your site.</h2>
          <p>
            The fast scan checks a homepage and its public resource references. It is a starting
            point, not a complete inventory or a claim that a provider is confirmed.
          </p>
        </div>
        <Link className="primary-link" href="/tools/stack-scanner">
          Run the free scan <span aria-hidden="true">→</span>
        </Link>
      </section>
      <section className="public-section public-pricing-preview">
        <div>
          <p className="eyebrow">START WITH THE PROTECTION YOU NEED</p>
          <h2>One workspace. Clear monthly plans.</h2>
          <p>
            Choose Core, Pro, or Business after seeing how your dependencies map to real source
            coverage. A five-day Pro trial starts only when protection is activated.
          </p>
        </div>
        <Link className="button-secondary" href="/pricing">
          Compare plans
        </Link>
      </section>
    </PublicShell>
  );
}
