import type { Metadata } from "next";
import Link from "next/link";
import { PublicShell } from "@/app/public-surfaces";

export const metadata: Metadata = {
  title: "Free dependency tools",
  description:
    "Scan public technology signals and explore current authoritative dependency coverage.",
  alternates: { canonical: "/tools" },
};

const tools = [
  {
    href: "/tools/stack-scanner",
    title: "Public stack scanner",
    description:
      "Check a company homepage for known public technology markers. Results are suggestions, not confirmed dependencies.",
    tag: "Fast pass · no account",
  },
  {
    href: "/tools/dependency-exposure",
    title: "Dependency source coverage",
    description:
      "See which enabled authoritative sources Auterim currently monitors for a catalog dependency.",
    tag: "Live catalog coverage",
  },
  {
    href: "/tools/deprecation-checker",
    title: "Deprecation and deadline checker",
    description:
      "Review current approved provider changes with an effective date or deprecation-related topic.",
    tag: "Approved public intelligence",
  },
];

export default function ToolsPage() {
  return (
    <PublicShell current="tools">
      <section className="public-page-intro">
        <p className="eyebrow">FREE TOOLS</p>
        <h1>Start with a useful signal.</h1>
        <p>
          Small tools built from public evidence and the real Auterim source catalog. They do not
          replace a confirmed dependency inventory or customer-specific impact assessment.
        </p>
      </section>
      <section className="public-tool-grid">
        {tools.map((tool) => (
          <article className="public-tool-card" key={tool.href}>
            <p className="eyebrow">{tool.tag}</p>
            <h2>{tool.title}</h2>
            <p>{tool.description}</p>
            <Link className="public-text-link" href={tool.href}>
              Open tool →
            </Link>
          </article>
        ))}
      </section>
    </PublicShell>
  );
}
