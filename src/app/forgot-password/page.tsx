import type { Metadata, Viewport } from "next";
import { AuthForm } from "@/app/auth-form";

export const metadata: Metadata = {
  title: "Reset your password",
  robots: { index: false, follow: false },
};

// Tints the mobile browser bars to the top of the auth page.
export const viewport: Viewport = { themeColor: "#e4ebf9" };

export default function ForgotPasswordPage() {
  return <AuthForm mode="forgot" />;
}
