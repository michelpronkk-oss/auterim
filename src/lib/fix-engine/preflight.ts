export type CanonicalFixPreflightResult = {
  status: "passed" | "failed" | "ineligible";
  preflightRunId?: string;
  category?: string;
};
export type CanonicalFixPreflight = (input: {
  workspaceId: string;
  productId: string;
  repositoryId: string;
  baseSha: string;
  patchFingerprint: string;
}) => Promise<CanonicalFixPreflightResult>;

export async function runFixPreflight(input: {
  provenanceMode: "customer" | "evidence_only";
  required: boolean;
  scope: {
    workspaceId: string;
    productId: string;
    repositoryId: string;
    baseSha: string;
    patchFingerprint: string;
  };
  canonicalPreflight?: CanonicalFixPreflight;
}): Promise<CanonicalFixPreflightResult> {
  if (input.provenanceMode === "evidence_only")
    throw new Error("evidence_only_preflight_forbidden");
  if (!input.required) return { status: "ineligible", category: "preflight_not_required" };
  if (!input.canonicalPreflight) throw new Error("canonical_preflight_unavailable");
  // This callback must be the existing entitlement-aware Preflight path; this module never bills or bypasses it.
  const result = await input.canonicalPreflight(input.scope);
  if (result.status !== "passed" && result.status !== "failed" && result.status !== "ineligible")
    throw new Error("invalid_preflight_result");
  return result;
}
