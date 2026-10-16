import { createHash } from "node:crypto";
import {
  FIX_ELIGIBILITY_RULES_VERSION,
  FIX_ENGINE_CONTRACT_VERSION,
} from "@/lib/fix-engine/contracts";

export type CanonicalFixIdentityInput = {
  workspaceId: string;
  productId: string;
  repositoryId: string;
  providerRepositoryIdentity: string;
  workspaceDependencyId: string;
  productRepositoryMappingId: string;
  sourceChangeId: string;
  sourceMode: "provider" | "internal_test";
  processingMode: "customer" | "evidence_only";
  classificationId: string;
  intelligenceDecisionId: string;
  routeIntentId: string;
  semanticRoute: string;
  routeTarget: string;
  analysisRunId: string;
  graphBuildId: string;
  commitSha: string;
  analyzerVersion: string;
  analysisProfile: string;
  graphBuilderVersion: string;
  policyVersion: string;
  reviewDisposition: "none" | "review_required";
  reviewReason: string | null;
  positiveGraphEvidenceIds: string[];
  evidenceFingerprint: string;
  preflightRequired: boolean;
};

export type CanonicalFixIdentity = CanonicalFixIdentityInput & {
  provenanceMode: "customer" | "evidence_only";
  eligibilityRulesVersion: string;
  contractVersion: string;
  canonicalJson: string;
  identityFingerprint: string;
  idempotencyKey: string;
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

export function buildCanonicalFixIdentity(input: CanonicalFixIdentityInput): CanonicalFixIdentity {
  if (!/^[a-f0-9]{40,64}$/i.test(input.commitSha)) throw new Error("invalid_fix_commit_sha");
  if (!/^[a-f0-9]{64}$/i.test(input.evidenceFingerprint))
    throw new Error("invalid_fix_evidence_fingerprint");
  if (
    !input.providerRepositoryIdentity.includes("/") ||
    input.providerRepositoryIdentity.length > 511
  ) {
    throw new Error("invalid_fix_repository_identity");
  }
  if (!(
    (input.sourceMode === "provider" && input.processingMode === "customer") ||
    (input.sourceMode === "internal_test" && input.processingMode === "evidence_only")
  )) {
    throw new Error("invalid_fix_provenance_pair");
  }
  const evidenceIds = [...new Set(input.positiveGraphEvidenceIds)].sort();
  if (!evidenceIds.length || evidenceIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) {
    throw new Error("fix_requires_positive_evidence_ids");
  }
  const provenanceMode: CanonicalFixIdentity["provenanceMode"] =
    input.sourceMode === "internal_test" ? "evidence_only" : "customer";
  const canonicalValue = {
    ...input,
    providerRepositoryIdentity: input.providerRepositoryIdentity.toLowerCase(),
    commitSha: input.commitSha.toLowerCase(),
    positiveGraphEvidenceIds: evidenceIds,
    provenanceMode,
    eligibilityRulesVersion: FIX_ELIGIBILITY_RULES_VERSION,
    contractVersion: FIX_ENGINE_CONTRACT_VERSION,
  };
  const canonicalJson = JSON.stringify(stable(canonicalValue));
  const identityFingerprint = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
  return {
    ...canonicalValue,
    canonicalJson,
    identityFingerprint,
    idempotencyKey: identityFingerprint,
  };
}

export function stableFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)), "utf8")
    .digest("hex");
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stable(value));
}
