"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { z } from "zod";
import type { Session } from "@supabase/supabase-js";
import { OnboardingV2Panel } from "@/app/app/onboarding-v2-panel";
import { WorkspaceMembersPanel } from "@/app/app/workspace-members-panel";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { notifyWorkspaceUpdated, shouldShowWorkspaceSelector } from "@/lib/app/workspace-bootstrap";
import {
  normalizeWorkspaceOptions,
  resolveSelectedWorkspaceId,
  type WorkspaceOption,
} from "@/lib/app/workspace-options";
import {
  PLAN_CATALOG,
  type PlanSlug,
  type WorkspaceEntitlements,
} from "@/lib/billing/plan-catalog";
import {
  canonicalizePublicWebsiteUrl,
  WebsiteUrlInputError,
} from "@/lib/discovery/normalize-website-url";
import {
  createRequestSequence,
  onboardingStepIndex,
  onboardingReadModelSchema,
  resolveOnboardingStep,
  summarizeCandidateEvidence,
  type OnboardingReadModel,
} from "@/lib/onboarding/client-state";

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
        dependenciesConfirmed: z.number(),
        authoritativeSourcesAvailable: z.number(),
        snapshotsObservedAtActivation: z.number(),
        materialChangesEvaluated: z.number(),
        relevantChanges: z.number(),
        verifiedRepositoryExposures: z.number(),
        remediationsAvailable: z.number(),
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
    return await fetch(input, {
      ...init,
      cache: init?.cache ?? "no-store",
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted) throw new Error("Workspace request timed out. Try again.");
    throw new Error("Could not reach your workspace. Try again.");
  } finally {
    window.clearTimeout(timer);
  }
}

