import Link from "next/link";

export default function Home() {
  return (
    <main className="landing-shell">
      <header className="topbar">
        <Link className="wordmark" href="/" aria-label="Auterim home">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          auterim
        </Link>
        <Link className="nav-link" href="/app">
          Product preview <span aria-hidden="true">↗</span>
        </Link>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <p className="eyebrow">
          <span className="status-dot" /> External change monitoring for modern teams
        </p>
        <h1 id="hero-title">Know when the tools your business depends on change.</h1>
        <p className="hero-copy">
          Auterim monitors the external services your company relies on and surfaces only the
          changes that matter—before they become your problem.
        </p>
        <Link className="primary-link" href="/app">
          Explore the product shell <span aria-hidden="true">→</span>
        </Link>
      </section>

      <section className="signal-card" aria-label="Example change monitoring flow">
        <div className="card-heading">
          <div>
            <p className="card-kicker">THE AUTERIM APPROACH</p>
            <h2>Less noise. Earlier clarity.</h2>
          </div>
          <span className="quiet-badge">Built for signal</span>
        </div>
        <div className="flow-row">
          <div className="flow-step">
            <span className="step-number">01</span>
            <span>Track trusted sources</span>
          </div>
          <span className="flow-arrow" aria-hidden="true">
            →
          </span>
          <div className="flow-step">
            <span className="step-number">02</span>
            <span>Understand what changed</span>
          </div>
          <span className="flow-arrow" aria-hidden="true">
            →
          </span>
          <div className="flow-step">
            <span className="step-number">03</span>
            <span>See why it matters</span>
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <span>Auterim</span>
        <span>Clarity for the dependencies behind your business.</span>
      </footer>
    </main>
  );
}
