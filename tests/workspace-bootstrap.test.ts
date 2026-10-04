import { describe, expect, it } from "vitest";
import { resolveWorkspaceBootstrapState } from "@/lib/app/workspace-bootstrap";

describe("workspace bootstrap state", () => {
  it("keeps auth restoration in a bounded loading state", () => {
    expect(resolveWorkspaceBootstrapState({ authenticated: true })).toBe("LOADING");
  });

  it("shows the dashboard only after the selected workspace is active", () => {
    expect(
      resolveWorkspaceBootstrapState({
        authenticated: true,
        workspaceCount: 1,
        selectedWorkspaceActive: true,
      }),
    ).toBe("READY");
  });

  it("routes an incomplete workspace member into onboarding", () => {
    expect(
      resolveWorkspaceBootstrapState({
        authenticated: true,
        workspaceCount: 1,
        selectedWorkspaceActive: false,
      }),
    ).toBe("NEEDS_ONBOARDING");
  });

  it("fails closed while selected workspace activation is unknown", () => {
    expect(resolveWorkspaceBootstrapState({ authenticated: true, workspaceCount: 1 })).toBe(
      "LOADING",
    );
  });

  it("routes an authenticated user without memberships to onboarding", () => {
    expect(resolveWorkspaceBootstrapState({ authenticated: true, workspaceCount: 0 })).toBe(
      "NEEDS_ONBOARDING",
    );
  });

  it("treats an empty membership result as setup rather than a query failure", () => {
    expect(
      resolveWorkspaceBootstrapState({ authenticated: true, workspaceCount: 0, failed: false }),
    ).toBe("NEEDS_ONBOARDING");
  });

  it("exposes bootstrap and RLS failures as recoverable errors", () => {
    expect(resolveWorkspaceBootstrapState({ authenticated: true, failed: true })).toBe("ERROR");
    expect(
      resolveWorkspaceBootstrapState({ authenticated: true, workspaceCount: 0, failed: true }),
    ).toBe("ERROR");
  });

  it("returns to sign-in when the session is missing or expired", () => {
    expect(resolveWorkspaceBootstrapState({ authenticated: false })).toBe("AUTH_REQUIRED");
  });
});
