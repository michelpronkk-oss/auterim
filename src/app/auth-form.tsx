"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  confirmSignupConversion,
  emitPublicConversionEvent,
  readPublicAttribution,
} from "@/lib/public/conversion";
import { canonicalizePublicWebsiteUrl } from "@/lib/discovery/normalize-website-url";
import s from "@/app/_auth/auth.module.css";
import { geist, geistMono } from "@/app/_site/fonts";
import { BrandMark } from "@/app/_home/marks";

export type AuthMode = "signup" | "login" | "forgot" | "reset";

const copy: Record<AuthMode, { title: string; description: string; submit: string }> = {
  signup: {
    title: "Create your Auterim account",
    description: "Start with your work email. We’ll set up your workspace next.",
    submit: "Create account",
  },
  login: {
    title: "Welcome back",
    description: "Sign in to continue protecting your workspace.",
    submit: "Sign in",
  },
  forgot: {
    title: "Reset your password",
    description: "We’ll send a secure reset link to your email.",
    submit: "Send reset link",
  },
  reset: {
    title: "Choose a new password",
    description: "Use a strong password you haven’t used elsewhere.",
    submit: "Save password",
  },
};

export function AuthForm({ mode }: { mode: AuthMode }) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setBusy(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    try {
      const supabase = createSupabaseBrowserClient();
      if (mode === "signup") {
        const current = new URLSearchParams(window.location.search);
        const nextParams = new URLSearchParams();
        const websiteUrl = current.get("websiteUrl");
        if (websiteUrl && websiteUrl.length <= 2048) {
          try {
            nextParams.set("websiteUrl", canonicalizePublicWebsiteUrl(websiteUrl));
          } catch {
            // Ignore malformed attribution input and continue through ordinary workspace setup.
          }
        }
        for (const key of ["utm_source", "utm_medium", "utm_campaign"]) {
          const value = current.get(key);
          if (value && /^[\p{L}\p{N}._ -]{1,100}$/u.test(value)) nextParams.set(key, value);
        }
        const nextPath = `/app/onboarding${nextParams.size ? `?${nextParams}` : ""}`;
        emitPublicConversionEvent("signup_started", readPublicAttribution(current, "/signup"));
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}`,
          },
        });
        if (error) throw error;
        if (data.session) {
          void confirmSignupConversion(data.session.access_token);
          router.push(nextPath);
        } else setMessage("Check your email to verify your account, then sign in to continue.");
      } else if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push("/app");
      } else if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/auth/callback?next=%2Freset-password`,
        });
        if (error) throw error;
        setMessage("If an account exists for that email, a reset link is on its way.");
      } else {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        setMessage("Password updated. You can continue to your workspace.");
        window.setTimeout(() => router.push("/app"), 700);
      }
    } catch {
      setMessage(
        mode === "login"
          ? "Sign-in failed. Check your email and password."
          : "That request could not be completed. Check your details and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  const labels = copy[mode];
  return (
    <div className={`${geist.variable} ${geistMono.variable} ${s.page}`}>
      <div className={s.frame}>
        <header className={s.top}>
          <Link className={s.back} href="/">
            <span aria-hidden="true">←</span> Back to Auterim
          </Link>
        </header>
        <main className={s.main}>
          <Link className={s.brand} href="/" aria-label="Auterim home">
            <BrandMark size={30} />
            Auterim
          </Link>
          <section className={s.card} aria-labelledby="auth-title">
            <div className={s.head}>
              <p className={s.eyebrow}>
                <span className={s.dot} aria-hidden="true" />
                WORKSPACE PROTECTION
              </p>
              <h1 id="auth-title" className={s.title}>
                {labels.title}
              </h1>
              <p className={s.lede}>{labels.description}</p>
            </div>
            <form className={s.form} onSubmit={submit}>
              {mode !== "reset" && (
                <label className={s.field}>
                  <span className={s.labelRow}>Email</span>
                  <input
                    className={s.input}
                    name="email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@company.com"
                    required
                    maxLength={320}
                  />
                </label>
              )}
              {(mode === "signup" || mode === "login" || mode === "reset") && (
                <div className={s.field}>
                  <span className={s.labelRow}>
                    <label htmlFor="auth-password">Password</label>
                    {mode === "login" && <Link href="/forgot-password">Forgot password?</Link>}
                  </span>
                  <input
                    id="auth-password"
                    className={s.input}
                    name="password"
                    type="password"
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    placeholder={mode === "login" ? undefined : "At least 8 characters"}
                    required
                    minLength={8}
                    maxLength={128}
                  />
                </div>
              )}
              <button className={s.submit} type="submit" disabled={busy}>
                {busy ? "Please wait…" : labels.submit}
                <span className={s.arrow} aria-hidden="true">
                  →
                </span>
              </button>
            </form>
            {message && (
              <p className={s.message} role="status">
                {message}
              </p>
            )}
            <nav className={s.switch} aria-label="Account options">
              {mode === "signup" && (
                <>
                  Already have an account? <Link href="/login">Sign in</Link>
                </>
              )}
              {mode === "login" && (
                <>
                  New to Auterim? <Link href="/signup">Create an account</Link>
                </>
              )}
              {(mode === "forgot" || mode === "reset") && (
                <Link href="/login">Back to sign in</Link>
              )}
            </nav>
          </section>
          <p className={s.foot}>
            <svg className={s.lock} aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
              <rect
                x="2"
                y="5.2"
                width="8"
                height="5.6"
                rx="1.4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <path
                d="M4 5.2V3.8a2 2 0 0 1 4 0v1.4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
              />
            </svg>
            Your workspace and billing access are verified on every server request.
          </p>
        </main>
      </div>
    </div>
  );
}
