"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProductApp } from "./app-shell";
import { WorkspaceMembersPanel } from "./workspace-members-panel";
import { getDashboardHealthPresentation } from "@/lib/protection/dashboard-health";
import {
  createGitHubConnectAction,
  getGitHubConnectErrorMessage,
  getGitHubConnectPresentation,
} from "@/lib/app/github-connect";

type Protection = {
  status?: string;
  protection?: Record<string, unknown>;
  protectionSummary?: Record<string, unknown>;
  upcomingDeadlines?: Array<Record<string, unknown>>;
  recentRelevantChanges?: Change[];
  pendingActions?: Array<Record<string, unknown>>;
  initialAssessment?: Record<string, unknown> | null;
};
type Dependency = {
  id: string;
  dependencyId: string;
  provider?: { name?: string; category?: string; slug?: string } | null;
  origin?: string;
  criticality?: string;
  productionCritical?: boolean;
  usedFor?: string[];
  authoritativeSources?: number;
  sourcesWithBaseline?: number;
  latestMaterialChange?: { relevant?: boolean; severity?: string; assessedAt?: string } | null;
  lastCheckedAt?: string | null;
  protectionState?: string;
  createdAt?: string;
  sourceCount?: number;
};
type Change = {
  id: string;
  dependency?: {
    dependency_id?: string;
    dependency_catalog?: { name?: string; category?: string };
  } | null;
  source?: { name?: string; source_type?: string; url?: string } | null;
  change?: {
    summary?: string;
    category?: string;
    detectedAt?: string | null;
    material?: boolean;
  } | null;
  customerImpact?: {
    relevant?: boolean;
    severity?: string;
    summary?: string;
    whyItMatters?: string;
    recommendedAction?: string;
    actionRequired?: boolean;
  } | null;
  preflight?: {
    verifiedImpact?: string;
    deadline?: string | null;
    effectiveAt?: string | null;
  } | null;
  assessedAt?: string;
};
type Action = {
  id: string;
  type?: string;
  priority?: string;
  recommendedAction?: string;
  relatedImpactAssessmentId?: string;
  createdAt?: string;
  eligibility?: string;
  blockedReason?: string;
};
type PageKind =
  | "today"
  | "dependencies"
  | "dependency"
  | "changes"
  | "change"
  | "actions"
  | "notifications"
  | "settings";
const title: Record<PageKind, string> = {
  today: "Today",
  dependencies: "Dependencies",
  dependency: "Dependency detail",
  changes: "Changes",
  change: "Change detail",
  actions: "Actions",
  notifications: "Notifications",
  settings: "Settings",
};
const date = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value))
    : "Not available";
const messageFor = (value: unknown) =>
  value instanceof Error ? value.message.replaceAll("_", " ") : "Something went wrong. Try again.";

