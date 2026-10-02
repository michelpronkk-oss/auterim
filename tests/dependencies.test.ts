import { describe, expect, it } from "vitest";
import { dependencySourceTypes } from "@/lib/dependencies/types";

describe("dependency domain vocabulary", () => {
  it("contains the source categories currently in scope", () => {
    expect(dependencySourceTypes).toContain("pricing");
    expect(dependencySourceTypes).toContain("deprecation");
    expect(dependencySourceTypes).toHaveLength(9);
  });
});
