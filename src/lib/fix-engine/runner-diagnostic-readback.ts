import { z } from "zod";
import {
  RETRYABLE_VERIFICATION_RUNNER_CATEGORIES,
  TERMINAL_VERIFICATION_RUNNER_CATEGORIES,
  VerificationRunnerFailureDiagnosticSchema,
} from "@/lib/fix-engine/verification-retry";

const runnerDiagnosticEventSchema = z
  .object({
    id: z.string().uuid(),
    stage_id: z.string().uuid(),
    attempt_number: z.number().int().min(1).max(4),
    failure_category: z
      .string()
      .refine((value) =>
        (
          [
            ...RETRYABLE_VERIFICATION_RUNNER_CATEGORIES,
            ...TERMINAL_VERIFICATION_RUNNER_CATEGORIES,
          ] as readonly string[]
        ).includes(value),
      ),
    retryable: z.boolean(),
    diagnostics: z.array(VerificationRunnerFailureDiagnosticSchema).max(4),
    job_id: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    request_fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    admission_state: z.enum(["not_sent", "unconfirmed", "rejected", "accepted"]).nullable(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((event) => {
    const expectedRetryable = (
      RETRYABLE_VERIFICATION_RUNNER_CATEGORIES as readonly string[]
    ).includes(event.failure_category);
    return event.retryable === expectedRetryable;
  })
  .refine((event) => {
    if (event.job_id === null || event.request_fingerprint === null)
      return event.job_id === null && event.request_fingerprint === null;
    return event.admission_state !== null;
  })
  .refine((event) => event.admission_state !== "accepted" || event.job_id !== null);

/** Returns null for malformed or unbounded rows; never forwards unknown DB fields. */
export function sanitizeM1578RRunnerDiagnosticEvents(value: unknown) {
  if (!Array.isArray(value) || value.length > 4) return null;
  const parsed = z.array(runnerDiagnosticEventSchema).max(4).safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.map((event) => ({
    id: event.id,
    stageId: event.stage_id,
    attemptNumber: event.attempt_number,
    failureCategory: event.failure_category,
    retryable: event.retryable,
    diagnostics: event.diagnostics,
    jobId: event.job_id,
    requestFingerprint: event.request_fingerprint,
    admissionState: event.admission_state,
    createdAt: event.created_at,
  }));
}
