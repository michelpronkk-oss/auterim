import type { ReactNode } from "react";
import type { Metadata } from "next";
import { AppShell } from "./app-shell";

export const metadata: Metadata = {
  robots: { index: false, follow: false, noarchive: true },
};

export default function ProductLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
