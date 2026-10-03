import type { Metadata } from "next";
import { PublicShell } from "@/app/public-surfaces";
import { StackScanner } from "./scanner";

export const metadata: Metadata = {
  title: "Public stack scanner",
  description: "Scan a public company homepage for deterministic technology dependency signals.",
  alternates: { canonical: "/tools/stack-scanner" },
  robots: { index: false, follow: false },
};

export default function StackScannerPage() {
  return (
    <PublicShell>
      <section className="public-page-intro scanner-intro">
        <p className="eyebrow">PUBLIC STACK SCANNER</p>
        <h1>Find likely dependencies from public signals.</h1>
        <p>
          Enter a company homepage. Auterim checks the public response and linked resources for
          deterministic provider markers using its existing safe-fetch controls.
        </p>
      </section>
      <section className="public-section">
        <StackScanner />
      </section>
      <p className="public-source-note">
        A detected marker is not user confirmation. Results are not saved as a company or workspace
        until you choose to continue and finish setup.
      </p>
    </PublicShell>
  );
}
