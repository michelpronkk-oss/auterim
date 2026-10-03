import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "https://auterim.com"),
  title: { default: "Auterim — Dependency change protection", template: "%s | Auterim" },
  description:
    "Know what will break before it breaks. Auterim protects businesses from changes in the external software they depend on.",
  openGraph: { siteName: "Auterim", type: "website", locale: "en_US" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
