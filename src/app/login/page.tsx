import type { Metadata, Viewport } from "next";
import { AuthForm } from "@/app/auth-form";

export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };

// Tints the mobile browser bars to the top of the auth page.
export const viewport: Viewport = { themeColor: "#e4ebf9" };

export default function LoginPage() {
  return <AuthForm mode="login" />;
}
