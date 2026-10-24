import { createHash } from "node:crypto";
import {
  COVERAGE_CERTIFICATE_CONTRACT_VERSION,
  COVERAGE_DIMENSIONS,
  COVERAGE_STATES,
  DEPLOYMENT_SYNC_MAX_AGE_MS,
  SOURCE_SCAN_MAX_AGE_MS,
  type ClaimLevel,
  type CoverageCertificate,
  type CoverageDimension,
  type CoverageState,
  type ExposureState,
  type SubjectEvaluation,
} from "./contracts";

/** The weakest state in the list; an empty list is `unknown` (absence is never coverage). */
export function weakestState(states: readonly CoverageState[]): CoverageState {
  if (states.length === 0) return "unknown";
  return states.reduce((weakest, state) =>
    COVERAGE_STATES.indexOf(state) > COVERAGE_STATES.indexOf(weakest) ? state : weakest,
  );
}

const iso = (ms: number) => new Date(ms).toISOString();

/** One confirmed dependency, from its enabled global sources and their latest successful scans. */
export function evaluateDependencySources(input: {
  dependencyId: string;
  catalogReadComplete: boolean;
  sources: Array<{ sourceId: string; sourceType: string; lastSuccessAt: string | null }>;
  now: Date;
}): SubjectEvaluation {
  const base = {
    dimension: "dependency_sources" as const,
    subjectType: "workspace_dependency",
    subjectId: input.dependencyId,
    evidenceRefs: input.sources.map((source) => ({ kind: "source", id: source.sourceId })),
  };
  if (!input.catalogReadComplete)
    return { ...base, state: "unknown", reason: "catalog_read_incomplete" };
  if (input.sources.length === 0)
    return { ...base, state: "unsupported", reason: "no_configured_sources" };
  if (input.sources.some((source) => source.lastSuccessAt === null))
    return { ...base, state: "unknown", reason: "no_successful_scan" };
  const oldestSuccess = Math.min(
    ...input.sources.map((source) => Date.parse(source.lastSuccessAt as string)),
  );
  const expiresAt = oldestSuccess + SOURCE_SCAN_MAX_AGE_MS;
  if (!Number.isFinite(oldestSuccess) || expiresAt <= input.now.getTime())
    return { ...base, state: "unknown", reason: "scan_stale" };
  const sourceTypes = new Set(input.sources.map((source) => source.sourceType)).size;
  return sourceTypes >= 3
    ? { ...base, state: "complete", reason: "covered", expiresAt: iso(expiresAt) }
    : { ...base, state: "partial", reason: "partial_source_types", expiresAt: iso(expiresAt) };
}

/**
 * One active Product/repository mapping. Code evidence counts only for the commit that
 * matters: the production-verified commit when one exists, otherwise the repository head.
 */
export function evaluateRepositoryCode(input: {
  repositoryId: string;
  analysis: {
    runId: string;
    commitSha: string;
    status: string;
    coverageState: "complete" | "partial" | "unsupported" | "failed";
  } | null;
  headCommitSha: string | null;
  productionCommitSha: string | null;
}): SubjectEvaluation {
  const base = {
    dimension: "repository_code" as const,
    subjectType: "product_repository",
    subjectId: input.repositoryId,
    evidenceRefs: input.analysis
      ? [
          {
            kind: "code_analysis_run",
            id: input.analysis.runId,
            commitSha: input.analysis.commitSha,
          },
        ]
      : [],
  };
  const analysis = input.analysis;
  if (!analysis) return { ...base, state: "unknown", reason: "no_analysis" };
  if (analysis.status !== "completed")
    return { ...base, state: "unknown", reason: "analysis_not_completed" };
  if (analysis.coverageState === "failed")
    return { ...base, state: "unknown", reason: "analysis_failed" };
  if (analysis.coverageState === "unsupported")
    return { ...base, state: "unsupported", reason: "analysis_unsupported" };
  const target = input.productionCommitSha ?? input.headCommitSha;
  if (!target) return { ...base, state: "unknown", reason: "analysis_commit_unverified" };
  if (analysis.commitSha.toLowerCase() !== target.toLowerCase())
    return { ...base, state: "unknown", reason: "analysis_commit_behind_head" };
  return analysis.coverageState === "complete"
    ? { ...base, state: "complete", reason: "covered" }
    : { ...base, state: "partial", reason: "analysis_partial" };
}