function createInitialSetupForm(websiteUrl: string) {
  try {
    const parsed = new URL(canonicalizePublicWebsiteUrl(websiteUrl));
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

const usageOptions = [
  "customer-facing product",
  "authentication",
  "billing",
  "email",
  "AI processing",
  "verification",
  "internal workflows",
  "analytics",
  "infrastructure",
  "database",
  "other",
];

function FirstWorkspaceOnboarding({
  session,
  workspaceId,
  onboarding,
  setupForm,
  setSetupForm,
  api,
  refresh,
  busy,
  setBusy,
  setLoadError,
  canManageWorkspace,
}: {
  session: Session;
  workspaceId: string;
  onboarding: OnboardingReadModel | null;
  setupForm: ReturnType<typeof createInitialSetupForm>;
  setSetupForm: React.Dispatch<React.SetStateAction<ReturnType<typeof createInitialSetupForm>>>;
  api: (path: string, init?: RequestInit) => Promise<unknown>;
  refresh: (token: string, selected?: string) => Promise<void>;
  busy: boolean;
  setBusy: (value: boolean) => void;
  setLoadError: (value: boolean) => void;
  canManageWorkspace: boolean;
}) {
  const [operationError, setOperationError] = useState("");
  const [websiteError, setWebsiteError] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogSearchCompletedQuery, setCatalogSearchCompletedQuery] = useState("");
  const [catalog, setCatalog] = useState<
    Array<{
      id: string;
      slug: string;
      name: string;
      category: string;
      categoryLabel: string;
      authoritativeSourceCount: number;
      coverageStatus: "strong_coverage" | "partial_coverage" | "coverage_pending";
    }>
  >([]);
  const [preferences, setPreferences] = useState<{
    importantChanges: "daily_digest" | "instant" | "off";
    informational: "off" | "digest";
    monthlyProtectionReport: boolean;
  } | null>(null);
  const router = useRouter();
  const notificationPreferences = preferences ?? {
    importantChanges: onboarding?.notificationPreferences?.importantChanges ?? "instant",
    informational: onboarding?.notificationPreferences?.informational ?? "off",
    monthlyProtectionReport: onboarding?.notificationPreferences?.monthlyProtectionReport ?? true,
  };
  const [localContext, setLocalContext] = useState<
    Record<
      string,
      {
        criticality: "critical" | "important" | "normal";
        productionCritical: boolean;
        usedFor: string[];
        contextNote: string;
      }
    >
  >({});

  useEffect(() => {
    const query = catalogQuery.trim();
    if (!onboarding || !workspaceId || !query) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api(
        `/api/onboarding/dependencies?workspaceId=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(query)}`,
      )
        .then((value) => {
          const parsed = z
            .object({
              dependencies: z.array(
                z.object({
                  id: z.string().uuid(),
                  slug: z.string(),
                  name: z.string(),
                  category: z.string(),
                  categoryLabel: z.string(),
                  authoritativeSourceCount: z.number().int().nonnegative(),
                  coverageStatus: z.enum([
                    "strong_coverage",
                    "partial_coverage",
                    "coverage_pending",
                  ]),
                }),
              ),
            })
            .parse(value);
          if (!cancelled) {
            setCatalog(parsed.dependencies);
            setCatalogSearchCompletedQuery(query);
          }
        })
        .catch(() => {
          if (!cancelled) setOperationError("Could not search the dependency catalog. Try again.");
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, catalogQuery, onboarding, workspaceId]);

  useEffect(() => {
    if (!onboarding || resolveOnboardingStep(onboarding) !== "discovery" || !workspaceId) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (!cancelled) void refresh(session.access_token, workspaceId).catch(() => undefined);
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [onboarding, refresh, session.access_token, workspaceId]);

  async function run(action: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setOperationError("");
    try {
      await action();
      if (success) setOperationError(success);
      if (workspaceId) await refresh(session.access_token, workspaceId);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The request could not be completed.";
      setOperationError(message.replaceAll("_", " "));
    } finally {
      setBusy(false);
    }
  }

  async function startWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let websiteUrl: string;
    try {
      websiteUrl = canonicalizePublicWebsiteUrl(setupForm.websiteUrl);
      setWebsiteError("");
    } catch (error) {
      setWebsiteError(
        error instanceof WebsiteUrlInputError ? error.message : "Enter a valid company website.",
      );
      return;
    }
    const workspaceName = setupForm.workspaceName.trim();
    const companyName = setupForm.companyName.trim();
    if (!workspaceName || !companyName) {
      setOperationError("Add a workspace and company name to continue.");
      return;
    }
    setBusy(true);
    setOperationError("");
    try {
      let key = window.localStorage.getItem("auterim-onboarding-idempotency-key");
      if (!key) {
        key = crypto.randomUUID();
        window.localStorage.setItem("auterim-onboarding-idempotency-key", key);
      }
      const result = await api("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceName, companyName, websiteUrl, idempotencyKey: key }),
      });
      const started = z
        .object({
          workspaceId: z.string().uuid(),
          discoveryQueued: z.boolean().optional(),
          state: z.string().optional(),
        })
        .parse(result);
      window.localStorage.setItem("auterim-workspace-id", started.workspaceId);
      setSetupForm((current) => ({ ...current, websiteUrl }));
      try {
        await refresh(session.access_token, started.workspaceId);
      } catch {
        setLoadError(true);
        throw new Error("Workspace created. We could not load it yet. Try again to resume setup.");
      }
      window.localStorage.removeItem("auterim-onboarding-idempotency-key");
      setOperationError(
        started.discoveryQueued
          ? "Workspace saved. Auterim is checking public signals from your company website."
          : started.state === "discovery_running"
            ? "Workspace saved. Discovery is already in progress."
            : started.state === "company_created"
              ? "Workspace saved. Start public discovery to continue."
              : "Workspace saved. Discovery results are ready to review.",
      );
    } catch (error) {
      const value = error instanceof Error ? error.message : "Workspace setup failed.";
      setOperationError(value.replaceAll("_", " "));
    } finally {
      setBusy(false);
    }
  }

  if (!onboarding)
    return (
      <div className="first-workspace">
        <p className="eyebrow">FIRST WORKSPACE SETUP</p>
        <h1>Start with the company you want to protect.</h1>
        <p className="hero-copy">
          Auterim will check public signals and suggest dependencies. You decide what to protect.
        </p>
        <div className="onboarding-progress" aria-label="Setup progress">
          {["Company", "Dependencies", "Preferences", "Protect"].map((label, index) => (
            <div className={`onboarding-step${index === 0 ? " is-current" : ""}`} key={label}>
              <span>{index + 1}</span>
              {label}
            </div>
          ))}
        </div>
        <form className="onboarding-card" onSubmit={startWorkspace} noValidate>
          <div className="onboarding-fields">
            <label>
              Workspace name
              <input
                name="workspaceName"
                autoComplete="organization"
                maxLength={120}
                value={setupForm.workspaceName}
                onChange={(event) =>
                  setSetupForm((current) => ({ ...current, workspaceName: event.target.value }))
                }
                aria-invalid={!setupForm.workspaceName.trim()}
              />
            </label>
            <label>
              Company name
              <input
                name="companyName"
                autoComplete="organization"
                maxLength={160}
                placeholder="Acme, Inc."
                value={setupForm.companyName}
                onChange={(event) =>
                  setSetupForm((current) => ({ ...current, companyName: event.target.value }))
                }
                aria-invalid={!setupForm.companyName.trim()}
              />
            </label>
            <label className="onboarding-website-row">
              Company website
              <input
                name="websiteUrl"
                type="text"
                inputMode="url"
                autoComplete="url"
                maxLength={2048}
                placeholder="example.com"
                value={setupForm.websiteUrl}
                onChange={(event) => {
                  setSetupForm((current) => ({ ...current, websiteUrl: event.target.value }));
                  setWebsiteError("");
                }}
                aria-invalid={Boolean(websiteError)}
                aria-describedby={websiteError ? "website-error" : undefined}
              />
              {websiteError && (
                <span id="website-error" className="onboarding-field-error" role="alert">
                  {websiteError}
                </span>
              )}
            </label>
          </div>
          <div className="onboarding-activation">
            <p>Sign in as {session.user.email}. Your setup is saved as you go.</p>
            <button type="submit" disabled={busy}>
              {busy ? "Starting public discovery…" : "Discover my stack"}{" "}
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </form>
        {operationError && (
          <p className="onboarding-inline-error" role="status">
            {operationError}
          </p>
        )}
      </div>
    );

  const onboardingStep = resolveOnboardingStep(onboarding);
  const stepIndex = onboardingStepIndex(onboardingStep);
  const canReview = onboardingStep !== "discovery" || onboarding.discovery.status !== null;
  const incomplete =
    onboardingStep === "dependencies"
      ? "dependencies_review"
      : onboardingStep === "context"
        ? "context_setup"
        : onboardingStep === "notifications"
          ? "notifications_setup"
          : "activation";
  const discoverySettled =
    onboarding.discovery.status === "completed" ||
    onboarding.discovery.status === "partial" ||
    onboarding.discovery.status === "failed";
  const unresolvedCandidates = onboarding.discovery.candidates.filter(
    (candidate) => candidate.suggestedStatus === "candidate",
  );

  async function retryDiscovery() {
    const current = onboarding;
    if (!workspaceId || !current?.company.websiteUrl) return;
    await run(async () => {
      const result = await api("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          workspaceName: "Workspace",
          companyName: current.company.name,
          websiteUrl: current.company.websiteUrl,
          idempotencyKey: `onboarding-discovery-retry:${workspaceId}`,
        }),
      });
      const started = z.object({ discoveryQueued: z.boolean().optional() }).parse(result);
      if (!started.discoveryQueued) throw new Error("discovery_retry_unavailable");
    }, "Discovery restarted.");
  }

  async function decide(candidateId: string, decision: "confirmed" | "rejected") {
    if (!workspaceId) return;
    await run(() =>
      api("/api/onboarding/dependencies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "decision", workspaceId, candidateId, decision }),
      }),
    );
  }
  async function saveContext(dependency: OnboardingReadModel["confirmedDependencies"][number]) {
    if (!workspaceId) return;
    const context = localContext[dependency.workspaceDependencyId] ?? {
      criticality: dependency.criticality,
      productionCritical: dependency.productionCritical,
      usedFor: dependency.usedFor,
      contextNote: dependency.contextNote,
    };
    await run(() =>
      api(`/api/onboarding/dependencies/${dependency.workspaceDependencyId}/context`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, ...context }),
      }),
    );
  }
  async function finishStep(step: "dependencies_review" | "context_setup" | "notifications_setup") {
    if (!workspaceId) return;
    await run(() =>
      api("/api/onboarding/steps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, step }),
      }),
    );
  }
  async function savePreferences() {
    if (!workspaceId) return;
    await run(async () => {
      await api("/api/onboarding/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, ...notificationPreferences }),
      });
      await api("/api/onboarding/steps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, step: "notifications_setup" }),
      });
    });
  }
  async function activate() {
    if (!workspaceId) return;
    await run(async () => {
      await api("/api/onboarding/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      await refresh(session.access_token, workspaceId);
      notifyWorkspaceUpdated();
      router.push("/app");
    }, "Protection is active.");
  }

  if (onboardingStep === "discovery")
    return (
      <main className="first-workspace onboarding-scan-shell">
        <p className="eyebrow">STEP 2 OF 4 · DISCOVERING DEPENDENCIES</p>
        <section className="onboarding-card onboarding-scan-card" aria-live="polite">
          <span className="scan-orbit" aria-hidden="true">
            <span />
          </span>
          <p className="card-kicker">SCANNING YOUR STACK</p>
          <h1>Checking public signals for {onboarding.company.name}.</h1>
          <p>
            Auterim is looking at public company website signals to suggest software dependencies.
            Suggestions stay private to your workspace and won’t be protected unless you confirm
            them.
          </p>
          <p className="onboarding-scan-domain">{onboarding.company.websiteUrl}</p>
          <p className="onboarding-status" role="status">
            {onboarding.discovery.status === "running"
              ? "Discovery is in progress. This screen updates automatically."
              : onboarding.currentStep === "company_created"
                ? "Your workspace is saved. Start a public scan to find possible dependencies."
                : "Discovery has been dispatched. Waiting for the first scan result."}
          </p>
          {operationError && (
            <p className="onboarding-inline-error" role="alert">
              {operationError}
            </p>
          )}
          <div className="onboarding-activation">
            <p>You can leave and resume setup at any time.</p>
            {onboarding.currentStep === "company_created" &&
              onboarding.discovery.status === null &&
              canManageWorkspace && (
                <button type="button" disabled={busy} onClick={() => void retryDiscovery()}>
                  {busy ? "Starting scan…" : "Start public discovery"}{" "}
                  <span aria-hidden="true">→</span>
                </button>
              )}
            {onboarding.currentStep === "company_created" &&
              onboarding.discovery.status === null &&
              !canManageWorkspace && (
                <p className="onboarding-status" role="status">
                  Ask a workspace owner or admin to start the public scan.
                </p>
              )}
          </div>
        </section>
      </main>
    );

  return (
    <div className="first-workspace">
      <p className="eyebrow">COMPANY PROTECTION SETUP</p>
      <h1>
        {onboarding.activation
          ? "Auterim is watching."
          : "Protect the stack your company depends on."}
      </h1>
      <p className="hero-copy">
        {onboarding.company.name} · {onboarding.company.websiteUrl}
      </p>
      <div className="onboarding-progress" aria-label="Setup progress">
        {["Company", "Dependencies", "Preferences", "Protect"].map((label, index) => (
          <div
            className={`onboarding-step${index === stepIndex ? " is-current" : index < stepIndex ? " is-complete" : ""}`}
            key={label}
          >
            <span>{index < stepIndex ? "✓" : index + 1}</span>
            {label}
          </div>
        ))}
      </div>
      {operationError && (
        <p className="onboarding-status" role="status">
          {operationError}
        </p>
      )}
      {!onboarding.activation &&
        incomplete !== "dependencies_review" &&
        onboarding.discovery.candidates.some(
          (candidate) => candidate.suggestedStatus === "candidate",
        ) && (
          <section className="onboarding-card">
            <p className="card-kicker">NEW PUBLIC SIGNALS</p>
            <h2>Review additional suggestions</h2>
            <p>
              Discovery can finish while you continue setup. These remain suggestions until you
              confirm them.
            </p>
            <div className="onboarding-candidates">
              {onboarding.discovery.candidates
                .filter((candidate) => candidate.suggestedStatus === "candidate")
                .map((candidate) => (
                  <article className="onboarding-candidate" key={candidate.candidateId}>
                    <div>
                      <h3>{candidate.providerName}</h3>
                      <p>{summarizeCandidateEvidence(candidate.evidenceSummary)}</p>
                      <div className="onboarding-candidate-meta">
                        <span>{candidate.category}</span>
                        <span>{candidate.confidenceLabel} confidence</span>
                      </div>
                    </div>
                    <div className="onboarding-candidate-actions">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void decide(candidate.candidateId, "confirmed")}
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void decide(candidate.candidateId, "rejected")}
                      >
                        Not used
                      </button>
                    </div>
                  </article>
                ))}
            </div>
          </section>
        )}
      {!onboarding.activation && incomplete === "dependencies_review" && (
        <section className="onboarding-card">
          <p className="card-kicker">STEP 1 · REVIEW YOUR STACK</p>
          <h2>Suggested dependencies</h2>
          <p>
            These suggestions come from public website signals. Confirm only services your company
            actually depends on.
          </p>
          {onboarding.discovery.status === "running" && (
            <p className="onboarding-status" role="status">
              Discovery is still checking public signals. This page updates automatically; you can
              also add a known dependency below.
            </p>
          )}
          {onboarding.discovery.status === null && !canReview && (
            <p className="onboarding-status" role="status">
              Auterim is starting public discovery. This page will update when the results are
              ready.
            </p>
          )}
          {onboarding.discovery.status === "failed" && (
            <div className="onboarding-status" role="status">
              <p>Website discovery did not finish. You can retry or add dependencies manually.</p>
              <button
                type="button"
                className="secondary-link"
                disabled={busy}
                onClick={() => void retryDiscovery()}
              >
                Retry website scan
              </button>
            </div>
          )}
          {onboarding.discovery.status === "partial" && (
            <p className="onboarding-status" role="status">
              Auterim inspected the public signals available within its scan limits.
            </p>
          )}
          {onboarding.discovery.status === "partial" &&
            onboarding.discovery.candidates.length === 0 && (
              <p className="onboarding-status">
                No dependencies were identified from the available public signals. Add the services
                your company uses below.
              </p>
            )}
          {onboarding.discovery.status === "completed" &&
            onboarding.discovery.candidates.length === 0 && (
              <p className="onboarding-status">
                No dependencies were identified from public signals. Add the services your company
                uses below.
              </p>
            )}
          <div className="onboarding-candidates">
            {onboarding.discovery.candidates.map((candidate) => (
              <article className="onboarding-candidate" key={candidate.candidateId}>
                <div>
                  <h3>{candidate.providerName}</h3>
                  <p>{summarizeCandidateEvidence(candidate.evidenceSummary)}</p>
                  <div className="onboarding-candidate-meta">
                    <span>{candidate.category}</span>
                    <span>{candidate.confidenceLabel} confidence</span>
                    <span>
                      {candidate.suggestedStatus === "confirmed"
                        ? "Confirmed by you"
                        : candidate.suggestedStatus === "rejected"
                          ? "Marked not used"
                          : "Suggestion · not protected"}
                    </span>
                  </div>
                </div>
                <div className="onboarding-candidate-actions">
                  {candidate.suggestedStatus === "candidate" && (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void decide(candidate.candidateId, "confirmed")}
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void decide(candidate.candidateId, "rejected")}
                      >
                        Not used
                      </button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
          <div className="onboarding-manual-add">
            <label htmlFor="dependency-search">Add a dependency you already know</label>
            <input
              id="dependency-search"
              value={catalogQuery}
              onChange={(event) => setCatalogQuery(event.target.value)}
              placeholder="Search services, e.g. OpenAI"
              autoComplete="off"
            />
            <p className="summary-note">
              Catalog entries can be added even when monitoring coverage is pending. Unknown
              services are not silently added.
            </p>
            <div className="onboarding-candidates">
              {catalogQuery.trim() &&
                catalog.map((item) => (
                  <article className="onboarding-candidate" key={item.id}>
                    <div>
                      <h4>{item.name}</h4>
                      <p>
                        {item.categoryLabel} ·{" "}
                        {item.coverageStatus === "strong_coverage"
                          ? "strong source coverage"
                          : item.coverageStatus === "partial_coverage"
                            ? "partial source coverage"
                            : "coverage pending"}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          api("/api/onboarding/dependencies", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({
                              action: "manual_add",
                              workspaceId,
                              dependencySlug: item.slug,
                            }),
                          }),
                        )
                      }
                    >
                      Add
                    </button>
                  </article>
                ))}
              {catalogQuery.trim() &&
                catalogSearchCompletedQuery === catalogQuery.trim() &&
                catalog.length === 0 && (
                  <p className="summary-note" role="status">
                    No catalog match. Custom dependencies cannot be added yet.
                  </p>
                )}
            </div>
          </div>
          <div className="onboarding-review-summary">
            <div>
              <strong>{onboarding.confirmedDependencies.length}</strong>
              <span>confirmed dependencies</span>
            </div>
            <div>
              <strong>{onboarding.coveragePreview.authoritativeSourcesAvailable}</strong>
              <span>authoritative sources available</span>
            </div>
          </div>
          <div className="onboarding-activation">
            <p>Only confirmed and manually added services become protected.</p>
            <button
              type="button"
              disabled={busy || !canReview || !onboarding.confirmedDependencies.length}
              onClick={() => void finishStep("dependencies_review")}
            >
              {busy ? "Saving…" : "Continue"} <span aria-hidden="true">→</span>
            </button>
          </div>
        </section>
      )}
      {!onboarding.activation && incomplete === "context_setup" && (
        <section className="onboarding-card">
          <p className="card-kicker">STEP 3 · PREFERENCES</p>
          <h2>What matters most?</h2>
          <p>
            Optional context helps Auterim explain how a verified change may affect your business.
          </p>
          <div className="onboarding-candidates">
            {onboarding.confirmedDependencies.map((dependency) => {
              const context = localContext[dependency.workspaceDependencyId] ?? {
                criticality: dependency.criticality,
                productionCritical: dependency.productionCritical,
                usedFor: dependency.usedFor,
                contextNote: dependency.contextNote,
              };
              return (
                <article className="onboarding-candidate" key={dependency.workspaceDependencyId}>
                  <div>
                    <h3>{dependency.providerName}</h3>
                    <p>
                      {dependency.origin === "manual" ? "Added by you" : "Confirmed from discovery"}
                    </p>
                    <div className="onboarding-fields">
                      <label>
                        Criticality
                        <select
                          value={context.criticality}
                          onChange={(event) =>
                            setLocalContext((all) => ({
                              ...all,
                              [dependency.workspaceDependencyId]: {
                                ...context,
                                criticality: event.target.value as typeof context.criticality,
                              },
                            }))
                          }
                        >
                          <option value="normal">Normal</option>
                          <option value="important">Important</option>
                          <option value="critical">Critical</option>
                        </select>
                      </label>
                      <label>
                        <span>Production critical</span>
                        <select
                          value={String(context.productionCritical)}
                          onChange={(event) =>
                            setLocalContext((all) => ({
                              ...all,
                              [dependency.workspaceDependencyId]: {
                                ...context,
                                productionCritical: event.target.value === "true",
                              },
                            }))
                          }
                        >
                          <option value="false">No</option>
                          <option value="true">Yes</option>
                        </select>
                      </label>
                      <label className="onboarding-website-row">
                        Used for (optional)
                        <select
                          multiple
                          value={context.usedFor}
                          onChange={(event) =>
                            setLocalContext((all) => ({
                              ...all,
                              [dependency.workspaceDependencyId]: {
                                ...context,
                                usedFor: Array.from(
                                  event.target.selectedOptions,
                                  (option) => option.value,
                                ),
                              },
                            }))
                          }
                        >
                          {usageOptions.map((usage) => (
                            <option value={usage} key={usage}>
                              {usage}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="onboarding-website-row">
                        Context note (optional)
                        <textarea
                          value={context.contextNote}
                          maxLength={2000}
                          onChange={(event) =>
                            setLocalContext((all) => ({
                              ...all,
                              [dependency.workspaceDependencyId]: {
                                ...context,
                                contextNote: event.target.value,
                              },
                            }))
                          }
                        />
                      </label>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void saveContext(dependency)}
                    >
                      Save context
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          <div className="onboarding-activation">
            <p>You can leave detailed context blank and update it later.</p>
            <button type="button" disabled={busy} onClick={() => void finishStep("context_setup")}>
              Continue <span aria-hidden="true">→</span>
            </button>
          </div>
        </section>
      )}
      {!onboarding.activation && incomplete === "notifications_setup" && (
        <section className="onboarding-card">
          <p className="card-kicker">STEP 3 · PREFERENCES</p>
          <h2>Choose what reaches you</h2>
          <p>
            Critical changes are always instant. These preferences are saved now; delivery can be
            connected later.
          </p>
          <div className="onboarding-fields">
            <label>
              Important changes
              <select
                value={notificationPreferences.importantChanges}
                onChange={(event) =>
                  setPreferences((current) => ({
                    ...notificationPreferences,
                    ...current,
                    importantChanges: event.target
                      .value as typeof notificationPreferences.importantChanges,
                  }))
                }
              >
                <option value="instant">Instant</option>
                <option value="daily_digest">Daily digest</option>
                <option value="off">Off</option>
              </select>
            </label>
            <label>
              Informational updates
              <select
                value={notificationPreferences.informational}
                onChange={(event) =>
                  setPreferences((current) => ({
                    ...notificationPreferences,
                    ...current,
                    informational: event.target
                      .value as typeof notificationPreferences.informational,
                  }))
                }
              >
                <option value="off">Off</option>
                <option value="digest">Digest</option>
              </select>
            </label>
            <label>
              Monthly protection report
              <select
                value={String(notificationPreferences.monthlyProtectionReport)}
                onChange={(event) =>
                  setPreferences((current) => ({
                    ...notificationPreferences,
                    ...current,
                    monthlyProtectionReport: event.target.value === "true",
                  }))
                }
              >
                <option value="true">On</option>
                <option value="false">Off</option>
              </select>
            </label>
          </div>
          <div className="onboarding-activation">
            <p>No email is sent as part of setup.</p>
            <button type="button" disabled={busy} onClick={() => void savePreferences()}>
              Save and continue <span aria-hidden="true">→</span>
            </button>
          </div>
        </section>
      )}
      {onboarding.activation && (
        <section className="onboarding-card">
          <p className="card-kicker">PROTECTION ACTIVE</p>
          <h2>Auterim is watching.</h2>
          <div className="onboarding-review-summary">
            <div>
              <strong>{onboarding.coveragePreview.dependenciesConfirmed}</strong>
              <span>dependencies</span>
            </div>
            <div>
              <strong>{onboarding.coveragePreview.authoritativeSourcesAvailable}</strong>
              <span>authoritative sources</span>
            </div>
            <div>
              <strong>{onboarding.coveragePreview.criticalDependencies}</strong>
              <span>critical dependencies</span>
            </div>
          </div>
          <p>
            Baseline status: {onboarding.activation.baselineStatus.replaceAll("_", " ")}. Your
            five-day Pro trial begins after protection is activated.
          </p>
          <div className="onboarding-activation">
            <Link className="primary-link" href="/app">
              Go to dashboard <span aria-hidden="true">→</span>
            </Link>
          </div>
        </section>
      )}
      {!onboarding.activation && incomplete === "activation" && (
        <section className="onboarding-card">
          <p className="card-kicker">READY TO PROTECT</p>
          <h2>Review your coverage</h2>
          <p>
            Protection starts the five-day Pro trial and makes eligible global sources available for
            baseline monitoring.
          </p>
          {!discoverySettled && (
            <p className="onboarding-status" role="status">
              Discovery is still running. You can finish setup now; activation will be available
              when all suggestions are ready to review.
            </p>
          )}
          <div className="onboarding-review-summary">
            <div>
              <strong>{onboarding.coveragePreview.dependenciesConfirmed}</strong>
              <span>confirmed dependencies</span>
            </div>
            <div>
              <strong>{onboarding.coveragePreview.authoritativeSourcesAvailable}</strong>
              <span>authoritative sources</span>
            </div>
            <div>
              <strong>{onboarding.coveragePreview.criticalDependencies}</strong>
              <span>critical dependencies</span>
            </div>
          </div>
          <div className="onboarding-activation">
            <p>
              {unresolvedCandidates.length
                ? `Review or dismiss ${unresolvedCandidates.length} remaining suggestion${unresolvedCandidates.length === 1 ? "" : "s"} before activation.`
                : "Activate only the dependencies your team has confirmed."}
            </p>
            {!canManageWorkspace && (
              <p className="onboarding-status" role="status">
                A workspace owner or admin must start protection.
              </p>
            )}
            <button
              type="button"
              disabled={
                busy ||
                !canManageWorkspace ||
                !onboarding.confirmedDependencies.length ||
                !discoverySettled ||
                unresolvedCandidates.length > 0
              }
              onClick={() => void activate()}
            >
              {busy ? "Activating…" : "Activate protection"} <span aria-hidden="true">→</span>
            </button>
          </div>
        </section>
      )}
      <p className="account-step-note">
        Your progress is saved to this workspace. You can leave and resume later.
      </p>
    </div>
  );
}

export function AccountPanel({
  initialWebsiteUrl = "",
  onboardingMode = false,
}: {
  initialWebsiteUrl?: string;
  onboardingMode?: boolean;
}) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [account, setAccount] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [showProductProtection, setShowProductProtection] = useState(false);
  const [setupForm, setSetupForm] = useState(() => createInitialSetupForm(initialWebsiteUrl));
  const loadSequence = useRef(createRequestSequence());
  const authEventReceived = useRef(false);
  const currentUserId = useRef<string | null>(null);

  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      if (!session?.access_token) throw new Error("Sign in to continue.");
      const response = await fetchAccountWithTimeout(path, {
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
    const request = loadSequence.current.begin();
    const isCurrent = () => loadSequence.current.isCurrent(request);
    try {
      const headers = { authorization: `Bearer ${token}` };
      const listResponse = await fetchAccountWithTimeout("/api/account/status", { headers });
      const listBody = await listResponse.json();
      if (!isCurrent()) return;
      if (!listResponse.ok) throw new Error("Could not load your workspaces.");
      const membershipOptions = z
        .array(
          z.object({
            workspace_id: z.string().uuid(),
            workspace_name: z.string(),
            role: z.string(),
          }),
        )
        .parse(listBody.workspaces ?? []);
      const rawOptions = await Promise.all(
        membershipOptions.map(async (item) => {
          try {
            const workspaceResponse = await fetchAccountWithTimeout(
              `/api/account/status?workspaceId=${encodeURIComponent(item.workspace_id)}`,
              { headers },
            );
            const workspaceBody = await workspaceResponse.json();
            const workspace = accountSchema.parse(workspaceBody);
            return {
              workspaceId: item.workspace_id,
              role: item.role,
              name: item.workspace_name,
              active: Boolean(workspace.onboarding.activation?.activatedAt),
            };
          } catch {
            return {
              workspaceId: item.workspace_id,
              role: item.role,
              name: item.workspace_name,
              active: false,
            };
          }
        }),
      );
      const options = normalizeWorkspaceOptions(rawOptions);
      if (!isCurrent()) return;
      if (!options.length) {
        setWorkspaces([]);
        setWorkspaceId("");
        setAccount(null);
        setLoadError(false);
        return;
      }
      const stored = selected ?? window.localStorage.getItem("auterim-workspace-id");
      const target = resolveSelectedWorkspaceId(options, stored);
      const response = await fetchAccountWithTimeout(
        `/api/account/status?workspaceId=${encodeURIComponent(target)}`,
        { headers },
      );
      const body = await response.json();
      if (!isCurrent()) return;
      if (!response.ok) throw new Error("Could not load workspace protection.");
      const nextAccount = accountSchema.parse(body);
      if (!nextAccount.onboarding.activation) {
        const parsedOnboarding = onboardingReadModelSchema.safeParse(nextAccount.onboarding);
        if (!parsedOnboarding.success) {
          throw new Error(
            "Workspace setup could not be verified. Your saved progress is preserved.",
          );
        }
      }
      if (!isCurrent()) return;
      setWorkspaces(options);
      setWorkspaceId(target);
      setAccount(nextAccount);
      window.localStorage.setItem("auterim-workspace-id", target);
      window.localStorage.removeItem("auterim-onboarding-idempotency-key");
      setLoadError(false);
      if (selected) notifyWorkspaceUpdated();
    } catch (error) {
      if (!isCurrent()) return;
      throw error;
    }
  }, []);

  useEffect(() => {
    const client = createSupabaseBrowserClient();
    void withAccountTimeout(client.auth.getSession())
      .then(({ data }) => {
        if (authEventReceived.current) return;
        currentUserId.current = data.session?.user.id ?? null;
        setSession(data.session);
        if (data.session) return load(data.session.access_token);
      })
      .catch(() => {
        if (!authEventReceived.current) {
          setLoadError(true);
          setMessage("Could not check your sign-in state.");
        }
      })
      .finally(() => setLoading(false));
    const { data: listener } = client.auth.onAuthStateChange((_event, nextSession) => {
      authEventReceived.current = true;
      const nextUserId = nextSession?.user.id ?? null;
      if (currentUserId.current !== nextUserId) {
        loadSequence.current.invalidate();
        setAccount(null);
        setWorkspaces([]);
        setWorkspaceId("");
      }
      currentUserId.current = nextUserId;
      setSession(nextSession);
      if (nextSession)
        void load(nextSession.access_token).catch(() => {
          if (currentUserId.current === nextSession.user.id) {
            setLoadError(true);
            setMessage("Could not load your workspace.");
          }
        });
      else {
        loadSequence.current.invalidate();
        setLoadError(false);
      }
    });
    return () => listener.subscription.unsubscribe();
  }, [load]);

  useEffect(() => {
    if (onboardingMode && account?.onboarding.activation) router.replace("/app");
  }, [account?.onboarding.activation, onboardingMode, router]);

  async function signOut() {
    setBusy(true);
    await createSupabaseBrowserClient().auth.signOut();
    loadSequence.current.invalidate();
    currentUserId.current = null;
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
        <Link className="wordmark" href={onboardingMode ? "/app/onboarding" : "/"}>
          <span className="brand-mark">A</span>auterim
        </Link>
        <div className="account-nav">
          <span>{session.user.email}</span>
          <button className="text-button" type="button" onClick={signOut} disabled={busy}>
            Sign out
          </button>
        </div>
      </header>
      <section className={`product-content${onboardingMode ? " onboarding-product-content" : ""}`}>
        <p className="eyebrow">
          <span className="status-dot" />{" "}
          {onboardingMode ? "Workspace setup" : "Account &amp; protection"}
        </p>
        {account?.onboarding.currentStep === "active" && (
          <h1>Your workspace, protected with context.</h1>
        )}
        {message && account?.onboarding.currentStep === "active" && (
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
        {!loadError && session && !workspaces.length && (
          <FirstWorkspaceOnboarding
            session={session}
            workspaceId={workspaceId}
            onboarding={
              account
                ? (onboardingReadModelSchema.safeParse(account.onboarding).data ?? null)
                : null
            }
            setupForm={setupForm}
            setSetupForm={setSetupForm}
            api={api}
            refresh={load}
            busy={busy}
            setBusy={setBusy}
            setLoadError={setLoadError}
            canManageWorkspace={account?.role === "owner" || account?.role === "admin"}
          />
        )}
        {!loadError && session && account && !account.onboarding.activation && workspaceId && (
          <OnboardingV2Panel
            workspaceId={workspaceId}
            api={api}
            canManageProducts={account.role === "owner" || account.role === "admin"}
            onActivated={async () => {
              await load(session.access_token, workspaceId);
              notifyWorkspaceUpdated();
              router.push("/app");
            }}
          />
        )}
        {shouldShowWorkspaceSelector({
          workspaceCount: workspaces.length,
        }) && (
          <label className="workspace-select">
            {onboardingMode ? "Company" : "Workspace"}
            <select
              value={workspaceId}
              onChange={(event) => void load(session.access_token, event.target.value)}
            >
              {workspaces.map((item) => (
                <option key={item.workspaceId} value={item.workspaceId}>
                  {item.selectorLabel} · {item.role}
                </option>
              ))}
            </select>
          </label>
        )}
        {!loadError && session && account && workspaceId && (
          <WorkspaceMembersPanel workspaceId={workspaceId} role={account.role} api={api} />
        )}
        {account?.onboarding.activation && (
          <>
            <div className="account-summary">
              <div>
                <span className="summary-label">Company</span>
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
                  {account.initialAssessment.dependenciesConfirmed} dependencies ·{" "}
                  {account.initialAssessment.authoritativeSourcesAvailable} authoritative sources ·{" "}
                  {account.initialAssessment.snapshotsObservedAtActivation} shared snapshots
                  observed at activation
                </p>
                <p>
                  {account.initialAssessment.materialChangesEvaluated} material changes evaluated ·{" "}
                  {account.initialAssessment.relevantChanges} relevant ·{" "}
                  {account.initialAssessment.verifiedRepositoryExposures} verified repository
                  exposures · {account.initialAssessment.remediationsAvailable} remediations
                  available
                </p>
              </section>
            )}
            <p className="account-step-note">
              Your protection is active. Changes already confirmed in onboarding remain attached to
              this workspace.
            </p>
            {showProductProtection ? (
              <>
                <button
                  className="secondary-link"
                  type="button"
                  onClick={() => setShowProductProtection(false)}
                >
                  Close Product protection
                </button>
                <OnboardingV2Panel
                  workspaceId={workspaceId}
                  api={api}
                  allowProductCreate={account.role === "owner" || account.role === "admin"}
                  canManageProducts={account.role === "owner" || account.role === "admin"}
                  onActivated={async () => {
                    await load(session.access_token, workspaceId);
                    notifyWorkspaceUpdated();
                  }}
                />
              </>
            ) : (
              (account.role === "owner" || account.role === "admin") && (
                <button
                  className="secondary-link"
                  type="button"
                  onClick={() => setShowProductProtection(true)}
                >
                  Add or view Product protection
                </button>
              )
            )}
          </>
        )}
        {!onboardingMode && (
          <Link className="back-link" href="/">
            ← Back to Auterim
          </Link>
        )}
      </section>
    </main>
  );
}
