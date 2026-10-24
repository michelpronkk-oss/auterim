import type { SupabaseClient } from "@supabase/supabase-js";
import { protectionClaim } from "./claims";
import {
  CLAIM_LEVELS,
  COVERAGE_CERTIFICATE_CONTRACT_VERSION,
  COVERAGE_STATES,
  type ClaimLevel,
  type CoverageCertificate,
  type CoverageDimension,
  type CoverageReason,
  type CoverageState,
  type SubjectEvaluation,
} from "./contracts";
import { claimLevelAt, claimLevelFor } from "./evaluate";

export type PersistedCertificate = {
  id: string;
  sequence: number;
  contract_version: string;
  issued_at: string;
  valid_until: string | null;
  dependency_sources_state: string;
  repository_code_state: string;
  deployment_exposure_state: string;
  runtime_signals_state: string;
  overall_state: string;
  claim_level: string;
  components_fingerprint: string;
  component_count: number;
};

export type PersistedComponent = {
  dimension: string;
  subject_type: string;
  subject_id: string;
  state: string;
  reason: string;
  evidence_refs: unknown;
  expires_at: string | null;
};

export type CoverageCertificateView = {
  claim: { level: ClaimLevel; text: string };
  certificate: {
    id: string;
    sequence: number;
    issuedAt: string;
    validUntil: string | null;
    expired: boolean;
    dimensions: Record<CoverageDimension, CoverageState>;
    componentsFingerprint: string;
    components: Array<{
      dimension: string;
      subjectType: string;
      subjectId: string;
      state: CoverageState;
      reason: string;
      expiresAt: string | null;
    }>;
  } | null;
};

const UNVERIFIED = {
  level: "unverified" as const,
  text: "Protection not currently verified.",
};

const isState = (value: string): value is CoverageState =>
  (COVERAGE_STATES as readonly string[]).includes(value);

/** The weaker of two claim levels (CLAIM_LEVELS is ordered strongest first). */
function weakerClaim(a: ClaimLevel, b: ClaimLevel): ClaimLevel {
  return CLAIM_LEVELS.indexOf(a) >= CLAIM_LEVELS.indexOf(b) ? a : b;
}

/**
 * The customer-visible view of a persisted certificate. The claim is never stronger than the
 * stored claim level, than the level the stored dimension states support, or than an expired
 * certificate allows; anything unreadable or inconsistent is `unverified`.
 */
export function coverageCertificateView(
  row: PersistedCertificate | null,
  components: PersistedComponent[],
  now: Date,
): CoverageCertificateView {
  if (!row) return { claim: UNVERIFIED, certificate: null };
  const dimensionValues = {
    dependency_sources: row.dependency_sources_state,
    repository_code: row.repository_code_state,
    deployment_exposure: row.deployment_exposure_state,
    runtime_signals: row.runtime_signals_state,
  };
  const consistent =
    row.contract_version === COVERAGE_CERTIFICATE_CONTRACT_VERSION &&
    (CLAIM_LEVELS as readonly string[]).includes(row.claim_level) &&
    Object.values(dimensionValues).every(isState) &&
    components.length === row.component_count &&
    components.every((component) => isState(component.state));
  const dimensions = dimensionValues as Record<CoverageDimension, CoverageState>;
  const validUntil = row.valid_until ? new Date(row.valid_until).toISOString() : null;
  const expired = validUntil !== null && Date.parse(validUntil) <= now.getTime();
  const certificate = {
    id: row.id,
    sequence: row.sequence,
    issuedAt: new Date(row.issued_at).toISOString(),
    validUntil,
    expired,
    dimensions,
    componentsFingerprint: row.components_fingerprint,
    components: components.map((component) => ({
      dimension: component.dimension,
      subjectType: component.subject_type,
      subjectId: component.subject_id,
      state: (isState(component.state) ? component.state : "unknown") as CoverageState,
      reason: component.reason,
      expiresAt: component.expires_at ? new Date(component.expires_at).toISOString() : null,
    })),
  };
  if (!consistent) return { claim: UNVERIFIED, certificate };

  const claimLevel = weakerClaim(row.claim_level as ClaimLevel, claimLevelFor(dimensions));
  const forClaim: CoverageCertificate = {
    contractVersion: COVERAGE_CERTIFICATE_CONTRACT_VERSION,
    issuedAt: certificate.issuedAt,
    validUntil,
    dimensions,
    overallState: isState(row.overall_state) ? row.overall_state : "unknown",
    claimLevel,
    components: certificate.components.map((component): SubjectEvaluation => ({
      dimension: component.dimension as CoverageDimension,
      subjectType: component.subjectType,
      subjectId: component.subjectId,
      state: component.state,
      reason: component.reason as CoverageReason,
      evidenceRefs: [],
      ...(component.expiresAt ? { expiresAt: component.expiresAt } : {}),
    })),
    componentsFingerprint: row.components_fingerprint,
  };
  return {
    claim: { level: claimLevelAt(forClaim, now), text: protectionClaim(forClaim, now) },
    certificate,
  };
}

/**
 * Reads the latest certificate for a Product with the caller's own (RLS-scoped) client, so a
 * non-member reads nothing and is shown no claim.
 */
export async function readProductCoverageCertificate(
  client: SupabaseClient,
  input: { workspaceId: string; productId: string; now?: Date },
): Promise<CoverageCertificateView> {
  const latest = await client
    .from("product_coverage_certificates")
    .select(
      "id, sequence, contract_version, issued_at, valid_until, dependency_sources_state, repository_code_state, deployment_exposure_state, runtime_signals_state, overall_state, claim_level, components_fingerprint, component_count",
    )
    .eq("workspace_id", input.workspaceId)
    .eq("product_id", input.productId)
    .order("sequence", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest.error) throw new Error("coverage_certificate_unavailable");
  const row = latest.data as PersistedCertificate | null;
  if (!row) return coverageCertificateView(null, [], input.now ?? new Date());
  const parts = await client
    .from("product_coverage_certificate_components")
    .select("dimension, subject_type, subject_id, state, reason, evidence_refs, expires_at")
    .eq("workspace_id", input.workspaceId)
    .eq("certificate_id", row.id)
    .order("dimension")
    .order("subject_id");
  if (parts.error || !parts.data) throw new Error("coverage_certificate_unavailable");
  return coverageCertificateView(row, parts.data as PersistedComponent[], input.now ?? new Date());
}