/** One Product deployment surface, from M15.7 Product-specific evidence and sync freshness. */
export function evaluateDeploymentExposure(input: {
  surfaceId: string;
  evidence: {
    evidenceId: string;
    verificationState:
      "mapped" | "commit_verified" | "production_verified" | "inconclusive" | "historical";
    verifiedCommitSha: string | null;
  } | null;
  lastSync: { status: "succeeded" | "failed"; completedAt: string } | null;
  now: Date;
}): SubjectEvaluation {
  const base = {
    dimension: "deployment_exposure" as const,
    subjectType: "deployment_surface",
    subjectId: input.surfaceId,
    evidenceRefs: input.evidence
      ? [
          {
            kind: "product_deployment_evidence",
            id: input.evidence.evidenceId,
            ...(input.evidence.verifiedCommitSha
              ? { commitSha: input.evidence.verifiedCommitSha }
              : {}),
          },
        ]
      : [],
  };
  if (!input.lastSync || input.lastSync.status !== "succeeded")
    return { ...base, state: "unknown", reason: "sync_failed" };
  const expiresAt = Date.parse(input.lastSync.completedAt) + DEPLOYMENT_SYNC_MAX_AGE_MS;
  if (!Number.isFinite(expiresAt) || expiresAt <= input.now.getTime())
    return { ...base, state: "unknown", reason: "sync_stale" };
  const evidence = input.evidence;
  if (!evidence) return { ...base, state: "unknown", reason: "no_production_deployment" };
  if (evidence.verificationState === "production_verified" && evidence.verifiedCommitSha)
    return { ...base, state: "complete", reason: "covered", expiresAt: iso(expiresAt) };
  if (evidence.verificationState === "commit_verified")
    return { ...base, state: "partial", reason: "commit_verified_only", expiresAt: iso(expiresAt) };
  return { ...base, state: "unknown", reason: "deployment_inconclusive" };
}

/** Optional runtime evidence. Without an adapter it is `unknown` and never blocks protection. */
export function evaluateRuntimeSignals(): SubjectEvaluation {
  return {
    dimension: "runtime_signals",
    subjectType: "runtime_provider",
    subjectId: "none",
    state: "unknown",
    reason: "runtime_provider_not_connected",
    evidenceRefs: [],
  };
}

/**
 * Claim level from dimension states. Sources and code are the core of protection; missing
 * deployment evidence caps the claim at code-verified instead of hiding coverage that exists.
 */
export function claimLevelFor(dimensions: Record<CoverageDimension, CoverageState>): ClaimLevel {
  const sources = dimensions.dependency_sources;
  const code = dimensions.repository_code;
  const deployment = dimensions.deployment_exposure;
  if (sources === "unknown" || code === "unknown") return "unverified";
  if (sources !== "complete" || code !== "complete") return "partial_protection";
  return deployment === "complete" ? "deployment_verified_protection" : "code_verified_protection";
}

/** Canonical JSON: sorted object keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, item]) => [key, normalize(item)]),
      );
    return input;
  };
  return JSON.stringify(normalize(value));
}

const componentOrder = (left: SubjectEvaluation, right: SubjectEvaluation) =>
  `${left.dimension}\u0000${left.subjectType}\u0000${left.subjectId}` <
  `${right.dimension}\u0000${right.subjectType}\u0000${right.subjectId}`
    ? -1
    : 1;

/**
 * Builds a certificate. The fingerprint covers the contract version and the ordered
 * components only (not the issue time), so reissuing on unchanged evidence is idempotent.
 */
