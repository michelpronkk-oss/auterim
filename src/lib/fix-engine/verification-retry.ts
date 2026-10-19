import { z } from "zod";

export const RETRYABLE_VERIFICATION_RUNNER_CATEGORIES = [
  "runner_unavailable",
  "runner_queue_full",
  "runner_state_temporarily_unavailable",
  "runner_transport_ambiguous",
  "runner_poll_timeout",
  "runner_timeout_when_execution_may_continue",
] as const;

export const TERMINAL_VERIFICATION_RUNNER_CATEGORIES = [
  "runner_request_invalid",
  "runner_auth_failed",
  "runner_protocol_unsupported",
  "runner_result_invalid",
  "snapshot_identity_mismatch",
  "patch_identity_mismatch",
  "cache_identity_mismatch",
  "cache_signature_invalid",
  "cache_tree_invalid",
  "verification_unsupported",
  "verification_failed",
] as const;

export type RetryableVerificationRunnerCategory =
  (typeof RETRYABLE_VERIFICATION_RUNNER_CATEGORIES)[number];
export type TerminalVerificationRunnerCategory =
  (typeof TERMINAL_VERIFICATION_RUNNER_CATEGORIES)[number];

export const VERIFICATION_RUNNER_ADMISSION_STATES = [
  "not_sent",
  "unconfirmed",
  "rejected",
  "accepted",
] as const;
export type VerificationRunnerAdmissionState =
  (typeof VERIFICATION_RUNNER_ADMISSION_STATES)[number];

export type VerificationRunnerCorrelation = {
  jobId: string | null;
  requestFingerprint: string | null;
  admissionState: VerificationRunnerAdmissionState;
};

export const VERIFICATION_RUNNER_RESPONSE_CATEGORIES = [
  "runner_request_invalid",
  "runner_authentication_failed",
  "runner_protocol_unsupported",
  "verification_job_invalid",
  "verification_job_identity_invalid",
  "verification_job_identity_mismatch",
  "verification_request_fingerprint_mismatch",
  "verification_runner_capability_expired",
  "verification_runner_image_mismatch",
  "verification_command_identity_mismatch",
  "verification_patch_identity_mismatch",
  "verification_cache_artifact_mismatch",
  "verification_cache_identity_mismatch",
  "verification_cache_signature_invalid",
  "verification_artifact_url_invalid",
  "verification_artifact_origin_invalid",
  "verification_artifact_size_limit",
  "verification_artifact_unavailable",
  "verification_artifact_read_failed",
  "verification_artifact_fingerprint_mismatch",
  "verification_snapshot_artifact_path_invalid",
  "verification_patch_artifact_path_invalid",
  "verification_cache_artifact_path_invalid",
  "verification_snapshot_symlink_forbidden",
  "verification_snapshot_special_file_forbidden",
  "verification_snapshot_empty",
  "verification_snapshot_secret_detected",
  "verification_cache_symlink_forbidden",
  "verification_cache_special_file_forbidden",
  "verification_cache_tree_invalid",
  "verification_cache_tree_fingerprint_mismatch",
  "verification_cache_tree_file_count_mismatch",
  "verification_cache_tree_byte_count_mismatch",
  "verification_patch_unsafe",
  "verification_patch_secret_detected",
  "verification_patch_outside_plan",
  "verification_patch_conflict",
  "verification_job_id_conflict",
  "verification_runner_state_corrupt",
  "verification_runner_state_unavailable",
  "verification_runner_state_write_failed",
  "verification_runner_queue_full",
  "verification_runner_job_store_full",
  "verification_runner_spool_invalid",
  "verification_runner_spool_identity_mismatch",
  "verification_runner_spool_authentication_failed",
  "verification_runner_spool_path_invalid",
  "verification_runner_spool_artifact_invalid",
  "verification_archive_path_too_long",
  "verification_archive_invalid_size",
  "verification_archive_invalid_data",
  "verification_archive_unsafe_path",
  "verification_archive_file_limit",
  "verification_archive_size_limit",
  "verification_archive_special_file",
  "verification_archive_truncated",
  "verification_archive_invalid_header",
  "verification_archive_unsafe_entry",
  "verification_archive_git_metadata_forbidden",
  "verification_archive_secret_file",
  "verification_archive_duplicate_entry",
  "verification_archive_mutable_entry",
  "verification_archive_invalid_directory",
  "verification_command_unsupported",
  "verification_command_failed",
  "verification_runner_execution_failed",
  "verification_runner_cleanup_failed",
  "verification_runner_internal_error",
  "verification_job_not_found",
  "runner_route_not_found",
] as const;

