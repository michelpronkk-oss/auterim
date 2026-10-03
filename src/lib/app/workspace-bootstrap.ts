export type WorkspaceBootstrapState =
  "LOADING" | "READY" | "NEEDS_ONBOARDING" | "AUTH_REQUIRED" | "ERROR";

export function resolveWorkspaceBootstrapState(input: {
  authenticated: boolean;
  workspaceCount?: number;
  failed?: boolean;
}): WorkspaceBootstrapState {
  if (!input.authenticated) return "AUTH_REQUIRED";
  if (input.failed) return "ERROR";
  if (input.workspaceCount === undefined) return "LOADING";
  return input.workspaceCount > 0 ? "READY" : "NEEDS_ONBOARDING";
}
