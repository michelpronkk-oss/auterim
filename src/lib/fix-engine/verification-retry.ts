export const RETRYABLE_VERIFICATION_RUNNER_CATEGORIES = [
  "runner_unavailable",
  "runner_queue_full",
  "runner_state_temporarily_unavailable",
  "runner_transport_ambiguous",
  "runner_poll_timeout",
  "runner_timeout_when_execution_may_continue",
] as const;

export const TERMINAL_VERIFICATION_RUNNER_CATEGORIES = [
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

export class VerificationRunnerFailure extends Error {
  constructor(
    readonly category: RetryableVerificationRunnerCategory | TerminalVerificationRunnerCategory,
    readonly retryable: boolean,
  ) {
    super(category);
    this.name = "VerificationRunnerFailure";
  }
}

export function retryableRunnerFailure(category: RetryableVerificationRunnerCategory) {
  return new VerificationRunnerFailure(category, true);
}

export function terminalRunnerFailure(category: TerminalVerificationRunnerCategory) {
  return new VerificationRunnerFailure(category, false);
}

export function isVerificationRunnerRetryableFailure(error: unknown): boolean {
  return error instanceof VerificationRunnerFailure && error.retryable;
}
