import { describe, expect, it } from "vitest";
import { hasUnresolvedDiscoveryCandidates } from "@/lib/onboarding/activation-readiness";

describe("onboarding activation readiness", () => {
  it("blocks activation while a discovery suggestion remains unresolved", () => {
    expect(hasUnresolvedDiscoveryCandidates([{ suggestedStatus: "candidate" }])).toBe(true);
  });

  it("allows activation after every suggestion is confirmed or rejected", () => {
    expect(
      hasUnresolvedDiscoveryCandidates([
        { suggestedStatus: "confirmed" },
        { suggestedStatus: "rejected" },
      ]),
    ).toBe(false);
  });

  it("allows manually added dependencies when discovery found no candidates", () => {
    expect(hasUnresolvedDiscoveryCandidates([])).toBe(false);
  });
});
