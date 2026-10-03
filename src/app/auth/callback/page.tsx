"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { confirmSignupConversion } from "@/lib/public/conversion";

function safeNextPath(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return "/app";
  return value;
}

export default function AuthCallbackPage() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const supabase = createSupabaseBrowserClient();
        const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        const { data } = await supabase.auth.getUser();
        if (!data.user) throw new Error("auth_session_missing");
        if (!cancelled) {
          const nextPath = safeNextPath(new URLSearchParams(window.location.search).get("next"));
          if (nextPath.startsWith("/app/account")) {
            if (sessionData.session) void confirmSignupConversion(sessionData.session.access_token);
          }
          router.replace(nextPath);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);
  return (
    <main className="auth-shell">
      <section className="auth-card auth-status-card" aria-live="polite">
        <span className="brand-mark" aria-hidden="true">
          A
        </span>
        <h1>{failed ? "This sign-in link could not be used" : "Verifying your account"}</h1>
        <p className="auth-description">
          {failed
            ? "The link may have expired. Request a new one and try again."
            : "One moment while we securely finish signing you in."}
        </p>
        {failed && (
          <Link className="primary-link auth-submit" href="/login">
            Continue to sign in <span aria-hidden="true">→</span>
          </Link>
        )}
      </section>
    </main>
  );
}
