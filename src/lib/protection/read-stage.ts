/** Safe fixed labels for diagnosing protected-Product read failures. */
export const PRODUCT_PROTECTION_READ_STAGES = [
  "product",
  "dependencies",
  "repository_graph",
  "repository_access",
  "repository_mappings",
  "onboarding_progress",
  "onboarding_status",
  "entitlements",
  "cli_runs",
  "cli_observations",
  "cli_coverage",
  "source_catalog",
  "impact_assessments",
  "source_observations",
  "classifications",
  "preflight_runs",
  "preflight_findings",
  "baseline_evidence",
  "baseline_runs",
  "deployment_surfaces",
  "deployment_observations",
  "deployment_evidence",
  "unknown",
] as const;

export type ProductProtectionReadStage = (typeof PRODUCT_PROTECTION_READ_STAGES)[number];

/** Contains only a static stage; provider/database errors are deliberately discarded. */
export class ProductProtectionReadError extends Error {
  readonly name = "ProductProtectionReadError";

  constructor(readonly stage: ProductProtectionReadStage) {
    super("product_protection_read_unavailable");
  }
}

export function productProtectionReadStage(error: unknown): ProductProtectionReadStage {
  return error instanceof ProductProtectionReadError ? error.stage : "unknown";
}
