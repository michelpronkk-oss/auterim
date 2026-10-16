export type PositiveGraphEvidence = {
  id: string;
  edgeKind: "observed" | "inferred";
  path: string | null;
  startLine: number | null;
  startColumn: number | null;
  endLine: number | null;
  endColumn: number | null;
  evidenceType: string;
};

export type FixEligibilityInput = {
  workspaceId: string;
  productWorkspaceId: string;
  repositoryWorkspaceId: string;
  dependencyWorkspaceId: string;
  mappingWorkspaceId: string;
  sourceWorkspaceId: string | null;
  sourceProductId: string | null;
  productId: string;
  dependencyProductId: string;
  mappingProductId: string;
  graphStatus: string;
  graphWorkspaceId: string;
  graphProductId: string;
  graphRepositoryId: string;
  graphAnalysisRunId: string;
  graphCommitSha: string;
  analysisStatus: string;
  analysisWorkspaceId: string;
  analysisRepositoryId: string;
  analysisCommitSha: string;
  coverageState: "complete" | "partial" | "unsupported" | "failed";
  assessmentState: "evidence_present" | "absence_observed" | "unknown_incomplete" | "failed";
  sourceMode: "provider" | "internal_test";
  processingMode: "customer" | "evidence_only";
  productStatus: string;
  dependencyMonitoringEnabled: boolean;
  mappingStatus: string;
  repositoryStatus: string;
  positiveEvidence: PositiveGraphEvidence[];
};

export type FixEligibility = {
  eligible: boolean;
  state: "eligible_for_diagnosis" | "not_eligible";
  reason: string | null;
  provenanceMode?: "customer" | "evidence_only";
  evidenceIds: string[];
  coverageState: FixEligibilityInput["coverageState"];
  productionExposureState: "unknown";
};

export function evaluateFixEligibility(input: FixEligibilityInput): FixEligibility {
  const fail = (reason: string): FixEligibility => ({
    eligible: false,
    state: "not_eligible",
    reason,
    evidenceIds: [],
    coverageState: input.coverageState,
    productionExposureState: "unknown",
  });

  if (
    !input.workspaceId ||
    [
      input.productWorkspaceId,
      input.repositoryWorkspaceId,
      input.dependencyWorkspaceId,
      input.mappingWorkspaceId,
      input.graphWorkspaceId,
      input.analysisWorkspaceId,
    ].some((id) => id !== input.workspaceId)
  ) {
    return fail("workspace_scope_mismatch");
  }
  if (
    [input.dependencyProductId, input.mappingProductId, input.graphProductId].some(
      (id) => id !== input.productId,
    )
  ) {
    return fail("product_scope_mismatch");
  }
  if (input.graphStatus !== "completed" || input.analysisStatus !== "completed")
    return fail("evidence_not_completed");
  if (
    input.graphRepositoryId !== input.analysisRepositoryId ||
    input.graphCommitSha !== input.analysisCommitSha ||
    input.graphAnalysisRunId === "" ||
    input.graphCommitSha !== input.analysisCommitSha
  )
    return fail("exact_commit_identity_mismatch");
  if (
    input.productStatus !== "protected" ||
    input.mappingStatus !== "active" ||
    input.repositoryStatus !== "available" ||
    !input.dependencyMonitoringEnabled
  ) {
    return fail("protection_scope_inactive");
  }
  if (!(
    (input.sourceMode === "provider" &&
      input.processingMode === "customer" &&
      input.sourceWorkspaceId === null &&
      input.sourceProductId === null) ||
    (input.sourceMode === "internal_test" &&
      input.processingMode === "evidence_only" &&
      input.sourceWorkspaceId === input.workspaceId &&
      input.sourceProductId === input.productId)
  ))
    return fail("provenance_pair_invalid");
  if (
    input.coverageState === "unsupported" ||
    input.coverageState === "failed" ||
    input.assessmentState !== "evidence_present"
  ) {
    return fail("graph_coverage_not_eligible");
  }

  const observed = input.positiveEvidence.filter((edge) => edge.edgeKind === "observed");
  const exactPositive = observed.filter(
    (edge) =>
      edge.path !== null &&
      edge.startLine !== null &&
      edge.startColumn !== null &&
      edge.endLine !== null &&
      edge.endColumn !== null &&
      edge.startLine > 0 &&
      edge.startColumn > 0 &&
      edge.endLine >= edge.startLine &&
      edge.endColumn > 0,
  );
  if (exactPositive.length === 0) return fail("positive_exact_code_evidence_required");

  return {
    eligible: true,
    state: "eligible_for_diagnosis",
    reason: null,
    provenanceMode: input.sourceMode === "internal_test" ? "evidence_only" : "customer",
    evidenceIds: [...new Set(exactPositive.map((edge) => edge.id))].sort(),
    coverageState: input.coverageState,
    productionExposureState: "unknown",
  };
}
