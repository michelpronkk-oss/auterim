import { FIX_RISK_RULES_VERSION, type FixRiskLevel } from "@/lib/fix-engine/contracts";

export type FixRiskInput = {
  changedPaths: string[];
  changedLines: number;
  dependencyChanges: number;
  verification: "passed" | "failed" | "unsupported";
  preflightRequired: boolean;
  preflight: "passed" | "failed" | "not_run" | "not_applicable";
  reviewDisposition: "none" | "review_required";
  provenanceMode: "customer" | "evidence_only";
  staleBase: boolean;
  conflict: boolean;
};

export type FixRiskAssessment = {
  version: string;
  level: FixRiskLevel;
  factors: string[];
  reviewRequired: boolean;
  reviewReason: string | null;
  draftPrEligible: boolean;
};

const rules: Array<[RegExp, string, FixRiskLevel]> = [
  [/^\.env(?:\.|$)|(^|\/)secrets?\//i, "secret_or_environment_path", "BLOCKED"],
  [/(^|\/)(billing|payments?)(\/|\.|$)/i, "billing_or_payment_path", "HIGH"],
  [
    /(^|\/)(auth|authentication|authorization|security)(\/|\.|$)/i,
    "authentication_or_security_path",
    "HIGH",
  ],
  [/(^|\/)(supabase\/migrations|migrations)(\/|\.|$)/i, "database_migration", "HIGH"],
  [
    /(^|\/)(infra|infrastructure|terraform|\.github\/workflows)(\/|\.|$)/i,
    "infrastructure_or_workflow_change",
    "HIGH",
  ],
  [/(^|\/)(dist|build|\.next|coverage|vendor)(\/|\.|$)/i, "generated_or_vendor_file", "HIGH"],
  [
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/i,
    "lockfile_change",
    "HIGH",
  ],
  [/^package\.json$/i, "dependency_manifest_change", "HIGH"],
  [/(^|\/)(openapi|swagger|public-api|api-types)(\/|\.|$)/i, "public_api_change", "HIGH"],
];

export function assessFixRisk(input: FixRiskInput): FixRiskAssessment {
  const factors = new Set<string>();
  let level: FixRiskLevel = "LOW";
  const raise = (next: FixRiskLevel, factor: string) => {
    factors.add(factor);
    if (
      next === "BLOCKED" ||
      (next === "HIGH" && level !== "BLOCKED") ||
      (next === "MEDIUM" && level === "LOW")
    )
      level = next;
  };
  if (
    !Number.isSafeInteger(input.changedLines) ||
    input.changedLines < 0 ||
    input.changedPaths.length === 0
  )
    raise("BLOCKED", "invalid_patch_shape");
  if (input.changedPaths.length > 10 || input.changedLines > 500) raise("HIGH", "patch_size_high");
  else if (input.changedPaths.length > 3 || input.changedLines > 120)
    raise("MEDIUM", "patch_size_medium");
  if (input.dependencyChanges > 0) raise("HIGH", "dependency_change");
  for (const path of input.changedPaths)
    for (const [pattern, factor, risk] of rules) if (pattern.test(path)) raise(risk, factor);
  if (input.verification === "failed") raise("BLOCKED", "verification_failed");
  if (input.verification === "unsupported") raise("BLOCKED", "verification_unsupported");
  if (input.preflightRequired && input.preflight !== "passed")
    raise("BLOCKED", input.preflight === "failed" ? "preflight_failed" : "preflight_required");
  if (input.staleBase) raise("BLOCKED", "stale_base");
  if (input.conflict) raise("BLOCKED", "patch_conflict");
  if (input.reviewDisposition === "review_required") factors.add("inherited_review_required");
  const reviewRequired = input.reviewDisposition === "review_required" || level !== "LOW";
  return {
    version: FIX_RISK_RULES_VERSION,
    level,
    factors: [...factors].sort(),
    reviewRequired,
    reviewReason:
      input.reviewDisposition === "review_required" ? "inherited_review_required" : null,
    draftPrEligible:
      input.provenanceMode === "customer" &&
      (level === "LOW" || level === "MEDIUM") &&
      input.verification === "passed" &&
      (!input.preflightRequired || input.preflight === "passed") &&
      !input.staleBase &&
      !input.conflict,
  };
}
