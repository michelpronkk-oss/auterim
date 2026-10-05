import type { WorkspaceEntitlements } from "@/lib/billing/plan-catalog";

export type ProductRemediationPolicy = {
  version: number;
  enabled: boolean;
  draftPullRequestPreparationAllowed: boolean;
  automaticWorkflowHandoffAllowed: boolean;
  approvalRequired: boolean;
  allowedRepositoryIds: string[];
};

export type BusinessActionDecision =
  | { allowed: true; approvalRequired: boolean; policyVersion: number }
  | {
      allowed: false;
      reason:
        | "business_capability_required"
        | "policy_disabled"
        | "repository_not_allowed"
        | "validation_required"
        | "archived_product"
        | "stale_policy";
    };

/** Explicit product/repository policy is required in addition to canonical plan entitlements. */
export function evaluateBusinessHandoff(input: {
  entitlements: WorkspaceEntitlements;
  policy: ProductRemediationPolicy | null;
  requestedPolicyVersion: number;
  repositoryId: string;
  productStatus: "protected" | "archived" | "draft";
  validationState: "validated" | "failed" | "pending";
}): BusinessActionDecision {
  if (
    !input.entitlements.capabilities.automaticRemediation ||
    !input.entitlements.capabilities.automaticDraftPr
  ) {
    return { allowed: false, reason: "business_capability_required" };
  }
  if (input.productStatus === "archived") return { allowed: false, reason: "archived_product" };
  const policy = input.policy;
  if (
    !policy?.enabled ||
    !policy.draftPullRequestPreparationAllowed ||
    !policy.automaticWorkflowHandoffAllowed
  ) {
    return { allowed: false, reason: "policy_disabled" };
  }
  if (policy.version !== input.requestedPolicyVersion)
    return { allowed: false, reason: "stale_policy" };
  if (!policy.allowedRepositoryIds.includes(input.repositoryId)) {
    return { allowed: false, reason: "repository_not_allowed" };
  }
  if (input.validationState !== "validated")
    return { allowed: false, reason: "validation_required" };
  return {
    allowed: true,
    approvalRequired: policy.approvalRequired,
    policyVersion: policy.version,
  };
}
