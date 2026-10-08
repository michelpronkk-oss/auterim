export type GitHubConnectEligibilityInput = {
  role: string | null | undefined;
  configured: boolean;
  entitled: boolean;
  status: string | null | undefined;
  busy?: boolean;
};

export type GitHubConnectPresentation = {
  connected: boolean;
  canConnect: boolean;
  statusLabel: string;
  detail: string;
};

export function getGitHubConnectPresentation(
  input: GitHubConnectEligibilityInput,
): GitHubConnectPresentation {
  const connected = input.status === "connected" || input.status === "healthy";
  if (connected) {
    return {
      connected: true,
      canConnect: false,
      statusLabel: "Connected",
      detail: input.entitled
        ? "GitHub is connected for repository verification."
        : "GitHub is connected. Repository verification requires Pro.",
    };
  }
  if (!input.entitled) {
    return {
      connected: false,
      canConnect: false,
      statusLabel: "Pro required",
      detail: "GitHub repository verification is available on Pro.",
    };
  }
  if (input.role !== "owner" && input.role !== "admin") {
    return {
      connected: false,
      canConnect: false,
      statusLabel: "Not connected",
      detail: "Ask a workspace owner or admin to connect GitHub.",
    };
  }
  if (!input.configured) {
    return {
      connected: false,
      canConnect: false,
      statusLabel: "Unavailable",
      detail: "GitHub connection is temporarily unavailable.",
    };
  }
  return {
    connected: false,
    canConnect: !input.busy,
    statusLabel: "Not connected",
    detail: "Verify which external software changes affect your code.",
  };
}

export function validateGitHubAuthorizationUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("github_authorization_unavailable");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("github_authorization_unavailable");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/login/oauth/authorize" ||
    url.searchParams.get("scope") !== "read:user" ||
    !url.searchParams.get("client_id") ||
    !url.searchParams.get("state") ||
    url.searchParams.get("state")!.length > 128 ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => !["client_id", "scope", "state"].includes(key))
  ) {
    throw new Error("github_authorization_unavailable");
  }
  return url.toString();
}

export type GitHubInstallRequest = (workspaceId: string) => Promise<unknown>;
export type GitHubNavigate = (authorizationUrl: string) => void;

export function createGitHubConnectAction(
  request: GitHubInstallRequest,
  navigate: GitHubNavigate,
): (workspaceId: string) => Promise<boolean> {
  let inFlight = false;
  return async (workspaceId) => {
    if (inFlight) return false;
    inFlight = true;
    try {
      const result = await request(workspaceId);
      if (
        !result ||
        typeof result !== "object" ||
        !("authorizationUrl" in result) ||
        !("expiresInSeconds" in result) ||
        typeof result.expiresInSeconds !== "number" ||
        result.expiresInSeconds <= 0 ||
        result.expiresInSeconds > 600
      ) {
        throw new Error("github_authorization_unavailable");
      }
      const authorizationUrl = validateGitHubAuthorizationUrl(result.authorizationUrl);
      navigate(authorizationUrl);
      return true;
    } finally {
      inFlight = false;
    }
  };
}

export function getGitHubConnectErrorMessage(error: unknown): string {
  const status =
    error && typeof error === "object" && "status" in error ? Number(error.status) : undefined;
  const code =
    error && typeof error === "object" && "message" in error ? String(error.message) : "";
  if (status === 401 || code === "authentication_required")
    return "Your session expired. Sign in again to connect GitHub.";
  if (status === 403 || code === "forbidden")
    return "Only a workspace owner or admin can connect GitHub.";
  if (status === 402 || code === "pro_plan_required")
    return "GitHub repository verification is available on Pro.";
  if (status === 503 || code === "github_app_not_configured")
    return "GitHub connection is temporarily unavailable.";
  return "Could not start the GitHub connection. Try again.";
}
