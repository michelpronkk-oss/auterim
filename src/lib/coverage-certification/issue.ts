import type { CoverageCertificate } from "./contracts";
import { canonicalJson } from "./evaluate";

/**
 * Arguments for `issue_product_coverage_certificate`. The canonical text is exactly the
 * fingerprint input of `buildCertificate`, so the database can bind the stored components to
 * the fingerprint without re-implementing canonical JSON.
 */
export function certificateIssueArguments(input: {
  workspaceId: string;
  productId: string;
  certificate: CoverageCertificate;
}) {
  const { certificate } = input;
  return {
    p_workspace_id: input.workspaceId,
    p_product_id: input.productId,
    p_contract_version: certificate.contractVersion,
    p_components: certificate.components,
    p_canonical_text: canonicalJson({
      contractVersion: certificate.contractVersion,
      components: certificate.components,
    }),
    p_components_fingerprint: certificate.componentsFingerprint,
  };
}
