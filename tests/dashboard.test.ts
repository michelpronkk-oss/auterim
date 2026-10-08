import { afterEach, describe, expect, it, vi } from "vitest";
import { getDashboardHealthPresentation } from "@/lib/protection/dashboard-health";
import {
  notifyWorkspaceUpdated,
  shouldShowWorkspaceSelector,
  WORKSPACE_UPDATED_EVENT,
} from "@/lib/app/workspace-bootstrap";
import {
  createGitHubConnectAction,
  getGitHubConnectErrorMessage,
  getGitHubConnectPresentation,
} from "@/lib/app/github-connect";

afterEach(() => vi.unstubAllGlobals());

describe("dashboard dependency health language", () => {
  it("describes quiet monitoring evidence without claiming provider uptime", () => {
    const result = getDashboardHealthPresentation("protected_and_quiet");
    expect(result.label).toBe("No relevant change identified");
    expect(result.explanation).not.toMatch(/uptime|healthy provider/i);
  });

  it("does not claim health when the evidence state is unknown", () => {
    expect(getDashboardHealthPresentation(null).label).toBe("Status unknown");
    expect(getDashboardHealthPresentation("provider_status_ok").label).toBe("Status unknown");
  });

  it("names the evidence gaps for baseline and coverage states", () => {
    expect(getDashboardHealthPresentation("baseline_pending").explanation).toMatch(/baseline/i);
    expect(getDashboardHealthPresentation("incomplete_coverage").explanation).toMatch(
      /incomplete/i,
    );
    expect(getDashboardHealthPresentation("coverage_pending")).toMatchObject({
      label: "Coverage pending",
    });
  });
});

describe("workspace selector visibility", () => {
  it("keeps workspace switching available after activation", () => {
    expect(shouldShowWorkspaceSelector({ workspaceCount: 2 })).toBe(true);
  });

  it("keeps switching available during onboarding when multiple workspaces are authorized", () => {
    expect(shouldShowWorkspaceSelector({ workspaceCount: 2 })).toBe(true);
    expect(shouldShowWorkspaceSelector({ workspaceCount: 1 })).toBe(false);
  });

  it("notifies the app shell after an account-panel workspace switch", () => {
    const target = new EventTarget();
    const refreshShell = vi.fn();
    target.addEventListener(WORKSPACE_UPDATED_EVENT, refreshShell);
    vi.stubGlobal("window", target);

    notifyWorkspaceUpdated();

    expect(refreshShell).toHaveBeenCalledOnce();
  });
});