export type VerificationRunnerResponseCategory =
  (typeof VERIFICATION_RUNNER_RESPONSE_CATEGORIES)[number];

const VERIFICATION_RUNNER_DIAGNOSTIC_PHASES = [
  "admission",
  "poll",
  "resubmission",
  "result_validation",
  "result_signature",
  "response_decode",
] as const;
const VERIFICATION_RUNNER_DIAGNOSTIC_REASONS = [
  "http_error",
  "request_schema_invalid",
  "request_capability_expired",
  "accepted_identity_mismatch",
  "response_body_invalid",
  "response_body_too_large",
  "response_body_unavailable",
  "result_schema_invalid",
  "result_identity_mismatch",
  "result_fingerprint_mismatch",
  "result_signature_missing",
  "result_signature_mismatch",
  "transport_ambiguous",
] as const;
const VERIFICATION_RUNNER_DIAGNOSTIC_IDENTITY_FIELDS = [
  "jobId",
  "requestFingerprint",
  "workspaceId",
  "productId",
  "repositoryId",
  "repositoryIdentity",
  "baseCommitSha",
  "patchId",
  "snapshotFingerprint",
  "patchFingerprint",
  "cacheIdentityKey",
  "cacheTreeSha256",
  "runtimeImage",
  "profileId",
  "profileVersion",
] as const;
export const VERIFICATION_RUNNER_ADMISSION_SUBPHASES = [
  "artifact_materialization",
  "artifact_download",
  "artifact_integrity_validation",
  "snapshot_archive_extraction",
  "snapshot_content_validation",
  "dependency_cache_validation",
  "spool_persistence",
  "spool_accounting",
  "spool_cleanup",
  "job_record_persistence",
  "admission_commit",
] as const;

const responseCategorySchema = z
  .string()
  .refine(
    (value) =>
      value === "unrecognized" ||
      (VERIFICATION_RUNNER_RESPONSE_CATEGORIES as readonly string[]).includes(value),
  );

/** Strict, bounded diagnostic contract. It intentionally has no value-bearing fields. */
export const VerificationRunnerFailureDiagnosticSchema = z
  .object({
    phase: z.enum(VERIFICATION_RUNNER_DIAGNOSTIC_PHASES),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    responseCategory: responseCategorySchema.nullable(),
    reason: z.enum(VERIFICATION_RUNNER_DIAGNOSTIC_REASONS),
    identityField: z.enum(VERIFICATION_RUNNER_DIAGNOSTIC_IDENTITY_FIELDS).optional(),
    admissionSubphase: z.enum(VERIFICATION_RUNNER_ADMISSION_SUBPHASES).optional(),
  })
  .strict();

export type VerificationRunnerFailureDiagnostic = z.infer<
  typeof VerificationRunnerFailureDiagnosticSchema
>;

export class VerificationRunnerFailure extends Error {
  constructor(
    readonly category: RetryableVerificationRunnerCategory | TerminalVerificationRunnerCategory,
    readonly retryable: boolean,
    readonly diagnostics: readonly VerificationRunnerFailureDiagnostic[] = [],
    readonly correlation: VerificationRunnerCorrelation | null = null,
  ) {
    super(category);
    this.name = "VerificationRunnerFailure";
  }
}

export function withVerificationRunnerCorrelation(
  error: VerificationRunnerFailure,
  correlation: VerificationRunnerCorrelation,
) {
  return new VerificationRunnerFailure(
    error.category,
    error.retryable,
    error.diagnostics,
    correlation,
  );
}

export function retryableRunnerFailure(
  category: RetryableVerificationRunnerCategory,
  diagnostics?:
    VerificationRunnerFailureDiagnostic | readonly VerificationRunnerFailureDiagnostic[],
) {
  return new VerificationRunnerFailure(category, true, normalizeDiagnostics(diagnostics));
}

export function terminalRunnerFailure(
  category: TerminalVerificationRunnerCategory,
  diagnostics?:
    VerificationRunnerFailureDiagnostic | readonly VerificationRunnerFailureDiagnostic[],
) {
  return new VerificationRunnerFailure(category, false, normalizeDiagnostics(diagnostics));
}

function normalizeDiagnostics(
  diagnostics?:
    VerificationRunnerFailureDiagnostic | readonly VerificationRunnerFailureDiagnostic[],
) {
  if (!diagnostics) return [];
  return z
    .array(VerificationRunnerFailureDiagnosticSchema)
    .max(4)
    .parse((Array.isArray(diagnostics) ? diagnostics : [diagnostics]).slice(-4));
}

export function isVerificationRunnerRetryableFailure(error: unknown): boolean {
  return error instanceof VerificationRunnerFailure && error.retryable;
}
