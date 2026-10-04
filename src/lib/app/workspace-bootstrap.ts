export type WorkspaceBootstrapState =
  "LOADING" | "READY" | "NEEDS_ONBOARDING" | "AUTH_REQUIRED" | "ERROR";

export function resolveWorkspaceBootstrapState(input: {
  authenticated: boolean;
  workspaceCount?: number;
  selectedWorkspaceActive?: boolean;
  failed?: boolean;
}): WorkspaceBootstrapState {
  if (!input.authenticated) return "AUTH_REQUIRED";
  if (input.failed) return "ERROR";
  if (input.workspaceCount === undefined) return "LOADING";
  if (input.workspaceCount === 0) return "NEEDS_ONBOARDING";
  if (input.selectedWorkspaceActive === undefined) return "LOADING";
  return input.selectedWorkspaceActive ? "READY" : "NEEDS_ONBOARDING";
}

export function shouldShowWorkspaceSelector(input: {
  workspaceCount: number;
  selectedWorkspaceActive: boolean;
}) {
  return input.selectedWorkspaceActive && input.workspaceCount > 1;
}
