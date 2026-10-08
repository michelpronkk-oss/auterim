export type WorkspaceBootstrapState =
  "LOADING" | "READY" | "NEEDS_ONBOARDING" | "AUTH_REQUIRED" | "ERROR";

export const WORKSPACE_UPDATED_EVENT = "auterim:workspace-updated";

export function notifyWorkspaceUpdated() {
  window.dispatchEvent(new Event(WORKSPACE_UPDATED_EVENT));
}

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

export function shouldShowWorkspaceSelector(input: { workspaceCount: number }) {
  return input.workspaceCount > 1;
}
