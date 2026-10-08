import { afterEach, describe, expect, it, vi } from "vitest";
import { getDashboardHealthPresentation } from "@/lib/protection/dashboard-health";
import {
  notifyWorkspaceUpdated,
  shouldShowWorkspaceSelector,
  WORKSPACE_UPDATED_EVENT,
} from "@/lib/app/workspace-bootstrap";

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
