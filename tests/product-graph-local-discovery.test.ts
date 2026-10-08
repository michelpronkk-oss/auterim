import { describe, expect, it } from "vitest";
import {
  cliDependencyConfirmation,
  cliCatalogCoverage,
  cliMonitoringState,
  cliObservationChange,
  cliScanComparisonState,
} from "@/lib/protection/product-graph";

describe("local discovery graph semantics", () => {
  it("links known local observations only to an existing Product dependency", () => {
    const dependencies = [{ id: "workspace-dependency-1", dependency_id: "catalog-openai" }];
    expect(
      cliDependencyConfirmation({
        providerId: "catalog-openai",
        persistedWorkspaceDependencyId: null,
        dependencies,
      }),
    ).toEqual({
      confirmedDependencyId: "workspace-dependency-1",
      state: "confirmed_for_product",
    });
    expect(
      cliDependencyConfirmation({
        providerId: "catalog-stripe",
        persistedWorkspaceDependencyId: null,
        dependencies,
      }),
    ).toEqual({ confirmedDependencyId: null, state: "needs_confirmation" });
    expect(
      cliDependencyConfirmation({
        providerId: null,
        persistedWorkspaceDependencyId: null,
        dependencies,
      }),
    ).toEqual({ confirmedDependencyId: null, state: "unknown_provider_review_only" });
  });

  it("only compares complete scans whose full observation sets were read", () => {
    expect(
      cliScanComparisonState({
        latest: { status: "partial", observationCount: 1 },
        latestRows: 1,
        previous: { status: "complete", observationCount: 1 },
        previousRows: 1,
      }),
    ).toBe("incomplete");
    expect(
      cliScanComparisonState({
        latest: { status: "complete", observationCount: 501 },
        latestRows: 500,
        previous: { status: "complete", observationCount: 1 },
        previousRows: 1,
      }),
    ).toBe("incomplete");
    expect(
      cliScanComparisonState({
        latest: { status: "complete", observationCount: 1 },
        latestRows: 1,
        previous: { status: "complete", observationCount: 1 },
        previousRows: 1,
      }),
    ).toBe("complete");
  });

  it("does not claim additions or removals from incomplete comparisons", () => {
    expect(
      cliObservationChange({
        comparisonState: "incomplete",
        previousExists: false,
        changed: false,
      }),
    ).toBe("comparison_incomplete");
    expect(
      cliObservationChange({
        comparisonState: "complete",
        previousExists: false,
        changed: false,
      }),
    ).toBe("added");
  });

  it("keeps unknown or unbounded catalog coverage honest", () => {
    const counts = new Map([["provider-a", 2]]);
    expect(
      cliCatalogCoverage({ providerId: null, sourceCounts: counts, truncated: false }),
    ).toEqual({
      authoritativeSourcesAvailable: null,
      state: "unknown_provider",
    });
    expect(
      cliCatalogCoverage({ providerId: "provider-b", sourceCounts: counts, truncated: true }),
    ).toEqual({
      authoritativeSourcesAvailable: null,
      state: "not_evaluated_due_to_bound",
    });
    expect(
      cliCatalogCoverage({ providerId: "provider-a", sourceCounts: counts, truncated: false }),
    ).toEqual({
      authoritativeSourcesAvailable: 2,
      state: "catalog_sources_available",
    });
  });

  it("does not call a dependency disabled when it fell outside the graph bound", () => {
    expect(
      cliMonitoringState({
        dependencyId: "dep-a",
        monitoringEnabled: undefined,
        dependenciesTruncated: true,
        enabledSources: null,
      }),
    ).toBe("not_evaluated_due_to_dependency_bound");
    expect(
      cliMonitoringState({
        dependencyId: "dep-a",
        monitoringEnabled: false,
        dependenciesTruncated: false,
        enabledSources: 2,
      }),
    ).toBe("monitoring_disabled");
  });
});
