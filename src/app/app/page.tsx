import Link from "next/link";

export default function ProductPreview() {
  return (
    <main className="product-shell">
      <header className="topbar product-topbar">
        <Link className="wordmark" href="/">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          auterim
        </Link>
        <span className="preview-label">Foundation preview</span>
      </header>
      <section className="product-content" aria-labelledby="product-title">
        <p className="eyebrow">
          <span className="status-dot" /> Workspace
        </p>
        <h1 id="product-title">Your dependencies, in one place.</h1>
        <p className="hero-copy">
          This is a product shell only. Sign-in and workspace data are not connected yet.
        </p>
        <div className="empty-state">
          <div className="empty-icon" aria-hidden="true">
            ＋
          </div>
          <h2>No dependencies added</h2>
          <p>
            When the product is ready, you’ll be able to choose the services your company relies on.
          </p>
          <span className="coming-soon">Dependency tracking is not implemented</span>
        </div>
        <Link className="back-link" href="/">
          ← Back to Auterim
        </Link>
      </section>
    </main>
  );
}
