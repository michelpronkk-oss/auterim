/**
 * M15.79 coverage certification contract v1. Versioned types shared by the deterministic
 * evaluators, the future issuing RPC and every customer-visible protection claim.
 * See docs/m1579-coverage-certification.md.
 */
export const COVERAGE_CERTIFICATE_CONTRACT_VERSION = "coverage-cert-v1" as const;

/** Strongest first. A combination always takes the weakest member. */
export const COVERAGE_STATES = ["complete", "partial", "unsupported", "unknown"] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

export const COVERAGE_DIMENSIONS = [
  "dependency_sources",
  "repository_code",
  "deployment_exposure",
  "runtime_signals",
] as const;
export type CoverageDimension = (typeof COVERAGE_DIMENSIONS)[number];

/** Dimensions that must be `complete` for full protection; runtime signals only add strength. */
export const REQUIRED_DIMENSIONS = [
  "dependency_sources",
  "repository_code",
  "deployment_exposure",
] as const satisfies readonly CoverageDimension[];

export const COVERAGE_REASONS = [
  "covered",
  "partial_source_types",
  "no_configured_sources",
  "catalog_read_incomplete",
  "no_successful_scan",
  "scan_stale",
  "no_analysis",
  "analysis_not_completed",
  "analysis_partial",
  "analysis_unsupported",
  "analysis_failed",
  "analysis_commit_unverified",
  "analysis_commit_behind_head",
  "no_deployment_surface",
  "no_production_deployment",
  "sync_failed",
  "sync_stale",
  "commit_verified_only",
  "deployment_inconclusive",
  "runtime_provider_not_connected",
  "no_subjects",
] as const;
export type CoverageReason = (typeof COVERAGE_REASONS)[number];

/** Freshness bounds in the design; evidence older than these is `unknown`. */
export const SOURCE_SCAN_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const DEPLOYMENT_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type EvidenceRef = { kind: string; id: string; commitSha?: string };

export type SubjectEvaluation = {
  dimension: CoverageDimension;
  subjectType: string;
  subjectId: string;
  state: CoverageState;
  reason: CoverageReason;
  evidenceRefs: EvidenceRef[];
  /** Absent for subjects whose state does not depend on time-bounded evidence. */
  expiresAt?: string;
};

export const CLAIM_LEVELS = [
  "deployment_verified_protection",
  "code_verified_protection",
  "partial_protection",
  "unverified",
] as const;
export type ClaimLevel = (typeof CLAIM_LEVELS)[number];

export const EXPOSURE_STATES = ["proven", "disproven", "unknown"] as const;
export type ExposureState = (typeof EXPOSURE_STATES)[number];

export type CoverageCertificate = {
  contractVersion: typeof COVERAGE_CERTIFICATE_CONTRACT_VERSION;
  issuedAt: string;
  /** Earliest component expiry; the certificate is stale afterwards. */
  validUntil: string | null;
  dimensions: Record<CoverageDimension, CoverageState>;
  overallState: CoverageState;
  claimLevel: ClaimLevel;
  components: SubjectEvaluation[];
  componentsFingerprint: string;
};
