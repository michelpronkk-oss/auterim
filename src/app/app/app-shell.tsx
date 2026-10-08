"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  resolveWorkspaceBootstrapState,
  type WorkspaceBootstrapState,
  WORKSPACE_UPDATED_EVENT,
} from "@/lib/app/workspace-bootstrap";
import {
  normalizeWorkspaceOptions,
  resolveSelectedWorkspaceId,
  type WorkspaceOption,
} from "@/lib/app/workspace-options";

const BOOTSTRAP_TIMEOUT_MS = 12_000;

class AppRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: number | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(message)), BOOTSTRAP_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
}

type AppContextValue = {
  session: Session;
  workspaceId: string;
  workspace: WorkspaceOption;
  workspaces: WorkspaceOption[];
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
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [unread, setUnread] = useState(0);
  const [bootstrapState, setBootstrapState] = useState<WorkspaceBootstrapState>("LOADING");
  const bootstrapRequestId = useRef(0);
  const sessionRef = useRef<Session | null>(null);

  const api = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (!session?.access_token) throw new AppRequestError("authentication_required", 401);
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), BOOTSTRAP_TIMEOUT_MS);
      try {
        const response = await fetch(path, {
          ...init,
          cache: init?.cache ?? "no-store",
          signal: controller.signal,
          headers: { authorization: `Bearer ${session.access_token}`, ...(init?.headers ?? {}) },
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const message =
            body && typeof body === "object" && "error" in body
              ? String(body.error)
              : "request_failed";
          throw new AppRequestError(message, response.status);
        }
        return body as T;
      } catch (requestError) {
        if (requestError instanceof AppRequestError) throw requestError;
        if (controller.signal.aborted) throw new Error("workspace_request_timed_out");
        throw new Error("workspace_request_failed");
      } finally {
        window.clearTimeout(timer);
      }
    },
    [session],
  );

  const refresh = useCallback(async () => {
    const requestId = ++bootstrapRequestId.current;
    if (!session) {
      setBootstrapState("AUTH_REQUIRED");
      return;
    }
    setBootstrapState("LOADING");
    try {
      const list = await api<{
        workspaces?: Array<{ workspace_id: string; workspace_name: string; role: string }>;
      }>("/api/account/status");
      const rawEntries = await Promise.all(
        (list.workspaces ?? []).map(async (item) => {
          const account = await api<{
            onboarding?: {
              activation?: { activatedAt?: string } | null;
            };
          }>(`/api/account/status?workspaceId=${encodeURIComponent(item.workspace_id)}`);
          return {
            workspaceId: item.workspace_id,
            name: item.workspace_name,
            role: item.role,
            active: Boolean(account.onboarding?.activation?.activatedAt),
          };
        }),
      );
      const entries = normalizeWorkspaceOptions(rawEntries);
      if (
        requestId !== bootstrapRequestId.current ||
        sessionRef.current?.user.id !== session.user.id ||
        sessionRef.current?.access_token !== session.access_token
      )
        return;
      setWorkspaces(entries);
      const saved = window.localStorage.getItem("auterim-workspace-id");
      const selected = resolveSelectedWorkspaceId(entries, saved);
      setWorkspaceId(selected);
      if (selected) window.localStorage.setItem("auterim-workspace-id", selected);
      else window.localStorage.removeItem("auterim-workspace-id");
      setBootstrapState(
        resolveWorkspaceBootstrapState({
          authenticated: true,
          workspaceCount: entries.length,
          selectedWorkspaceActive: entries.find((item) => item.workspaceId === selected)?.active,
        }),
      );
    } catch (bootstrapError) {
      if (requestId !== bootstrapRequestId.current) return;
      if (bootstrapError instanceof AppRequestError && bootstrapError.status === 401) {
        sessionRef.current = null;
        setSession(null);
        setWorkspaces([]);
        setWorkspaceId("");
        setBootstrapState("AUTH_REQUIRED");
        return;
      }
      setBootstrapState(resolveWorkspaceBootstrapState({ authenticated: true, failed: true }));
    }
  }, [api, session]);

  useEffect(() => {
    const client = createSupabaseBrowserClient();
    let cancelled = false;
    let authEventSeen = false;
    void withTimeout(client.auth.getSession(), "session_restore_timed_out")
      .then(({ data }) => {
        if (cancelled || authEventSeen) return;
        sessionRef.current = data.session;
        setSession(data.session);
        if (!data.session) setBootstrapState("AUTH_REQUIRED");
      })
      .catch(() => {
        if (!cancelled && !authEventSeen) {
          setBootstrapState("ERROR");
        }
      });
    const { data: listener } = client.auth.onAuthStateChange((_event, next) => {
      authEventSeen = true;
      const userChanged = sessionRef.current?.user.id !== next?.user.id;
      sessionRef.current = next;
      if (userChanged) bootstrapRequestId.current += 1;
      setSession(next);
      if (userChanged) {
        setWorkspaceId("");
        setWorkspaces([]);
      }
      setBootstrapState(
        resolveWorkspaceBootstrapState({ authenticated: Boolean(next), workspaceCount: undefined }),
      );
    });
    return () => {
      cancelled = true;
      bootstrapRequestId.current += 1;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [session, refresh]);
  useEffect(() => {
    const handleWorkspaceUpdate = () => void refresh();
    window.addEventListener(WORKSPACE_UPDATED_EVENT, handleWorkspaceUpdate);
    return () => window.removeEventListener(WORKSPACE_UPDATED_EVENT, handleWorkspaceUpdate);
  }, [refresh]);
  useEffect(() => {
    if (!session || !workspaceId) return;
    let cancelled = false;
    void api<{ unreadCount: number }>(
      `/api/notifications?workspaceId=${encodeURIComponent(workspaceId)}&limit=1`,
    )
      .then((data) => {
        if (!cancelled) setUnread(data.unreadCount);
      })
      .catch(() => {
        if (!cancelled) setUnread(0);
      });
    return () => {
      cancelled = true;
    };
  }, [api, session, workspaceId, pathname]);

  useEffect(() => {
    if (bootstrapState === "NEEDS_ONBOARDING" && pathname !== "/app/onboarding")
      router.replace("/app/onboarding");
    if (bootstrapState === "READY" && pathname === "/app/onboarding") router.replace("/app");
  }, [bootstrapState, pathname, router]);

  const value = useMemo(
    () => ({
      session: session!,
      workspaceId,
      workspace: workspaces.find((item) => item.workspaceId === workspaceId)!,
      workspaces,
      selectWorkspace: (id: string) => {
        const selected = workspaces.find((item) => item.workspaceId === id);
        setWorkspaceId(id);
        window.localStorage.setItem("auterim-workspace-id", id);
        if (selected)
          setBootstrapState(
            resolveWorkspaceBootstrapState({
              authenticated: true,
              workspaceCount: workspaces.length,
              selectedWorkspaceActive: selected.active,
            }),
          );
      },
      api,
      refresh,
    }),
    [session, workspaceId, workspaces, api, refresh],
  );

  if (bootstrapState === "LOADING")
    return (
      <main className="app-loading">
        <span className="brand-mark">A</span>
        <p>Loading your protection workspace…</p>
      </main>
    );
  if (bootstrapState === "ERROR")
    return (
      <main className="app-auth">
        <div className="auth-card">
          <span className="brand-mark">A</span>
          <p className="eyebrow">Workspace unavailable</p>
          <h1>We couldn’t load your protection workspace.</h1>
          <p>Try again in a moment. Your account and workspace data have not been changed.</p>
          <div className="app-auth-actions">
            <button
              className="button-primary"
              onClick={() => (session ? void refresh() : window.location.reload())}
            >
              Try again
            </button>
            <button
              className="button-secondary"
              onClick={() => void createSupabaseBrowserClient().auth.signOut()}
            >
              Sign out
            </button>
          </div>
        </div>
      </main>
    );
  if (bootstrapState === "AUTH_REQUIRED" || !session)
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
  if (bootstrapState === "NEEDS_ONBOARDING" && pathname !== "/app/onboarding")
    return <main className="app-loading">Opening your protection setup…</main>;
  if (bootstrapState === "NEEDS_ONBOARDING") return <>{children}</>;
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
                  {item.selectorLabel}
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
                    {item.selectorLabel}
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
