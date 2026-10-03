"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { z } from "zod";
import type { Session } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  PLAN_CATALOG,
  type PlanSlug,
  type WorkspaceEntitlements,
} from "@/lib/billing/plan-catalog";

const accountSchema = z
  .object({
    role: z.enum(["owner", "admin", "member"]),
    onboarding: z
      .object({
        currentStep: z.string(),
        company: z.object({ name: z.string(), websiteUrl: z.string().nullable() }).passthrough(),
        confirmedDependencies: z.array(z.unknown()),
        coveragePreview: z
          .object({ dependenciesConfirmed: z.number(), authoritativeSourcesAvailable: z.number() })
          .passthrough(),
        activation: z.object({ activatedAt: z.string(), baselineStatus: z.string() }).nullable(),
      })
      .passthrough(),
    entitlements: z.custom<WorkspaceEntitlements>(),
    initialAssessment: z
      .object({
        dependencies_confirmed: z.number(),
        authoritative_sources_available: z.number(),
        current_global_baselines: z.number(),
        material_changes_evaluated: z.number(),
        relevant_changes: z.number(),
        verified_repository_exposures: z.number(),
        remediation_available: z.number(),
      })
      .nullable(),
  })
  .passthrough();

type AccountData = z.infer<typeof accountSchema>;

const ACCOUNT_BOOTSTRAP_TIMEOUT_MS = 12_000;

function withAccountTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: number | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = window.setTimeout(
        () => reject(new Error("Could not restore your sign-in state.")),
        ACCOUNT_BOOTSTRAP_TIMEOUT_MS,
      );
    }),
  ]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
}

async function fetchAccountWithTimeout(input: RequestInfo | URL, init?: RequestInit) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), ACCOUNT_BOOTSTRAP_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch {
    if (controller.signal.aborted) throw new Error("Workspace request timed out. Try again.");
    throw new Error("Could not reach your workspace. Try again.");
  } finally {
    window.clearTimeout(timer);
  }
}

function createInitialSetupForm(websiteUrl: string) {
  try {
    const parsed = new URL(websiteUrl);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      !["", "80", "443"].includes(parsed.port)
    )
      throw new Error("invalid_site");
    const domain = parsed.hostname.replace(/^www\./, "");
    const companyName = domain.split(".")[0]?.replace(/[-_]+/g, " ") ?? "";
    return {
      websiteUrl: parsed.origin,
      companyName,
      workspaceName: companyName && `${companyName} team`,
    };
  } catch {
    return { workspaceName: "", companyName: "", websiteUrl: "" };
  }
}

