import { describe, expect, it } from "vitest";
import { getDashboardHealthPresentation } from "@/lib/protection/dashboard-health";

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
  });
});
