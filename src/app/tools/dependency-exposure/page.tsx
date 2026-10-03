import type { Metadata } from "next";
import { PublicShell } from "@/app/public-surfaces";
import { ToolResults } from "@/app/tools/tool-results";

export const revalidate = 300;
export const metadata: Metadata = {
  title: "Dependency source coverage",
  description:
    "Check real enabled authoritative source coverage for dependencies in Auterim’s catalog.",
  alternates: { canonical: "/tools/dependency-exposure" },
};

export default async function DependencyExposurePage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string }>;
}) {
  const { provider } = await searchParams;
  return (
    <PublicShell>
      <section className="public-page-intro">
        <p className="eyebrow">DEPENDENCY EXPOSURE</p>
        <h1>Check monitoring coverage for a dependency.</h1>
        <p>
          Coverage counts come from enabled rows in Auterim’s actual global source catalog. They
          describe available sources, not whether a specific company uses the dependency.
        </p>
      </section>
      <ToolResults kind="exposure" provider={provider} />
    </PublicShell>
  );
}
