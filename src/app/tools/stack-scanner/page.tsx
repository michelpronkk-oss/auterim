import type { Metadata, Viewport } from "next";
import { SiteShell } from "@/app/_site/site-shell";
import { MoreTools } from "../tool-parts";
import { ScanHero, ScanProvider, ScanResults } from "./scanner";

export const metadata: Metadata = {
  title: "Stack scanner",
  description: "Scan a company homepage for signals of the services it likely runs on.",
  alternates: { canonical: "/tools/stack-scanner" },
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { themeColor: "#e4ebf9" };

export default function StackScannerPage() {
  return (
    <ScanProvider>
      <SiteShell current="tools" hero={<ScanHero />}>
        <ScanResults />
        <MoreTools current="scanner" />
      </SiteShell>
    </ScanProvider>
  );
}