describe("GitHub repository connection control", () => {
  const base = {
    role: "owner",
    configured: true,
    entitled: true,
    status: "disconnected",
  };

  it("shows Connect for an owner with Pro repository verification and no connection", () => {
    expect(getGitHubConnectPresentation(base)).toMatchObject({
      connected: false,
      canConnect: true,
      statusLabel: "Not connected",
    });
  });

  it("shows Connect for an admin with Pro repository verification", () => {
    expect(getGitHubConnectPresentation({ ...base, role: "admin" }).canConnect).toBe(true);
  });

  it("does not offer installation to a workspace member", () => {
    expect(getGitHubConnectPresentation({ ...base, role: "member" })).toMatchObject({
      canConnect: false,
      detail: "Ask a workspace owner or admin to connect GitHub.",
    });
  });

  it("shows upgrade semantics when repository verification is not entitled", () => {
    expect(getGitHubConnectPresentation({ ...base, entitled: false })).toMatchObject({
      canConnect: false,
      statusLabel: "Pro required",
      detail: expect.stringMatching(/available on Pro/),
    });
  });

  it("keeps Connect unavailable when the GitHub App is not configured or a request is pending", () => {
    expect(getGitHubConnectPresentation({ ...base, configured: false }).canConnect).toBe(false);
    expect(getGitHubConnectPresentation({ ...base, busy: true }).canConnect).toBe(false);
  });

  it("does not offer a duplicate install action for a connected workspace", () => {
    expect(getGitHubConnectPresentation({ ...base, status: "connected" })).toMatchObject({
      connected: true,
      canConnect: false,
      statusLabel: "Connected",
    });
  });

  it("sends the selected workspace ID to the existing install endpoint", async () => {
    const request = vi.fn(async (workspaceId: string) => {
      void workspaceId;
      return {
        authorizationUrl:
          "https://github.com/login/oauth/authorize?client_id=public-id&scope=read%3Auser&state=opaque",
        expiresInSeconds: 600,
      };
    });
    const navigate = vi.fn();
    const action = createGitHubConnectAction(request, navigate);

    await action("workspace-current");

    expect(request).toHaveBeenCalledExactlyOnceWith("workspace-current");
  });

  it("uses a newly selected workspace ID for a later connect attempt", async () => {
    const request = vi.fn(async (workspaceId: string) => {
      void workspaceId;
      return {
        authorizationUrl:
          "https://github.com/login/oauth/authorize?client_id=public-id&scope=read%3Auser&state=opaque",
        expiresInSeconds: 600,
      };
    });
    const action = createGitHubConnectAction(request, vi.fn());

    await action("workspace-test");
    await action("workspace-koronic");

    expect(request.mock.calls.map(([workspaceId]) => workspaceId)).toEqual([
      "workspace-test",
      "workspace-koronic",
    ]);
  });

  it("ignores a duplicate click while the first install request is pending", async () => {
    let resolveRequest: ((value: unknown) => void) | undefined;
    const request = vi.fn(() => new Promise<unknown>((resolve) => (resolveRequest = resolve)));
    const navigate = vi.fn();
    const action = createGitHubConnectAction(request, navigate);
    const first = action("workspace-test");
    const duplicate = await action("workspace-test");

    expect(duplicate).toBe(false);
    expect(request).toHaveBeenCalledOnce();
    resolveRequest?.({
      authorizationUrl:
        "https://github.com/login/oauth/authorize?client_id=public-id&scope=read%3Auser&state=opaque",
      expiresInSeconds: 600,
    });
    expect(await first).toBe(true);
  });

  it("navigates only to the expected GitHub authorization URL", async () => {
    const authorizationUrl =
      "https://github.com/login/oauth/authorize?client_id=public-id&scope=read%3Auser&state=opaque";
    const navigate = vi.fn();
    const action = createGitHubConnectAction(
      async () => ({ authorizationUrl, expiresInSeconds: 600 }),
      navigate,
    );

    expect(await action("workspace-test")).toBe(true);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(authorizationUrl);
  });

  it("rejects a non-GitHub authorization destination without navigating", async () => {
    const navigate = vi.fn();
    const action = createGitHubConnectAction(
      async () => ({
        authorizationUrl: "https://example.com/login/oauth/authorize?scope=read:user",
      }),
      navigate,
    );

    await expect(action("workspace-test")).rejects.toThrow("github_authorization_unavailable");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("returns a safe error message for endpoint failures", () => {
    const privateDetail = "state=secret-state access_token=secret-token";
    const message = getGitHubConnectErrorMessage(
      Object.assign(new Error(privateDetail), { status: 503 }),
    );

    expect(message).toBe("GitHub connection is temporarily unavailable.");
    expect(message).not.toContain("secret-state");
    expect(message).not.toContain("secret-token");
  });

  it("maps auth, role, entitlement, and configuration failures to safe messages", () => {
    expect(getGitHubConnectErrorMessage(Object.assign(new Error("x"), { status: 401 }))).toMatch(
      /session expired/i,
    );
    expect(getGitHubConnectErrorMessage(Object.assign(new Error("x"), { status: 403 }))).toMatch(
      /owner or admin/i,
    );
    expect(getGitHubConnectErrorMessage(Object.assign(new Error("x"), { status: 402 }))).toMatch(
      /available on Pro/i,
    );
    expect(
      getGitHubConnectErrorMessage(
        Object.assign(new Error("github_app_not_configured"), { status: 503 }),
      ),
    ).toMatch(/temporarily unavailable/i);
  });

  it("does not return or log OAuth state as control output", async () => {
    const state = "private-oauth-state";
    const request = vi.fn(async () => ({
      authorizationUrl: `https://github.com/login/oauth/authorize?client_id=public-id&scope=read%3Auser&state=${state}`,
      expiresInSeconds: 600,
    }));
    const navigate = vi.fn();
    const log = vi.spyOn(console, "log");
    const action = createGitHubConnectAction(request, navigate);

    const result = await action("workspace-test");

    expect(result).toBe(true);
    expect(log).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(state);
    log.mockRestore();
  });
});