function useLoad<T>(path: string | null) {
  const { api, workspaceId } = useProductApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [dataScope, setDataScope] = useState("");
  const requestId = useRef(0);
  const scope = `${path ?? ""}:${workspaceId}`;
  const load = useCallback(async () => {
    const currentRequestId = ++requestId.current;
    if (!path || !workspaceId) {
      setData(null);
      setError("");
      setDataScope(scope);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    setData(null);
    setDataScope("");
    try {
      const result = await api<T>(
        `${path}${path.includes("?") ? "&" : "?"}workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      if (requestId.current === currentRequestId) {
        setData(result);
        setDataScope(scope);
      }
    } catch (reason) {
      if (requestId.current === currentRequestId) {
        setError(messageFor(reason));
        setDataScope(scope);
      }
    } finally {
      if (requestId.current === currentRequestId) setLoading(false);
    }
  }, [api, path, scope, workspaceId]);
  useEffect(() => {
    queueMicrotask(() => void load());
    return () => {
      requestId.current += 1;
    };
  }, [load]);
  return {
    data: dataScope === scope ? data : null,
    error: dataScope === scope ? error : "",
    loading: loading || dataScope !== scope,
    reload: load,
  };
}

function PageHeading({
  kind,
  eyebrow,
  subtitle,
  action,
}: {
  kind: PageKind;
  eyebrow?: string;
  subtitle: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow ?? "AUTERIM / PROTECTION"}</p>
        <h1>{title[kind]}</h1>
        <p className="page-subtitle">{subtitle}</p>
      </div>
      {action}
    </div>
  );
}
function ErrorState({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="inline-error" role="alert">
      <span>{error}</span>
      <button className="button-secondary" onClick={retry}>
        Retry
      </button>
    </div>
  );
}
function LoadingRows() {
  return (
    <div className="loading-card" aria-label="Loading">
      <span />
      <span />
      <span />
    </div>
  );
}
function Severity({ value }: { value?: string }) {
  return (
    <span className={`severity severity-${(value ?? "normal").toLowerCase()}`}>
      {value ?? "Informational"}
    </span>
  );
}
function HealthLabel({ value }: { value?: string }) {
  const presentation = getDashboardHealthPresentation(value);
  return (
    <span
      className={`health-label ${value === "attention_required" ? "health-attention" : ""}`}
      title={presentation.explanation}
    >
      <i />
      {presentation.label}
    </span>
  );
}
function Metric({ value, label, detail }: { value: unknown; label: string; detail?: string }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>
        {typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "—"}
      </strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

export function DashboardPage({ kind, id }: { kind: PageKind; id?: string }) {
  const { workspace, workspaceId, api } = useProductApp();
  const protection = useLoad<Protection>(kind === "today" ? "/api/protection?view=today" : null);
  const dependencies = useLoad<{ items: Dependency[]; total?: number }>(
    kind === "dependencies" ? "/api/protection?view=dependencies" : null,
  );
  const changes = useLoad<{ items: Change[] }>(
    kind === "changes" ? "/api/protection?view=changes" : null,
  );
  const actions = useLoad<{ items: Action[] }>(
    kind === "actions" ? "/api/protection?view=actions" : null,
  );
  const detail = useLoad<{ item: Dependency | Change }>(
    kind === "dependency" && id
      ? `/api/protection/dependencies/${encodeURIComponent(id)}`
      : kind === "change" && id
        ? `/api/protection/changes/${encodeURIComponent(id)}`
        : null,
  );
  const notifications = useLoad<{ items: Array<Record<string, unknown>>; unreadCount: number }>(
    kind === "notifications" ? "/api/notifications?limit=50" : null,
  );
  const connectors = useLoad<{ items: Array<Record<string, unknown>> }>(
    kind === "settings" ? "/api/connectors" : null,
  );
  const accountStatus = useLoad<{
    role?: string;
    entitlements?: {
      capabilities?: { repositoryConnections?: boolean };
      usage?: { repositories?: number };
      limits?: { repositories?: number };
    };
  }>(kind === "settings" ? "/api/account/status" : null);
  const [preference, setPreference] = useState<Record<string, unknown> | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [githubConnecting, setGithubConnecting] = useState(false);
  const githubConnectPending = useRef(false);
  const [filters, setFilters] = useState("all");
  const reloadConnectors = connectors.reload;
  const reloadAccountStatus = accountStatus.reload;

  useEffect(() => {
    if (kind !== "settings") return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("github");
    const messages: Record<string, string> = {
      connected: "GitHub is connected. Accessible repositories are ready to review.",
      installation_selection_required:
        "Auterim can’t safely choose between multiple GitHub installations. No installation was connected.",
      installation_identity_mismatch:
        "The GitHub account changed during installation. Start the connection again with the same account.",
      installation_not_authorized:
        "GitHub did not confirm access to that installation. Start the connection again.",
      installation_suspended:
        "This GitHub installation is suspended. Resolve it in GitHub and reconnect.",
      permissions_unavailable:
        "GitHub permissions do not match Auterim’s read-only access requirements.",
      authorization_unavailable:
        "GitHub authorization could not be verified. Try connecting again.",
      connection_failed: "GitHub could not be connected. Try again.",
      temporarily_unavailable: "GitHub connection is temporarily unavailable. Try again shortly.",
      state_expired: "The GitHub connection request expired. Start again from Settings.",
      state_replayed: "That GitHub connection request was already used. Start again from Settings.",
      workspace_access_revoked:
        "Workspace access changed during GitHub authorization. Refresh Settings.",
      pro_required: "GitHub repository verification is available on Pro.",
      invalid_state: "The GitHub connection could not be verified. Start again from Settings.",
      unavailable: "GitHub connection is temporarily unavailable.",
      installation_authorization_required:
        "GitHub installation access needs to be verified. Start again from Settings.",
    };
    if (!status || !(status in messages)) return;
    queueMicrotask(() => {
      setNotice(messages[status]!);
      if (status === "connected") void Promise.all([reloadConnectors(), reloadAccountStatus()]);
    });
    params.delete("github");
    const remainingQuery = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${remainingQuery ? `?${remainingQuery}` : ""}${window.location.hash}`,
    );
  }, [kind, reloadAccountStatus, reloadConnectors]);

  useEffect(() => {
    if (kind !== "settings" || !workspaceId) return;
    void api<{ preferences: Record<string, unknown> }>(
      `/api/notifications/preferences?workspaceId=${encodeURIComponent(workspaceId)}`,
    )
      .then((result) => setPreference(result.preferences))
      .catch(() => setNotice("Notification preferences are temporarily unavailable."));
  }, [api, kind, workspaceId]);

  async function updatePreference(key: string, value: unknown) {
    if (!preference) return;
    const next = { ...preference, [key]: value };
    setPreference(next);
    setBusy(true);
    setNotice("");
    try {
      await api("/api/notifications/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          inAppEnabled: next.in_app_enabled,
          emailEnabled: next.email_enabled,
          ...(key === "slack_enabled" ? { slackEnabled: value } : {}),
        }),
      });
      setNotice("Preferences saved.");
    } catch (error) {
      setNotice(messageFor(error));
    } finally {
      setBusy(false);
    }
  }
  async function connect(provider: string) {
    setBusy(true);
    setNotice("");
    try {
      const result = await api<{ authorizationUrl: string }>("/api/connectors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, provider }),
      });
      window.location.assign(result.authorizationUrl);
    } catch (error) {
      setNotice(messageFor(error));
      setBusy(false);
    }
  }

  const githubConnectAction = useMemo(
    () =>
      createGitHubConnectAction(
        (selectedWorkspaceId) =>
          api<{ authorizationUrl: string }>("/api/repositories/install", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId: selectedWorkspaceId }),
          }),
        (authorizationUrl) => window.location.assign(authorizationUrl),
      ),
    [api],
  );

  async function connectGitHub() {
    if (githubConnectPending.current) return;
    const account = accountStatus.data;
    const github = connectors.data?.items.find((item) => item.provider === "github");
    const capabilities = Array.isArray(github?.capabilities) ? github.capabilities : [];
    const canVerify = capabilities.some(
      (capability) =>
        capability &&
        typeof capability === "object" &&
        "name" in capability &&
        capability.name === "CAN_VERIFY" &&
        "enabled" in capability &&
        capability.enabled === true,
    );
    const presentation = getGitHubConnectPresentation({
      role: account?.role,
      configured: github?.configured === true,
      entitled: account?.entitlements?.capabilities?.repositoryConnections === true && canVerify,
      status: typeof github?.status === "string" ? github.status : undefined,
      busy: githubConnecting,
    });
    if (!presentation.canConnect || !workspaceId || !account) return;

    githubConnectPending.current = true;
    setGithubConnecting(true);
    setNotice("");
    try {
      await githubConnectAction(workspaceId);
    } catch (error) {
      setNotice(getGitHubConnectErrorMessage(error));
    } finally {
      githubConnectPending.current = false;
      setGithubConnecting(false);
    }
  }

  async function disconnect(provider: string, installationId: string) {
    setBusy(true);
    setNotice("");
    try {
      await api(`/api/connectors/${provider}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, installationId }),
      });
      setNotice(`${provider} disconnected.`);
      await connectors.reload();
    } catch (error) {
      setNotice(messageFor(error));
    } finally {
      setBusy(false);
    }
  }
  async function markRead(notificationId?: string) {
    try {
      await api("/api/notifications", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          ...(notificationId ? { notificationId } : { markAllRead: true }),
        }),
      });
      await notifications.reload();
    } catch (error) {
      setNotice(messageFor(error));
    }
  }

  const pageTitle =
    kind === "today"
      ? `Your protection, ${workspace?.name ?? "workspace"}.`
      : `${workspace?.name ?? "Workspace"}`;
  if (kind === "today")
    return (
      <>
        <PageHeading
          kind={kind}
          eyebrow="YOUR PROTECTION / TODAY"
          subtitle="A clear view of what Auterim is watching and what needs your attention."
          action={
            <Link href="/app/dependencies" className="button-primary">
              View dependencies <span>→</span>
            </Link>
          }
        />
        {protection.loading ? (
          <LoadingRows />
        ) : protection.error ? (
          <ErrorState error={protection.error} retry={protection.reload} />
        ) : (
          <>
            <section className="welcome-line">
              <div>
                <h2>{pageTitle}</h2>
                <p>Verified evidence from your protected dependencies.</p>
              </div>
              <span className="workspace-chip">
                <span /> Workspace selected
              </span>
            </section>
            <section className="metric-grid">
              <Metric
                value={protection.data?.protection?.dependenciesProtected}
                label="Protected dependencies"
                detail="Confirmed in this workspace"
              />
              <Metric
                value={protection.data?.protection?.authoritativeSourcesCovered}
                label="Authoritative sources"
                detail="Global monitoring coverage"
              />
              <Metric
                value={protection.data?.protectionSummary?.unresolvedRisks}
                label="Open relevant changes"
                detail="Customer-specific assessments"
              />
              <Metric
                value={protection.data?.upcomingDeadlines?.length ?? 0}
                label="Upcoming deadlines"
                detail="Verified dates where available"
              />
            </section>
            <section className="today-grid">
              <div className="surface-card">
                <div className="section-heading">
                  <div>
                    <p className="card-kicker">REQUIRES ATTENTION</p>
                    <h2>What needs a look</h2>
                  </div>
                  <Link href="/app/actions" className="text-link">
                    All actions →
                  </Link>
                </div>
                {(protection.data?.pendingActions ?? []).length ? (
                  <div className="row-list">
                    {(protection.data?.pendingActions ?? []).slice(0, 5).map((item, index) => {
                      const impactId = String(item.relatedImpactAssessmentId ?? "");
                      return (
                        <Link
                          className="activity-row"
                          key={String(item.id ?? index)}
                          href={impactId ? `/app/changes/${impactId}` : "/app/actions"}
                        >
                          <span className="activity-icon">↗</span>
                          <span className="activity-main">
                            <strong>
                              {String(
                                item.recommendedAction ?? item.type ?? "Review protection action",
                              ).replaceAll("_", " ")}
                            </strong>
                            <small>
                              {String(item.type ?? "Auterim action").replaceAll("_", " ")}
                            </small>
                          </span>
                          <span className="row-arrow">→</span>
                        </Link>
                      );
                    })}
                  </div>
                ) : (
                  <div className="quiet-state">
                    <span className="quiet-check">✓</span>
                    <div>
                      <strong>No open actions right now</strong>
                      <p>
                        Auterim will surface customer-relevant changes when evidence supports them.
                      </p>
                    </div>
                  </div>
                )}
              </div>
              <div className="surface-card deadline-card">
                <div className="section-heading">
                  <div>
                    <p className="card-kicker">DATES TO WATCH</p>
                    <h2>Upcoming deadlines</h2>
                  </div>
                </div>
                {(protection.data?.upcomingDeadlines ?? []).length ? (
                  <div className="row-list">
                    {protection.data!.upcomingDeadlines!.slice(0, 4).map((item, index) => (
                      <Link
                        className="deadline-row"
                        key={String(item.id ?? index)}
                        href="/app/changes"
                      >
                        <span className="date-tile">
                          <strong>
                            {typeof item.daysRemaining === "number" ? item.daysRemaining : "—"}
                          </strong>
                          <small>days</small>
                        </span>
                        <span>
                          <strong>
                            {String(
                              (item.dependency as { name?: string } | null)?.name ??
                                "Dependency deadline",
                            )}
                          </strong>
                          <small>Effective {date(String(item.deadline ?? ""))}</small>
                        </span>
                        <Severity value={String(item.severity ?? "normal")} />
                      </Link>
                    ))}
                  </div>
                ) : (
                  <div className="empty-inline">
                    <span>◷</span>
                    <strong>No upcoming verified deadlines</strong>
                    <small>
                      Deadlines appear here when a monitored change includes an effective date.
                    </small>
                  </div>
                )}
              </div>
            </section>
            <section className="surface-card recent-card">
              <div className="section-heading">
                <div>
                  <p className="card-kicker">RECENT CUSTOMER-RELEVANT CHANGES</p>
                  <h2>Recent changes</h2>
                </div>
                <Link href="/app/changes" className="text-link">
                  View all changes →
                </Link>
              </div>
              <ChangeRows items={protection.data?.recentRelevantChanges ?? []} />
            </section>
          </>
        )}
      </>
    );

  if (kind === "dependencies")
    return (
      <>
        <PageHeading
          kind={kind}
          subtitle="The software your team has confirmed Auterim should protect."
          action={
            <span className="summary-chip">
              {dependencies.data?.total ?? dependencies.data?.items.length ?? "—"} protected
            </span>
          }
        />
        {dependencies.loading ? (
          <LoadingRows />
        ) : dependencies.error ? (
          <ErrorState error={dependencies.error} retry={dependencies.reload} />
        ) : (
          <>
            <div className="health-callout">
              <div className="health-callout-icon">◇</div>
              <div>
                <strong>Dependency health is based on your evidence.</strong>
                <p>
                  Auterim does not report provider uptime. A quiet status means no relevant change
                  was identified in the available monitoring evidence.
                </p>
              </div>
              <span className="unknown-tag">No uptime feed</span>
            </div>
            <div className="dependency-list">
              {dependencies.data?.items.map((dep) => (
                <Link className="dependency-card" href={`/app/dependencies/${dep.id}`} key={dep.id}>
                  <span className="provider-monogram">
                    {(dep.provider?.name ?? "?").slice(0, 1)}
                  </span>
                  <span className="dependency-main">
                    <strong>{dep.provider?.name ?? "Dependency"}</strong>
                    <small>
                      {dep.provider?.category ?? "Software"} · {dep.criticality ?? "normal"}{" "}
                      criticality{dep.productionCritical ? " · production critical" : ""}
                    </small>
                    <span className="tag-row">
                      {(dep.usedFor ?? []).slice(0, 3).map((item) => (
                        <span className="soft-tag" key={item}>
                          {item}
                        </span>
                      ))}
                    </span>
                  </span>
                  <span className="dependency-meta">
                    <HealthLabel value={dep.protectionState} />
                    <small>
                      {dep.sourcesWithBaseline ?? 0} / {dep.authoritativeSources ?? 0} sources have
                      baseline evidence
                    </small>
                  </span>
                  <span className="row-arrow">→</span>
                </Link>
              ))}
              {!dependencies.data?.items.length && (
                <div className="empty-state">
                  <span className="empty-icon">◇</span>
                  <h2>No confirmed dependencies yet</h2>
                  <p>
                    Dependencies discovered from your company URL are suggestions until a workspace
                    member confirms them.
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </>
    );

  if (kind === "dependency") {
    const item = detail.data?.item as
      | (Dependency & {
          sources?: Array<Record<string, unknown>>;
          latestImpact?: Record<string, unknown> | null;
          recentAssessments?: Array<Record<string, unknown>>;
          contextNote?: string;
        })
      | undefined;
    return (
      <>
        {detail.loading ? (
          <LoadingRows />
        ) : detail.error ? (
          <ErrorState error={detail.error} retry={detail.reload} />
        ) : item ? (
          <>
            <Link className="back-crumb" href="/app/dependencies">
              ← Dependencies
            </Link>
            <PageHeading
              kind={kind}
              eyebrow={`${item.provider?.category ?? "DEPENDENCY"} / PROTECTED`}
              subtitle="A customer-specific dossier built from catalog coverage, global source baselines, and assessed changes."
            />
            <div className="dossier-title">
              <span className="provider-monogram large">
                {(item.provider?.name ?? "?").slice(0, 1)}
              </span>
              <div>
                <h2>{item.provider?.name ?? "Dependency"}</h2>
                <p>
                  {item.provider?.slug ?? item.dependencyId} · Added {date(item.createdAt)}
                </p>
              </div>
              <HealthLabel value={item.protectionState} />
            </div>
            <div className="metric-grid three">
              <Metric value={item.sourceCount} label="Authoritative sources" />
              <Metric value={item.sourcesWithBaseline} label="Sources with baseline" />
              <Metric
                value={item.criticality ?? "normal"}
                label="Criticality"
                detail={
                  item.productionCritical ? "Production critical" : "Not marked production critical"
                }
              />
            </div>
            <section className="two-column-content">
              <div className="surface-card">
                <div className="section-heading">
                  <div>
                    <p className="card-kicker">SOURCE COVERAGE</p>
                    <h2>What Auterim monitors</h2>
                  </div>
                </div>
                <div className="row-list">
                  {(item.sources ?? []).map((source) => (
                    <div className="source-row" key={String(source.id)}>
                      <span className="source-type">
                        {String(source.source_type ?? "source").replaceAll("_", " ")}
                      </span>
                      <span>
                        <strong>{String(source.name ?? "Authoritative source")}</strong>
                        <small>{source.url ? String(source.url) : "Source URL unavailable"}</small>
                      </span>
                      <span className="baseline-state">
                        {source.latestBaselineAt
                          ? `Baseline ${date(String(source.latestBaselineAt))}`
                          : "Baseline pending"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="surface-card">
                <p className="card-kicker">YOUR CONTEXT</p>
                <h2>How your team uses it</h2>
                <p>
                  {(item.usedFor ?? []).length
                    ? item.usedFor!.join(", ")
                    : "No usage context supplied yet."}
                </p>
                {item.contextNote && <p className="context-note">{item.contextNote}</p>}
                <p className="muted-copy">
                  Criticality: {item.criticality ?? "normal"}. Context helps Auterim explain
                  possible impact; it does not change source evidence.
                </p>
              </div>
            </section>
            <section className="surface-card">
              <div className="section-heading">
                <div>
                  <p className="card-kicker">ASSESSED EVIDENCE</p>
                  <h2>Recent customer impact</h2>
                </div>
              </div>
              {(item.recentAssessments ?? []).length ? (
                (item.recentAssessments ?? []).map((impact) => (
                  <div className="impact-evidence" key={String(impact.id)}>
                    <Severity value={String(impact.severity ?? "normal")} />
                    <div>
                      <strong>{String(impact.impact_summary ?? "Impact assessment")}</strong>
                      <p>{String(impact.why_it_matters ?? "")}</p>
                    </div>
                    <time>{date(String(impact.assessed_at ?? ""))}</time>
                  </div>
                ))
              ) : (
                <p className="empty-copy">
                  No customer-relevant material change has been assessed for this dependency in the
                  available history.
                </p>
              )}
            </section>
          </>
        ) : null}
      </>
    );
  }

  if (kind === "changes")
    return (
      <>
        <PageHeading
          kind={kind}
          subtitle="Material changes assessed against your confirmed dependencies and usage context."
        />
        <div className="filter-bar" role="group" aria-label="Filter changes">
          {[
            ["all", "All changes"],
            ["relevant", "Customer relevant"],
            ["verified", "Repository verified"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={filters === value ? "filter-active" : ""}
              onClick={() => setFilters(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {changes.loading ? (
          <LoadingRows />
        ) : changes.error ? (
          <ErrorState error={changes.error} retry={changes.reload} />
        ) : (
          <ChangeRows
            items={(changes.data?.items ?? []).filter(
              (change) =>
                filters === "all" ||
                (filters === "relevant" && change.customerImpact?.relevant) ||
                (filters === "verified" &&
                  ["verified", "likely"].includes(change.preflight?.verifiedImpact ?? "")),
            )}
          />
        )}
      </>
    );

  if (kind === "change") {
    const item = detail.data?.item as Change | undefined;
    return (
      <>
        {detail.loading ? (
          <LoadingRows />
        ) : detail.error ? (
          <ErrorState error={detail.error} retry={detail.reload} />
        ) : item ? (
          <>
            <Link className="back-crumb" href="/app/changes">
              ← Changes
            </Link>
            <PageHeading
              kind={kind}
              eyebrow={`ASSESSED ${date(item.assessedAt)}`}
              subtitle="Customer impact is grounded in your confirmed dependency and context."
            />
            <div className="change-detail-head">
              <div>
                <span className="source-type">
                  {item.source?.source_type?.replaceAll("_", " ") ?? "Source change"}
                </span>
                <h2>{item.dependency?.dependency_catalog?.name ?? "Dependency"}</h2>
              </div>
              <Severity value={item.customerImpact?.severity} />
            </div>
            <div className="change-dossier">
              <section className="surface-card">
                <p className="card-kicker">WHAT CHANGED</p>
                <h2>{item.change?.summary ?? "Material change details unavailable"}</h2>
                <p>
                  {item.change?.category?.replaceAll("_", " ") ?? "Change category unavailable"} ·
                  Detected {date(item.change?.detectedAt)}
                </p>
                {item.source?.url && (
                  <a className="text-link" href={item.source.url} target="_blank" rel="noreferrer">
                    View authoritative source ↗
                  </a>
                )}
              </section>
              <section className="surface-card">
                <p className="card-kicker">WHY IT MATTERS</p>
                <h2>{item.customerImpact?.summary ?? "No impact summary available"}</h2>
                <p>
                  {item.customerImpact?.whyItMatters ??
                    "The impact assessment did not include additional explanation."}
                </p>
              </section>
              <section className="surface-card">
                <p className="card-kicker">YOUR IMPACT</p>
                <p>
                  {item.customerImpact?.relevant
                    ? "Auterim assessed this change as relevant to this workspace."
                    : "No customer-specific relevance was identified."}
                </p>
                <small>
                  Confidence is based on available evidence and supplied dependency context.
                </small>
              </section>
              <section className="surface-card">
                <p className="card-kicker">VERIFIED IMPACT</p>
                <h2>
                  {item.preflight?.verifiedImpact
                    ? item.preflight.verifiedImpact.replaceAll("_", " ")
                    : "Not repository-verified"}
                </h2>
                <p>
                  Auterim distinguishes customer impact assessment from repository verification.
                </p>
              </section>
              <section className="surface-card">
                <p className="card-kicker">DEADLINE</p>
                <h2>{date(item.preflight?.deadline ?? item.preflight?.effectiveAt)}</h2>
                <p>
                  {item.preflight?.deadline || item.preflight?.effectiveAt
                    ? "Date supplied by the associated change evidence."
                    : "No effective date or deadline is available."}
                </p>
              </section>
              <section className="surface-card">
                <p className="card-kicker">RECOMMENDED ACTION</p>
                <h2>
                  {item.customerImpact?.recommendedAction ??
                    "Review the source and impact assessment."}
                </h2>
                <Link href="/app/actions" className="button-secondary">
                  Open Actions →
                </Link>
              </section>
            </div>
          </>
        ) : null}
      </>
    );
  }

  if (kind === "actions")
    return (
      <>
        <PageHeading
          kind={kind}
          subtitle="Explicit next steps derived from customer-relevant changes and verified repository evidence."
        />
        {actions.loading ? (
          <LoadingRows />
        ) : actions.error ? (
          <ErrorState error={actions.error} retry={actions.reload} />
        ) : (
          <div className="row-list surface-card">
            {(actions.data?.items ?? []).map((action) => (
              <Link
                className="action-row"
                key={action.id}
                href={
                  action.relatedImpactAssessmentId
                    ? `/app/changes/${action.relatedImpactAssessmentId}`
                    : "/app/dependencies"
                }
              >
                <span className="action-check">↗</span>
                <span className="activity-main">
                  <strong>
                    {action.recommendedAction ??
                      String(action.type ?? "Review protection action").replaceAll("_", " ")}
                  </strong>
                  <small>
                    {String(action.type ?? "Auterim action").replaceAll("_", " ")}
                    {action.eligibility === "blocked"
                      ? ` · ${String(action.blockedReason ?? "requires plan access").replaceAll("_", " ")}`
                      : ""}
                  </small>
                </span>
                <Severity value={action.priority} />
                <span className="row-arrow">→</span>
              </Link>
            ))}
            {!actions.data?.items.length && (
              <div className="quiet-state">
                <span className="quiet-check">✓</span>
                <div>
                  <strong>No actions currently require review</strong>
                  <p>
                    Auterim will add actions when relevant evidence or a verified risk is available.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </>
    );

  if (kind === "notifications")
    return (
      <>
        <PageHeading
          kind={kind}
          subtitle="High-signal updates about relevant changes and protection activity."
          action={
            (notifications.data?.unreadCount ?? 0) > 0 ? (
              <button className="button-secondary" onClick={() => void markRead()}>
                Mark all read
              </button>
            ) : null
          }
        />
        {notice && (
          <div className="success-note" role="status">
            {notice}
          </div>
        )}
        {notifications.loading ? (
          <LoadingRows />
        ) : notifications.error ? (
          <ErrorState error={notifications.error} retry={notifications.reload} />
        ) : (
          <div className="notification-list surface-card">
            {(notifications.data?.items ?? []).map((notification) => {
              const id = String(notification.id);
              const impactId = String(notification.related_impact_assessment_id ?? "");
              return (
                <article
                  className={`notification-row${notification.read_at ? " is-read" : ""}`}
                  key={id}
                >
                  <span className="notification-mark">{notification.read_at ? "·" : "●"}</span>
                  <div className="notification-copy">
                    <div className="notification-title-row">
                      <strong>{String(notification.title)}</strong>
                      <Severity value={String(notification.priority ?? "normal")} />
                    </div>
                    <p>{String(notification.summary)}</p>
                    <small>
                      {date(String(notification.created_at))} ·{" "}
                      {String(notification.notification_type).replaceAll("_", " ")}
                    </small>
                  </div>
                  <div className="notification-actions">
                    {impactId && (
                      <Link className="text-link" href={`/app/changes/${impactId}`}>
                        Review →
                      </Link>
                    )}
                    {!notification.read_at && (
                      <button className="text-button" onClick={() => void markRead(id)}>
                        Mark read
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
            {!notifications.data?.items.length && (
              <div className="empty-state">
                <span className="empty-icon">♧</span>
                <h2>You’re all caught up</h2>
                <p>
                  High-signal notifications will appear here when Auterim has something relevant to
                  share.
                </p>
              </div>
            )}
          </div>
        )}
      </>
    );

  if (kind === "settings")
    return (
      <>
        <PageHeading
          kind={kind}
          subtitle="Manage workspace integrations, notification preferences, and account access."
        />
        <div className="settings-grid">
          <section className="surface-card">
            <div className="section-heading">
              <div>
                <p className="card-kicker">INTEGRATIONS</p>
                <h2>Connected tools</h2>
              </div>
            </div>
            {connectors.loading || accountStatus.loading ? (
              <LoadingRows />
            ) : connectors.error || accountStatus.error ? (
              <ErrorState
                error={connectors.error || "Workspace access is temporarily unavailable."}
                retry={() => void Promise.all([connectors.reload(), accountStatus.reload()])}
              />
            ) : (
              <div className="connector-list">
                {(connectors.data?.items ?? []).map((connector) => {
                  const provider = String(connector.provider);
                  const status = String(connector.status);
                  const connected = ["connected", "healthy"].includes(status);
                  const capabilityNames = Array.isArray(connector.capabilities)
                    ? connector.capabilities
                        .filter(
                          (cap: unknown) =>
                            cap && typeof cap === "object" && "enabled" in cap && cap.enabled,
                        )
                        .map((cap: { name?: string }) =>
                          cap.name?.replace("CAN_", "").replaceAll("_", " ").toLowerCase(),
                        )
                    : [];
                  const account = accountStatus.data;
                  const githubPresentation =
                    provider === "github"
                      ? getGitHubConnectPresentation({
                          role: account?.role,
                          configured: connector.configured === true,
                          entitled:
                            account?.entitlements?.capabilities?.repositoryConnections === true &&
                            capabilityNames.includes("verify"),
                          status,
                          busy: githubConnecting,
                        })
                      : null;
                  const repositoryUsage = account?.entitlements?.usage?.repositories;
                  const repositoryLimit = account?.entitlements?.limits?.repositories;
                  const repositoryEntitled =
                    account?.entitlements?.capabilities?.repositoryConnections === true &&
                    capabilityNames.includes("verify");
                  return (
                    <div className="connector-row" key={provider}>
                      <span className="provider-monogram">{provider[0]?.toUpperCase()}</span>
                      <div className="connector-info">
                        <strong>{String(connector.displayName ?? provider)}</strong>
                        <small>
                          {provider === "github"
                            ? githubPresentation?.connected
                              ? `${String(connector.account ?? "GitHub account")} · ${repositoryEntitled ? "repository verification" : "Pro required for repository verification"}`
                              : (githubPresentation?.detail ?? "Checking workspace access.")
                            : connected
                              ? `${String(connector.account ?? "Connected account")} · ${capabilityNames.join(", ")}${
                                  Array.isArray(connector.resources) &&
                                  connector.resources.some(
                                    (resource: unknown) =>
                                      resource &&
                                      typeof resource === "object" &&
                                      "selected" in resource &&
                                      resource.selected,
                                  )
                                    ? ` · ${connector.resources
                                        .filter(
                                          (resource: { selected?: boolean }) => resource.selected,
                                        )
                                        .map(
                                          (resource: { display_name?: string }) =>
                                            resource.display_name,
                                        )
                                        .filter(Boolean)
                                        .join(", ")}`
                                    : ""
                                }`
                              : connector.configured
                                ? "Not connected"
                                : "Provider configuration unavailable"}
                        </small>
                      </div>
                      <span className={`connector-status${connected ? " connected" : ""}`}>
                        {provider === "github"
                          ? (githubPresentation?.statusLabel ?? "Checking access")
                          : connected
                            ? "Connected"
                            : status === "disconnected"
                              ? "Disconnected"
                              : status.replaceAll("_", " ")}
                      </span>
                      {provider === "github" ? (
                        <div className="connector-actions">
                          {githubPresentation?.canConnect ? (
                            <button
                              className="button-secondary"
                              disabled={githubConnecting || !workspaceId}
                              onClick={() => void connectGitHub()}
                            >
                              {githubConnecting ? "Connecting…" : "Connect GitHub"}
                            </button>
                          ) : githubPresentation?.connected ? (
                            <span className="connector-status connected">
                              {repositoryEntitled &&
                              typeof repositoryUsage === "number" &&
                              typeof repositoryLimit === "number"
                                ? `${repositoryUsage} / ${repositoryLimit} repositories`
                                : "Connected"}
                            </span>
                          ) : (
                            <span className="connector-status">
                              {githubPresentation?.statusLabel ?? "Checking access"}
                            </span>
                          )}
                        </div>
                      ) : connected ? (
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() => {
                            const installationId = String(connector.installationId ?? "");
                            if (installationId) void disconnect(provider, installationId);
                          }}
                        >
                          Disconnect
                        </button>
                      ) : (
                        <button
                          className="button-secondary"
                          disabled={busy || !connector.configured || !capabilityNames.length}
                          onClick={() => void connect(provider)}
                        >
                          {connector.configured ? "Connect" : "Not configured"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          <section className="surface-card">
            <p className="card-kicker">NOTIFICATIONS</p>
            <h2>How we reach your team</h2>
            {preference ? (
              <div className="preference-list">
                <PreferenceToggle
                  label="In-app notifications"
                  detail="High-signal updates in Auterim"
                  checked={Boolean(preference.in_app_enabled)}
                  disabled={busy}
                  onChange={(value) => void updatePreference("in_app_enabled", value)}
                />
                <PreferenceToggle
                  label="Email notifications"
                  detail="Protection changes and deadlines"
                  checked={Boolean(preference.email_enabled)}
                  disabled={busy}
                  onChange={(value) => void updatePreference("email_enabled", value)}
                />
                <PreferenceToggle
                  label="Slack delivery"
                  detail="Requires an authorized Slack destination"
                  checked={Boolean(preference.slack_enabled)}
                  disabled={busy}
                  onChange={(value) => void updatePreference("slack_enabled", value)}
                />
                <div className="preference-static">
                  <strong>Critical changes</strong>
                  <span>Instant</span>
                </div>
                <div className="preference-static">
                  <strong>Important changes</strong>
                  <span>
                    {String(preference.important_changes ?? "daily_digest").replaceAll("_", " ")}
                  </span>
                </div>
                <div className="preference-static">
                  <strong>Informational updates</strong>
                  <span>{String(preference.informational ?? "off")}</span>
                </div>
              </div>
            ) : (
              <p className="empty-copy">Loading notification preferences…</p>
            )}
          </section>
          <section className="surface-card account-settings">
            <p className="card-kicker">WORKSPACE &amp; BILLING</p>
            <h2>{workspace?.name ?? "Workspace"}</h2>
            <p>
              Workspace name and protection setup are managed through onboarding. Billing and
              account controls are available in the secure account area.
            </p>
            <Link className="button-secondary" href="/app/account">
              Billing &amp; account →
            </Link>
          </section>
          <WorkspaceMembersPanel workspaceId={workspaceId} role={accountStatus.data?.role} api={api} />
          {notice && (
            <div className="success-note" role="status">
              {notice}
            </div>
          )}
        </div>
      </>
    );
  return null;
}

function PreferenceToggle({
  label,
  detail,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="preference-toggle">
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function ChangeRows({ items }: { items: Change[] }) {
  return (
    <div className="row-list surface-card">
      {items.map((change) => (
        <Link className="change-row" href={`/app/changes/${change.id}`} key={change.id}>
          <span className="change-mark">↗</span>
          <span className="activity-main">
            <strong>
              {change.change?.summary ??
                change.customerImpact?.summary ??
                "Assessed material change"}
            </strong>
            <small>
              {change.dependency?.dependency_catalog?.name ?? "Dependency"} ·{" "}
              {change.change?.category?.replaceAll("_", " ") ?? "Change"} ·{" "}
              {date(change.change?.detectedAt ?? change.assessedAt)}
            </small>
          </span>
          {change.customerImpact?.relevant && <span className="relevant-label">Relevant</span>}
          <Severity value={change.customerImpact?.severity} />
          <span className="row-arrow">→</span>
        </Link>
      ))}
      {!items.length && (
        <div className="empty-state">
          <span className="empty-icon">↗</span>
          <h2>No assessed changes to show</h2>
          <p>
            Auterim only lists changes grounded in monitored sources and your confirmed
            dependencies.
          </p>
        </div>
      )}
    </div>
  );
}