export function AccountPanel({ initialWebsiteUrl = "" }: { initialWebsiteUrl?: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspaces, setWorkspaces] = useState<
    Array<{ workspace_id: string; role: string; name: string }>
  >([]);
  const [account, setAccount] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [setupForm, setSetupForm] = useState(() => createInitialSetupForm(initialWebsiteUrl));

  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      if (!session?.access_token) throw new Error("Sign in to continue.");
      const response = await fetch(path, {
        ...init,
        headers: { authorization: `Bearer ${session.access_token}`, ...(init?.headers ?? {}) },
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          body && typeof body === "object" && "error" in body
            ? String(body.error)
            : "Request failed.",
        );
      return body;
    },
    [session],
  );

  const load = useCallback(async (token: string, selected?: string) => {
    const headers = { authorization: `Bearer ${token}` };
    const listResponse = await fetchAccountWithTimeout("/api/account/status", { headers });
    const listBody = await listResponse.json();
    if (!listResponse.ok) throw new Error("Could not load your workspaces.");
    const membershipOptions = z
      .array(z.object({ workspace_id: z.string().uuid(), role: z.string() }))
      .parse(listBody.workspaces ?? []);
    const options = await Promise.all(
      membershipOptions.map(async (item) => {
        try {
          const workspaceResponse = await fetchAccountWithTimeout(
            `/api/account/status?workspaceId=${encodeURIComponent(item.workspace_id)}`,
            { headers },
          );
          const workspaceBody = await workspaceResponse.json();
          return {
            ...item,
            name: accountSchema.parse(workspaceBody).onboarding.company.name,
          };
        } catch {
          return { ...item, name: "Workspace" };
        }
      }),
    );
    setWorkspaces(options);
    if (!options.length) {
      setWorkspaceId("");
      setAccount(null);
      setLoadError(false);
      return;
    }
    const stored = selected ?? window.localStorage.getItem("auterim-workspace-id");
    const target = options.some((item) => item.workspace_id === stored)
      ? stored!
      : options[0]!.workspace_id;
    const response = await fetchAccountWithTimeout(
      `/api/account/status?workspaceId=${encodeURIComponent(target)}`,
      {
        headers,
      },
    );
    const body = await response.json();
    if (!response.ok) throw new Error("Could not load workspace protection.");
    setWorkspaceId(target);
    window.localStorage.setItem("auterim-workspace-id", target);
    setAccount(accountSchema.parse(body));
    setLoadError(false);
  }, []);

  useEffect(() => {
    const client = createSupabaseBrowserClient();
    void withAccountTimeout(client.auth.getSession())
      .then(({ data }) => {
        setSession(data.session);
        if (data.session) return load(data.session.access_token);
      })
      .catch(() => {
        setLoadError(true);
        setMessage("Could not check your sign-in state.");
      })
      .finally(() => setLoading(false));
    const { data: listener } = client.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAccount(null);
      if (nextSession)
        void load(nextSession.access_token).catch(() => {
          setLoadError(true);
          setMessage("Could not load your workspace.");
        });
    });
    return () => listener.subscription.unsubscribe();
  }, [load]);

  async function startWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    try {
      let key = window.localStorage.getItem("auterim-onboarding-idempotency-key");
      if (!key) {
        key = crypto.randomUUID();
        window.localStorage.setItem("auterim-onboarding-idempotency-key", key);
      }
      const result = await api("/api/account/onboarding/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceName: form.get("workspaceName"),
          companyName: form.get("companyName"),
          websiteUrl: form.get("websiteUrl"),
          idempotencyKey: key,
        }),
      });
      const response = z.object({ workspaceId: z.string().uuid() }).parse(result);
      window.localStorage.removeItem("auterim-onboarding-idempotency-key");
      await load(session!.access_token, response.workspaceId);
      setMessage("Workspace created. Your onboarding progress is saved as you go.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Workspace setup failed.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    await createSupabaseBrowserClient().auth.signOut();
    window.localStorage.removeItem("auterim-workspace-id");
    setSession(null);
    setAccount(null);
    setBusy(false);
  }

  async function choosePlan(plan: PlanSlug) {
    if (!workspaceId) return;
    setBusy(true);
    setMessage("");
    try {
      const idempotencyKey = crypto.randomUUID();
      const result = z
        .object({ checkoutUrl: z.string().url().optional(), status: z.string().optional() })
        .parse(
          await api("/api/billing/checkout", {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
            body: JSON.stringify({ workspaceId, plan }),
          }),
        );
      if (result.checkoutUrl) window.location.assign(result.checkoutUrl);
      else setMessage("Plan change submitted. Access updates after Dodo confirms it.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Billing action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function openPortal() {
    setBusy(true);
    setMessage("");
    try {
      const result = z.object({ url: z.string().url() }).parse(
        await api("/api/billing/portal", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId }),
        }),
      );
      window.location.assign(result.url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Billing portal unavailable.");
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <main className="product-shell">
        <div className="account-wrap">Loading your workspace…</div>
      </main>
    );
  if (!session)
    return (
      <main className="product-shell">
        <header className="topbar product-topbar">
          <Link className="wordmark" href="/">
            <span className="brand-mark">A</span>auterim
          </Link>
          <nav className="account-nav">
            <Link href="/login">Sign in</Link>
            <Link href="/signup">Create account</Link>
          </nav>
        </header>
        <section className="product-content">
          <p className="eyebrow">
            <span className="status-dot" /> Workspace access
          </p>
          <h1>Sign in to your protection workspace.</h1>
          <p className="hero-copy">
            Create an account or sign in to resume setup and manage protection.
          </p>
          <div className="account-actions">
            <Link className="primary-link" href="/signup">
              Create account <span aria-hidden="true">→</span>
            </Link>
            <Link className="secondary-link" href="/login">
              Sign in
            </Link>
          </div>
        </section>
      </main>
    );

  return (
    <main className="product-shell">
      <header className="topbar product-topbar">
        <Link className="wordmark" href="/">
          <span className="brand-mark">A</span>auterim
        </Link>
        <div className="account-nav">
          <span>{session.user.email}</span>
          <button className="text-button" type="button" onClick={signOut} disabled={busy}>
            Sign out
          </button>
        </div>
      </header>
      <section className="product-content">
        <p className="eyebrow">
          <span className="status-dot" /> Account &amp; protection
        </p>
        <h1>
          {account ? "Your workspace, protected with context." : "Set up your first workspace."}
        </h1>
        {message && (
          <p className="auth-message" role="status">
            {message}
          </p>
        )}
        {loadError && (
          <section className="auth-message" role="alert">
            <p>We couldn’t verify your existing workspace, so setup is paused.</p>
            <button
              type="button"
              className="secondary-link"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void load(session.access_token)
                  .catch(() => setLoadError(true))
                  .finally(() => setBusy(false));
              }}
            >
              Try again
            </button>
          </section>
        )}
        {!loadError && !workspaces.length && (
          <form className="auth-form workspace-form" onSubmit={startWorkspace}>
            <label>
              Workspace name
              <input
                name="workspaceName"
                required
                minLength={1}
                maxLength={120}
                placeholder="Acme engineering"
                value={setupForm.workspaceName}
                onChange={(event) =>
                  setSetupForm((current) => ({ ...current, workspaceName: event.target.value }))
                }
              />
            </label>
            <label>
              Company name
              <input
                name="companyName"
                required
                minLength={1}
                maxLength={160}
                placeholder="Acme, Inc."
                value={setupForm.companyName}
                onChange={(event) =>
                  setSetupForm((current) => ({ ...current, companyName: event.target.value }))
                }
              />
            </label>
            <label>
              Company website
              <input
                name="websiteUrl"
                type="url"
                required
                maxLength={2048}
                placeholder="https://example.com"
                value={setupForm.websiteUrl}
                onChange={(event) =>
                  setSetupForm((current) => ({ ...current, websiteUrl: event.target.value }))
                }
              />
            </label>
            <button className="primary-link auth-submit" disabled={busy}>
              {busy ? "Saving…" : "Create workspace"}
              <span aria-hidden="true">→</span>
            </button>
          </form>
        )}
        {workspaces.length > 1 && (
          <label className="workspace-select">
            Workspace
            <select
              value={workspaceId}
              onChange={(event) => void load(session.access_token, event.target.value)}
            >
              {workspaces.map((item) => (
                <option key={item.workspace_id} value={item.workspace_id}>
                  {item.name} · {item.role}
                </option>
              ))}
            </select>
          </label>
        )}
        {account && (
          <>
            <div className="account-summary">
              <div>
                <span className="summary-label">Workspace</span>
                <strong>{account.onboarding.company.name}</strong>
                <span className="summary-note">{account.onboarding.company.websiteUrl}</span>
              </div>
              <div>
                <span className="summary-label">Onboarding</span>
                <strong>{account.onboarding.currentStep.replaceAll("_", " ")}</strong>
                <span className="summary-note">
                  {account.onboarding.confirmedDependencies.length} confirmed dependencies
                </span>
              </div>
              <div>
                <span className="summary-label">Coverage</span>
                <strong>
                  {account.onboarding.coveragePreview.authoritativeSourcesAvailable} sources
                </strong>
                <span className="summary-note">
                  Across {account.onboarding.coveragePreview.dependenciesConfirmed} dependencies
                </span>
              </div>
            </div>
            <section className="billing-card">
              <div>
                <p className="card-kicker">PLAN &amp; ACCESS</p>
                <h2>
                  {account.entitlements.trial.active
                    ? "Pro trial"
                    : account.entitlements.effectivePlan
                      ? PLAN_CATALOG[account.entitlements.effectivePlan].name
                      : "Choose a plan to continue"}
                </h2>
                <p>
                  {account.entitlements.trial.active
                    ? `${account.entitlements.trial.daysRemaining} days remaining · ends ${new Date(account.entitlements.trial.endsAt!).toLocaleDateString()}`
                    : account.entitlements.locked
                      ? "Your workspace data is preserved. Select a plan to enable protected execution."
                      : account.entitlements.effectivePlan
                        ? `${account.entitlements.subscriptionStatus}${account.entitlements.billing.cancelAtPeriodEnd ? " · cancels at period end" : ""}`
                        : "Your five-day Pro trial begins after protection is successfully activated."}
                </p>
                {account.entitlements.overLimit.protectedDependencies && (
                  <p className="account-warning">
                    Dependency usage is above this plan’s limit. Existing dependencies are
                    preserved; choose what to keep active before adding more.
                  </p>
                )}
              </div>
              {account.entitlements.billing.currentPeriodEnd && (
                <button
                  className="secondary-link"
                  type="button"
                  onClick={openPortal}
                  disabled={busy}
                >
                  Manage billing
                </button>
              )}
              {account.entitlements.locked && (
                <div className="plan-grid">
                  {(Object.keys(PLAN_CATALOG) as PlanSlug[]).map((plan) => (
                    <article className="plan-card" key={plan}>
                      <h3>{PLAN_CATALOG[plan].name}</h3>
                      <strong>
                        ${PLAN_CATALOG[plan].priceUsdMonthly}
                        <small>/mo</small>
                      </strong>
                      <p>{PLAN_CATALOG[plan].tagline}</p>
                      <button type="button" onClick={() => void choosePlan(plan)} disabled={busy}>
                        Choose {PLAN_CATALOG[plan].name}
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </section>
            {account.initialAssessment && (
              <section className="assessment-card">
                <p className="card-kicker">INITIAL PROTECTION ASSESSMENT</p>
                <h2>Auterim is watching.</h2>
                <p>
                  {account.initialAssessment.dependencies_confirmed} dependencies ·{" "}
                  {account.initialAssessment.authoritative_sources_available} authoritative sources
                  · {account.initialAssessment.current_global_baselines} current shared baselines
                </p>
                <p>
                  {account.initialAssessment.material_changes_evaluated} material changes evaluated
                  · {account.initialAssessment.relevant_changes} relevant ·{" "}
                  {account.initialAssessment.verified_repository_exposures} verified repository
                  exposures · {account.initialAssessment.remediation_available} remediations
                  available
                </p>
              </section>
            )}
            <p className="account-step-note">
              Resume onboarding at{" "}
              <strong>{account.onboarding.currentStep.replaceAll("_", " ")}</strong>. Changes
              already confirmed in onboarding remain attached to this workspace.
            </p>
          </>
        )}
        <Link className="back-link" href="/">
          ← Back to Auterim
        </Link>
      </section>
    </main>
  );
}
