import {
  DiagnosisSchema,
  FixPlanSchema,
  type FixDiagnosis,
  isSafeRepoPath,
} from "@/lib/fix-engine/contracts";
import { stableFingerprint } from "@/lib/fix-engine/identity";

export type PinnedEvidence = {
  id: string;
  path: string;
  span: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  externalEntity: string;
  symbol: string | null;
};

export function validateProposedDiagnosis(input: {
  proposal: unknown;
  evidence: PinnedEvidence[];
  workspaceId: string;
  expectedWorkspaceId: string;
  repositoryId: string;
  expectedRepositoryId: string;
  commitSha: string;
  expectedCommitSha: string;
}) {
  if (
    input.workspaceId !== input.expectedWorkspaceId ||
    input.repositoryId !== input.expectedRepositoryId ||
    input.commitSha.toLowerCase() !== input.expectedCommitSha.toLowerCase()
  )
    throw new Error("diagnosis_identity_mismatch");
  const diagnosis = DiagnosisSchema.parse(input.proposal);
  const byId = new Map(input.evidence.map((item) => [item.id, item]));
  for (const location of diagnosis.affectedLocations) {
    const evidence = byId.get(location.evidenceId);
    if (!evidence) throw new Error("diagnosis_invented_evidence");
    if (
      !isSafeRepoPath(location.span.path) ||
      location.span.path !== evidence.path ||
      location.span.startLine !== evidence.span.startLine ||
      location.span.startColumn !== evidence.span.startColumn ||
      location.span.endLine !== evidence.span.endLine ||
      location.span.endColumn !== evidence.span.endColumn ||
      location.externalEntity !== evidence.externalEntity ||
      location.symbol !== evidence.symbol
    ) {
      throw new Error("diagnosis_evidence_provenance_mismatch");
    }
  }
  const value = {
    ...diagnosis,
    affectedLocations: [...diagnosis.affectedLocations].sort((a, b) =>
      a.evidenceId.localeCompare(b.evidenceId),
    ),
  };
  return {
    diagnosis: value,
    outputFingerprint: stableFingerprint(value),
    evidenceIds: value.affectedLocations.map((item) => item.evidenceId),
  };
}

export function validateProposedFixPlan(input: {
  proposal: unknown;
  diagnosis: FixDiagnosis;
  preflightRequired: boolean;
  reviewRequired?: boolean;
}) {
  const plan = FixPlanSchema.parse(input.proposal);
  if ((plan.preflightApplicability === "required") !== input.preflightRequired)
    throw new Error("fix_plan_preflight_policy_mismatch");
  const evidencePaths = new Set(input.diagnosis.affectedLocations.map((item) => item.span.path));
  const evidenceIds = new Set(input.diagnosis.affectedLocations.map((item) => item.evidenceId));
  const paths = new Set<string>();
  for (const file of plan.allowedFiles) {
    if (!isSafeRepoPath(file.path) || !evidencePaths.has(file.path) || paths.has(file.path))
      throw new Error("fix_plan_path_not_grounded");
    if (file.evidenceIds.some((id) => !evidenceIds.has(id)) || file.evidenceIds.length === 0)
      throw new Error("fix_plan_evidence_not_grounded");
    paths.add(file.path);
  }
  if (
    (input.reviewRequired ||
      input.diagnosis.recommendedTransformationClass === "manual_review_only") &&
    !plan.humanReviewRequired
  ) {
    throw new Error("fix_plan_cannot_remove_review_requirement");
  }
  return plan;
}
