import { z } from "zod";

export const FIX_ENGINE_CONTRACT_VERSION = "fix-engine-v1";
export const FIX_ELIGIBILITY_RULES_VERSION = "fix-eligibility-v1";
export const FIX_RISK_RULES_VERSION = "fix-risk-v1";

const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."),
    "path must be repository-relative",
  );

export const EvidenceSpanSchema = z
  .object({
    path: relativePath,
    startLine: z.number().int().positive(),
    startColumn: z.number().int().positive(),
    endLine: z.number().int().positive(),
    endColumn: z.number().int().positive(),
  })
  .strict()
  .refine(
    (span) => span.endLine > span.startLine || span.endColumn >= span.startColumn,
    "invalid span",
  );

export const DiagnosisSchema = z
  .object({
    rootCauseCategory: z.enum([
      "endpoint_contract_changed",
      "sdk_symbol_changed",
      "package_deprecated",
      "function_signature_changed",
      "schema_contract_changed",
      "configuration_contract_changed",
      "authentication_contract_changed",
      "unsupported_or_ambiguous",
    ]),
    affectedLocations: z
      .array(
        z
          .object({
            evidenceId: z.string().uuid(),
            span: EvidenceSpanSchema,
            symbol: z.string().max(160).nullable(),
            externalEntity: z.string().max(512),
          })
          .strict(),
      )
      .min(1)
      .max(25),
    recommendedTransformationClass: z.enum([
      "endpoint_replacement",
      "symbol_migration",
      "package_migration",
      "signature_adaptation",
      "schema_adaptation",
      "configuration_update",
      "manual_review_only",
    ]),
    confidenceClass: z.enum(["exact", "structural", "heuristic"]),
    changeFamily: z.enum([
      "endpoint",
      "sdk",
      "package",
      "signature",
      "schema",
      "auth",
      "configuration",
      "unknown",
    ]),
  })
  .strict();
export type FixDiagnosis = z.infer<typeof DiagnosisSchema>;

export const FixPlanSchema = z
  .object({
    allowedFiles: z
      .array(
        z
          .object({
            path: relativePath,
            evidenceIds: z.array(z.string().uuid()).min(1).max(25),
            transformations: z
              .array(
                z.enum([
                  "endpoint_replacement",
                  "symbol_migration",
                  "package_migration",
                  "signature_adaptation",
                  "schema_adaptation",
                  "configuration_update",
                ]),
              )
              .min(1)
              .max(6),
          })
          .strict(),
      )
      .min(1)
      .max(25),
    preconditions: z.array(z.string().min(1).max(240)).max(20),
    postconditions: z.array(z.string().min(1).max(240)).min(1).max(20),
    dependencyChanges: z
      .array(
        z
          .object({
            package: z.string().max(214),
            change: z.enum(["add", "remove", "update"]),
            targetRange: z.string().max(128).nullable(),
          })
          .strict(),
      )
      .max(10),
    apiSchemaConfigChanges: z
      .array(z.enum(["api", "schema", "configuration", "authentication", "public_api"]))
      .max(10),
    expectedTests: z.array(relativePath).max(30),
    verificationProfile: z.enum(["javascript-typescript-v1", "unsupported"]),
    preflightApplicability: z.enum(["required", "not_applicable"]),
    riskFactors: z
      .array(
        z.enum([
          "dependency_change",
          "auth_change",
          "schema_change",
          "public_api_change",
          "security_sensitive",
        ]),
      )
      .max(20),
    humanReviewRequired: z.boolean(),
  })
  .strict();
export type FixPlan = z.infer<typeof FixPlanSchema>;

// Policy-owned values are hydrated by Auterim from persisted run state.
// The model schema is the strict remainder of the same immutable plan contract.
export const FixPlanModelProposalSchema = FixPlanSchema.omit({
  preflightApplicability: true,
  humanReviewRequired: true,
});
export type FixPlanModelProposal = z.infer<typeof FixPlanModelProposalSchema>;

export const PatchProposalSchema = z
  .object({
    unifiedDiff: z.string().min(1).max(131072),
    baseSha: z.string().regex(/^[a-f0-9]{40,64}$/),
    planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    attemptIdentity: z.string().uuid(),
  })
  .strict();
export const PatchModelProposalSchema = PatchProposalSchema.omit({
  baseSha: true,
  planFingerprint: true,
  evidenceFingerprint: true,
  attemptIdentity: true,
});
export type PatchModelProposal = z.infer<typeof PatchModelProposalSchema>;

export const FixStageSchema = z.enum([
  "diagnose",
  "plan",
  "generate_patch",
  "apply_patch",
  "verify_patch",
  "preflight",
  "risk_assess",
  "create_draft_pr",
]);
export type FixStage = z.infer<typeof FixStageSchema>;

export const FixRiskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "BLOCKED"]);
export type FixRiskLevel = z.infer<typeof FixRiskLevelSchema>;

export function isSafeRepoPath(value: string): boolean {
  if (!relativePath.safeParse(value).success) return false;
  const lower = value.toLowerCase();
  const parts = lower.split("/");
  return (
    parts.every(
      (part) =>
        part.length > 0 &&
        part !== "." &&
        !/[\u0000-\u001f\u007f:*?"<>|]/.test(part) &&
        !/[. ]$/.test(part) &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    ) &&
    !parts.some(
      (part) =>
        part === ".git" ||
        part === "node_modules" ||
        part === "secrets" ||
        /^\.env(?:\.|$)/i.test(part),
    ) &&
    !lower.endsWith(".pem") &&
    !lower.endsWith(".key") &&
    !lower.endsWith(".p12") &&
    !lower.endsWith(".pfx")
  );
}
