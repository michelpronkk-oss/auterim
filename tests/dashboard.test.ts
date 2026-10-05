import { describe, expect, it } from "vitest";
import { getDashboardHealthPresentation } from "@/lib/protection/dashboard-health";
import { shouldShowWorkspaceSelector } from "@/lib/app/workspace-bootstrap";

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
    expect(shouldShowWorkspaceSelector({ workspaceCount: 2, selectedWorkspaceActive: true })).toBe(
      true,
    );
  });

  it("hides the selector during initial onboarding and for a single workspace", () => {
    expect(shouldShowWorkspaceSelector({ workspaceCount: 2, selectedWorkspaceActive: false })).toBe(
      false,
    );
    expect(shouldShowWorkspaceSelector({ workspaceCount: 1, selectedWorkspaceActive: true })).toBe(
      false,
    );
  });
});
