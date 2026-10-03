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
            const parsed = new URL(websiteUrl);
            if (
              ["https:", "http:"].includes(parsed.protocol) &&
              !parsed.username &&
              !parsed.password &&
              ["", "80", "443"].includes(parsed.port)
            )
              nextParams.set("websiteUrl", websiteUrl);
          } catch {
            // Ignore malformed attribution input and continue through ordinary workspace setup.
          }
        }
        for (const key of ["utm_source", "utm_medium", "utm_campaign"]) {
          const value = current.get(key);
          if (value && /^[\p{L}\p{N}._ -]{1,100}$/u.test(value)) nextParams.set(key, value);
        }
        const nextPath = `/app/account${nextParams.size ? `?${nextParams}` : ""}`;
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
    <main className="auth-shell">
      <header className="auth-topbar">
        <Link className="wordmark" href="/">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          auterim
        </Link>
        <Link className="nav-link" href="/">
          Back to Auterim
        </Link>
      </header>
      <section className="auth-card" aria-labelledby="auth-title">
        <p className="eyebrow">
          <span className="status-dot" /> Workspace protection
        </p>
        <h1 id="auth-title">{labels.title}</h1>
        <p className="auth-description">{labels.description}</p>
        <form className="auth-form" onSubmit={submit}>
          {mode !== "reset" && (
            <label>
              Email
              <input name="email" type="email" autoComplete="email" required maxLength={320} />
            </label>
          )}
          {(mode === "signup" || mode === "login" || mode === "reset") && (
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
                minLength={8}
                maxLength={128}
              />
            </label>
          )}
          <button className="primary-link auth-submit" type="submit" disabled={busy}>
            {busy ? "Please wait…" : labels.submit}
            <span aria-hidden="true">→</span>
          </button>
        </form>
        {message && (
          <p className="auth-message" role="status">
            {message}
          </p>
        )}
        <nav className="auth-links" aria-label="Account options">
          {mode === "signup" && <Link href="/login">Already have an account? Sign in</Link>}
          {mode === "login" && (
            <>
              <Link href="/signup">Create an account</Link>
              <Link href="/forgot-password">Forgot password?</Link>
            </>
          )}
          {mode === "forgot" && <Link href="/login">Back to sign in</Link>}
          {mode === "reset" && <Link href="/login">Back to sign in</Link>}
        </nav>
      </section>
      <p className="auth-footnote">
        Your workspace and billing access are verified on every server request.
      </p>
    </main>
  );
}
