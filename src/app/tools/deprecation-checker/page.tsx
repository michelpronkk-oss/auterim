import type { Metadata } from "next";
import { PublicShell } from "@/app/public-surfaces";
import { ToolResults } from "@/app/tools/tool-results";

export const revalidate = 300;
export const metadata: Metadata = {
  title: "Deprecation and deadline checker",
  description:
    "Review current approved software deprecation and retirement changes from authoritative public sources.",
  alternates: { canonical: "/tools/deprecation-checker" },
};

export default async function DeprecationCheckerPage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string }>;
}) {
  const { provider } = await searchParams;
  return (
    <PublicShell>
      <section className="public-page-intro">
        <p className="eyebrow">DEPRECATION CHECKER</p>
        <h1>Look for an approved deadline signal.</h1>
        <p>
          Results include only current or upcoming intelligence approved by Auterim’s public-safety
          policy. No match is not proof that a dependency has no upcoming change.
        </p>
      </section>
      <ToolResults kind="deprecation" provider={provider} />
    </PublicShell>
  );
}
