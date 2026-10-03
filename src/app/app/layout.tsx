import type { ReactNode } from "react";
import { AppShell } from "./app-shell";

export default function ProductLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
