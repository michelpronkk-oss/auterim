import type { Metadata } from "next";
import { AuthForm } from "@/app/auth-form";

export const metadata: Metadata = {
  title: "Reset your password",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return <AuthForm mode="forgot" />;
}