export function buildCertificate(input: {
  components: SubjectEvaluation[];
  issuedAt: Date;
}): CoverageCertificate {
  const components = [...input.components].sort(componentOrder);
  const dimensions = Object.fromEntries(
    COVERAGE_DIMENSIONS.map((dimension) => [
      dimension,
      weakestState(components.filter((c) => c.dimension === dimension).map((c) => c.state)),
    ]),
  ) as Record<CoverageDimension, CoverageState>;
  const expiries = components
    .map((component) => component.expiresAt)
    .filter((value): value is string => typeof value === "string")
    .sort();
  return {
    contractVersion: COVERAGE_CERTIFICATE_CONTRACT_VERSION,
    issuedAt: input.issuedAt.toISOString(),
    validUntil: expiries[0] ?? null,
    dimensions,
    overallState: weakestState([
      dimensions.dependency_sources,
      dimensions.repository_code,
      dimensions.deployment_exposure,
    ]),
    claimLevel: claimLevelFor(dimensions),
    components,
    componentsFingerprint: createHash("sha256")
      .update(canonicalJson({ contractVersion: COVERAGE_CERTIFICATE_CONTRACT_VERSION, components }))
      .digest("hex"),
  };
}

/** The claim a certificate supports at a given time; an expired certificate supports none. */
export function claimLevelAt(certificate: CoverageCertificate, asOf: Date): ClaimLevel {
  if (certificate.validUntil && Date.parse(certificate.validUntil) <= asOf.getTime())
    return "unverified";
  return certificate.claimLevel;
}

export type ExposureAssessment = {
  state: ExposureState;
  reason:
    | "deployed_commit_contains_impacted_code"
    | "complete_negative_analysis_at_deployed_commit"
    | "deployment_not_production_verified"
    | "analysis_commit_not_deployed"
    | "graph_evidence_incomplete";
};

/** The only Code Intelligence profile allowed to make a negative assessment (M15.77). */
export const NEGATIVE_ASSESSMENT_PROFILE = "javascript-typescript-v2.3";

/**
 * Production exposure of one impact-graph build. `proven` and `disproven` both require a
 * fresh production-verified deployment of exactly the analysed commit; `disproven`
 * additionally requires a complete negative analysis from the negative-capable profile.
 */
export function assessExposure(input: {
  graph: {
    assessmentState: "evidence_present" | "absence_observed" | "unknown_incomplete" | "failed";
    analysisCommitSha: string;
    analysisProfile: string;
    analysisCoverageState: "complete" | "partial" | "unsupported" | "failed";
  };
  deployment: SubjectEvaluation | null;
}): ExposureAssessment {
  const deployment = input.deployment;
  const deployedCommit = deployment?.evidenceRefs.find(
    (ref) => ref.kind === "product_deployment_evidence",
  )?.commitSha;
  if (
    !deployment ||
    deployment.dimension !== "deployment_exposure" ||
    deployment.state !== "complete" ||
    !deployedCommit
  )
    return { state: "unknown", reason: "deployment_not_production_verified" };
  if (deployedCommit.toLowerCase() !== input.graph.analysisCommitSha.toLowerCase())
    return { state: "unknown", reason: "analysis_commit_not_deployed" };
  if (input.graph.assessmentState === "evidence_present")
    return { state: "proven", reason: "deployed_commit_contains_impacted_code" };
  if (
    input.graph.assessmentState === "absence_observed" &&
    input.graph.analysisProfile === NEGATIVE_ASSESSMENT_PROFILE &&
    input.graph.analysisCoverageState === "complete"
  )
    return { state: "disproven", reason: "complete_negative_analysis_at_deployed_commit" };
  return { state: "unknown", reason: "graph_evidence_incomplete" };
}
