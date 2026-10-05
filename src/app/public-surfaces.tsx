import Link from "next/link";

export function PublicHeader() {
  return (
    <header className="public-header">
      <Link className="wordmark" href="/" aria-label="Auterim home">
        <span className="brand-mark" aria-hidden="true">
          A
        </span>
        auterim
      </Link>
      <nav aria-label="Public navigation">
        <Link href="/changes">Changes</Link>
        <Link href="/tools">Free tools</Link>
        <Link href="/pricing">Pricing</Link>
        <Link href="/login">Sign in</Link>
        <Link className="public-nav-cta" href="/signup">
          Create account
        </Link>
      </nav>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="public-footer">
      <Link className="wordmark" href="/">
        <span className="brand-mark">A</span>auterim
      </Link>
      <span>Know what will break before it breaks.</span>
      <nav aria-label="Footer navigation">
        <Link href="/changes">Provider changes</Link>
        <Link href="/tools">Free tools</Link>
        <Link href="/pricing">Pricing</Link>
        <Link href="/signup">Get protected</Link>
      </nav>
    </footer>
  );
}

export function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="public-shell">
      <PublicHeader />
      {children}
      <PublicFooter />
    </main>
  );
}
