"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type Workspace = { workspaceId: string; name: string; role: string };
type AppContextValue = {
  session: Session;
  workspaceId: string;
  workspace: Workspace;
  workspaces: Workspace[];
  selectWorkspace: (id: string) => void;
  api: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  refresh: () => Promise<void>;
};
const AppContext = createContext<AppContextValue | null>(null);
export function useProductApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("Product app context is unavailable");
  return value;
}

const links = [
  { href: "/app", label: "Today", icon: "◷" },
  { href: "/app/dependencies", label: "Dependencies", icon: "◇" },
  { href: "/app/changes", label: "Changes", icon: "↗" },
  { href: "/app/actions", label: "Actions", icon: "✓" },
  { href: "/app/settings", label: "Settings", icon: "⚙" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [session, setSession] = useState<Session | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const api = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (!session?.access_token) throw new Error("Sign in to continue.");
      const response = await fetch(path, {
        ...init,
        headers: { authorization: `Bearer ${session.access_token}`, ...(init?.headers ?? {}) },
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          body && typeof body === "object" && "error" in body
            ? String(body.error)
            : "Request failed.";
        throw new Error(message);
      }
      return body as T;
    },
    [session],
  );

  const refresh = useCallback(async () => {
    if (!session) return;
    const list = await api<{ workspaces?: Array<{ workspace_id: string; role: string }> }>(
      "/api/account/status",
    );
    const entries = await Promise.all(
      (list.workspaces ?? []).map(async (item) => {
        try {
          const account = await api<{ onboarding?: { company?: { name?: string } } }>(
            `/api/account/status?workspaceId=${encodeURIComponent(item.workspace_id)}`,
          );
          return {
            workspaceId: item.workspace_id,
            name: account.onboarding?.company?.name || "Workspace",
            role: item.role,
          };
        } catch {
          return { workspaceId: item.workspace_id, name: "Workspace", role: item.role };
        }
      }),
    );
    setWorkspaces(entries);
    const saved = window.localStorage.getItem("auterim-workspace-id");
    const selected = entries.some((item) => item.workspaceId === saved)
      ? saved!
      : (entries[0]?.workspaceId ?? "");
    setWorkspaceId(selected);
    if (selected) window.localStorage.setItem("auterim-workspace-id", selected);
  }, [api, session]);

  useEffect(() => {
    const client = createSupabaseBrowserClient();
    void client.auth
      .getSession()
      .then(({ data }) => setSession(data.session))
      .catch(() => setError("Could not check your sign-in state."))
      .finally(() => setLoading(false));
    const { data: listener } = client.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setWorkspaceId("");
      setWorkspaces([]);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session)
      queueMicrotask(() => {
        void refresh().catch(() => setError("Could not load your workspace."));
      });
  }, [session, refresh]);
  useEffect(() => {
    if (!session || !workspaceId) return;
    void api<{ unreadCount: number }>(
      `/api/notifications?workspaceId=${encodeURIComponent(workspaceId)}&limit=1`,
    )
      .then((data) => setUnread(data.unreadCount))
      .catch(() => setUnread(0));
  }, [api, session, workspaceId, pathname]);

  const value = useMemo(
    () => ({
      session: session!,
      workspaceId,
      workspace: workspaces.find((item) => item.workspaceId === workspaceId)!,
      workspaces,
      selectWorkspace: (id: string) => {
        setWorkspaceId(id);
        window.localStorage.setItem("auterim-workspace-id", id);
      },
      api,
      refresh,
    }),
    [session, workspaceId, workspaces, api, refresh],
  );

  if (loading || (session && !workspaces.length && !error))
    return (
      <main className="app-loading">
        <span className="brand-mark">A</span>
        <p>Loading your protection workspace…</p>
      </main>
    );
  if (!session)
    return (
      <main className="app-auth">
        <div className="auth-card">
          <span className="brand-mark">A</span>
          <p className="eyebrow">Auterim workspace</p>
          <h1>Protection starts with context.</h1>
          <p>Sign in to see your dependencies, verified changes, and next actions.</p>
          <div className="app-auth-actions">
            <Link className="button-primary" href="/login">
              Sign in
            </Link>
            <Link className="button-secondary" href="/signup">
              Create account
            </Link>
          </div>
        </div>
      </main>
    );
  if (!workspaces.length)
    return (
      <main className="app-auth">
        <div className="auth-card">
          <span className="brand-mark">A</span>
          <p className="eyebrow">Your workspace</p>
          <h1>Set up protection for your company.</h1>
          <p>
            Your account is ready. Finish workspace setup to start monitoring your dependencies.
          </p>
          <Link className="button-primary" href="/app/account">
            Continue setup <span aria-hidden="true">→</span>
          </Link>
        </div>
      </main>
    );
  const active = (href: string) =>
    href === "/app" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <AppContext.Provider value={value}>
      <div className="app-frame">
        <aside className="app-sidebar">
          <Link className="app-brand" href="/app">
            <span className="brand-mark">A</span>
            <span>auterim</span>
          </Link>
          <div className="workspace-control">
            <span className="sidebar-label">WORKSPACE</span>
            <select
              aria-label="Select workspace"
              value={workspaceId}
              onChange={(event) => value.selectWorkspace(event.target.value)}
            >
              {workspaces.map((item) => (
                <option key={item.workspaceId} value={item.workspaceId}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          <nav className="primary-nav" aria-label="Main navigation">
            {links.map((item) => (
              <Link
                key={item.href}
                className={`primary-nav-link${active(item.href) ? " active" : ""}`}
                href={item.href}
              >
                <span className="nav-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span>{item.label}</span>
                {item.href === "/app/actions" && <span className="nav-spacer" />}
              </Link>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="watching-pill">
              <span className="watching-dot" />
              <span>Auterim protection</span>
            </div>
            <button
              type="button"
              className="sidebar-account"
              onClick={() =>
                void createSupabaseBrowserClient()
                  .auth.signOut()
                  .then(() => {
                    setSession(null);
                    window.localStorage.removeItem("auterim-workspace-id");
                  })
              }
            >
              <span className="avatar">{session.user.email?.[0]?.toUpperCase() ?? "A"}</span>
              <span className="account-email">{session.user.email}</span>
              <span aria-hidden="true">↗</span>
            </button>
          </div>
        </aside>
        <div className="app-main">
          <header className="app-topbar">
            <div className="mobile-brand">
              <Link className="app-brand" href="/app">
                <span className="brand-mark">A</span>
                <span>auterim</span>
              </Link>
              <select
                aria-label="Select workspace"
                value={workspaceId}
                onChange={(event) => value.selectWorkspace(event.target.value)}
              >
                {workspaces.map((item) => (
                  <option key={item.workspaceId} value={item.workspaceId}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="topbar-meta">
              <span className="secure-label">
                <span />
                Workspace protection
              </span>
              <Link
                className="notification-button"
                href="/app/notifications"
                aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
              >
                <span aria-hidden="true">♧</span>
                {unread > 0 && (
                  <span className="notification-count">{unread > 9 ? "9+" : unread}</span>
                )}
              </Link>
            </div>
          </header>
          {error && (
            <div className="app-banner" role="status">
              {error}{" "}
              <button
                onClick={() => {
                  setError("");
                  void refresh().catch(() => setError("Could not load your workspace."));
                }}
              >
                Retry
              </button>
            </div>
          )}
          <main className="app-content">{children}</main>
        </div>
        <nav className="mobile-nav" aria-label="Main navigation">
          {links.map((item) => (
            <Link key={item.href} className={active(item.href) ? "active" : ""} href={item.href}>
              <span aria-hidden="true">{item.icon}</span>
              <small>{item.label}</small>
            </Link>
          ))}
        </nav>
      </div>
    </AppContext.Provider>
  );
}
