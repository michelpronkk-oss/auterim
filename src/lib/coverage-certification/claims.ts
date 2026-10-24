import type { CoverageCertificate, CoverageDimension } from "./contracts";
import { claimLevelAt } from "./evaluate";

const DIMENSION_LABELS: Record<CoverageDimension, string> = {
  dependency_sources: "dependency sources",
  repository_code: "repository code",
  deployment_exposure: "Production deployment",
  runtime_signals: "runtime signals",
};

/**
 * Customer-visible protection sentence. Its only input is a certificate (and the time it is
 * shown), so no wording can claim more than the certificate supports.
 */
export function protectionClaim(certificate: CoverageCertificate, asOf: Date): string {
  const level = claimLevelAt(certificate, asOf);
  const gaps = (["dependency_sources", "repository_code", "deployment_exposure"] as const)
    .filter((dimension) => certificate.dimensions[dimension] !== "complete")
    .map((dimension) => `${DIMENSION_LABELS[dimension]}: ${certificate.dimensions[dimension]}`);
  switch (level) {
    case "deployment_verified_protection":
      return "Protected: monitored dependency sources, and code analysed at the commit verified as running in Production.";
    case "code_verified_protection":
      return `Protected at the analysed commit; Production deployment not verified (${gaps.join("; ")}).`;
    case "partial_protection":
      return `Partially protected (${gaps.join("; ")}).`;
    case "unverified":
      return "Protection not currently verified.";
  }
}
