import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeM1578RRunnerDiagnosticEvents } from "@/lib/fix-engine/runner-diagnostic-readback";
import { VerificationRunnerFailureDiagnosticSchema } from "@/lib/fix-engine/verification-retry";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20261222000000_m1578r_runner_diagnostic_readback.sql",
    import.meta.url,
  ),
  "utf8",
);
const freshEvidenceMigration = readFileSync(
  new URL(
    "../supabase/migrations/20261224000000_m1578r_fresh_acceptance_runner_evidence.sql",
    import.meta.url,
  ),
  "utf8",
);
const admissionSubphaseMigration = readFileSync(
  new URL(
    "../supabase/migrations/20261225000000_m1578r_admission_subphase_diagnostics.sql",
    import.meta.url,
  ),
  "utf8",
);
const stageRuntime = readFileSync(
  new URL("../src/lib/fix-engine/stage-runtime.ts", import.meta.url),
  "utf8",
);
const readbackTask = readFileSync(
  new URL("../src/trigger/m1578r-internal-test-acceptance.ts", import.meta.url),
  "utf8",
);

const diagnostic = {
  phase: "admission",
  httpStatus: 422,
  responseCategory: "verification_artifact_unavailable",
  reason: "http_error",
  admissionSubphase: "artifact_download",
} as const;
const event = {
  id: "11111111-1111-4111-8111-111111111111",
  stage_id: "bd3238d9-79a9-46ca-88d1-e67f346ecc0a",
  attempt_number: 3,
  failure_category: "runner_result_invalid",
  retryable: false,
  diagnostics: [diagnostic],
  job_id: "a".repeat(64),
  request_fingerprint: "b".repeat(64),
  admission_state: "rejected",
  created_at: "2026-10-18T00:00:00.000Z",
};

describe("M15.78R durable runner diagnostic contract", () => {
  it("accepts only bounded phase/status/category/reason/field values", () => {
    expect(VerificationRunnerFailureDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
    expect(
      VerificationRunnerFailureDiagnosticSchema.safeParse({
        ...diagnostic,
        identityField: "patchFingerprint",
      }).success,
    ).toBe(true);
    expect(
      VerificationRunnerFailureDiagnosticSchema.safeParse({ ...diagnostic, httpStatus: 99 })
        .success,
    ).toBe(false);
    expect(
      VerificationRunnerFailureDiagnosticSchema.safeParse({ ...diagnostic, phase: "request_body" })
        .success,
    ).toBe(false);
    expect(
      VerificationRunnerFailureDiagnosticSchema.safeParse({
        ...diagnostic,
        responseCategory: "authorization_header",
      }).success,
    ).toBe(false);
    expect(
      VerificationRunnerFailureDiagnosticSchema.safeParse({ ...diagnostic, reason: "raw_response" })
        .success,
    ).toBe(false);
    expect(
      VerificationRunnerFailureDiagnosticSchema.safeParse({ ...diagnostic, body: "private" })
        .success,
    ).toBe(false);
    expect(
      VerificationRunnerFailureDiagnosticSchema.safeParse({
        ...diagnostic,
        admissionSubphase: "C:\\private\\signed-url",
      }).success,
    ).toBe(false);
  });

  it("readbacks only four strictly shaped events and strips unknown database fields", () => {
    expect(sanitizeM1578RRunnerDiagnosticEvents([event])).toEqual([
      {
        id: event.id,
        stageId: event.stage_id,
        attemptNumber: 3,
        failureCategory: "runner_result_invalid",
        retryable: false,
        diagnostics: [diagnostic],
        jobId: "a".repeat(64),
        requestFingerprint: "b".repeat(64),
        admissionState: "rejected",
        createdAt: event.created_at,
      },
    ]);
    expect(sanitizeM1578RRunnerDiagnosticEvents(Array.from({ length: 5 }, () => event))).toBeNull();
    expect(
      sanitizeM1578RRunnerDiagnosticEvents([{ ...event, signedUrl: "https://private.invalid/x" }]),
    ).toBeNull();
    expect(
      sanitizeM1578RRunnerDiagnosticEvents([
        { ...event, diagnostics: [{ ...diagnostic, body: "raw" }] },
      ]),
    ).toBeNull();
    expect(sanitizeM1578RRunnerDiagnosticEvents([{ ...event, retryable: true }])).toBeNull();
    expect(
      sanitizeM1578RRunnerDiagnosticEvents([
        { ...event, job_id: null, request_fingerprint: "b".repeat(64) },
      ]),
    ).toBeNull();
    expect(
      sanitizeM1578RRunnerDiagnosticEvents([
        { ...event, admission_state: "accepted", job_id: null, request_fingerprint: null },
      ]),
    ).toBeNull();
  });

  it("persists bounded admission identity and signed result identity without widening table writes", () => {
    expect(freshEvidenceMigration).toContain("runner_request_fingerprint text");
    expect(freshEvidenceMigration).toContain("runner_result_signature_validated is true");
    expect(freshEvidenceMigration).toContain("job_id text");
    expect(freshEvidenceMigration).toContain("admission_state text");
    expect(freshEvidenceMigration).toContain("complete_fix_stage_with_runner_diagnostics_v2");
    expect(freshEvidenceMigration).toContain("record_fix_verification_runner_result");
    expect(freshEvidenceMigration).toContain(
      "grant execute on function public.record_fix_verification_runner_result",
    );
    expect(freshEvidenceMigration).not.toMatch(
      /grant\s+(?:insert|all)\s+on\s+public\.fix_verification_runs\s+to\s+(?:authenticated|anon)/i,
    );
    expect(freshEvidenceMigration).toContain("'not_sent', 'unconfirmed', 'rejected', 'accepted'");
    expect(freshEvidenceMigration).not.toContain("response_body text");
    expect(freshEvidenceMigration).not.toContain("signed_url text");
  });

  it("persists diagnostics and the original stage transition through a service-only atomic RPC", () => {
    expect(migration).toContain("unique (stage_id, claim_token)");
    expect(migration).not.toContain("jsonb_object_length");
    expect(migration).toContain(
      "(v_item - array['phase','httpStatus','responseCategory','reason','identityField']) <> '{}'::jsonb",
    );
    expect(migration).toContain(
      "v_item ?& array['phase','httpStatus','responseCategory','reason']",
    );
    expect(migration).toContain("jsonb_array_length(diagnostics) <= 4");
    expect(admissionSubphaseMigration).toContain(
      "create or replace function public.complete_fix_stage_with_runner_diagnostics(",
    );
    expect(admissionSubphaseMigration).toContain("'verification_runner_internal_error'");
    expect(admissionSubphaseMigration).toContain("'runner_request_invalid', 'runner_auth_failed'");
    expect(admissionSubphaseMigration).toContain(
      "'request_schema_invalid','request_capability_expired'",
    );
    expect(admissionSubphaseMigration).toContain("'job_record_persistence'");
    expect(admissionSubphaseMigration).toContain("'job_record_persistence','admission_commit'");
    expect(admissionSubphaseMigration).toContain("from public, anon, authenticated");
    expect(admissionSubphaseMigration).toContain("to service_role");
    expect(migration).toContain("octet_length(diagnostics::text) <= 4096");
    expect(migration).toContain(
      "alter table public.fix_stage_runner_diagnostic_events enable row level security",
    );
    expect(migration).toContain(
      "revoke all on public.fix_stage_runner_diagnostic_events from public, anon, authenticated, service_role",
    );
    expect(migration).toContain(
      "grant select on public.fix_stage_runner_diagnostic_events to service_role",
    );
    expect(migration).toContain(
      "before update or delete on public.fix_stage_runner_diagnostic_events",
    );
    expect(migration).toContain("coalesce(auth.role(), '') <> 'service_role'");
    expect(migration).toContain(
      "public.complete_fix_stage(p_stage_id, p_claim_token, p_result, p_failure_category)",
    );
    expect(migration).toContain("fix_runner_diagnostic_replay_conflict");
    expect(migration).not.toMatch(
      /grant\s+(?:insert|all)\s+on\s+public\.fix_stage_runner_diagnostic_events\s+to\s+service_role/i,
    );
    expect(stageRuntime).toContain('client.rpc("complete_fix_stage_with_runner_diagnostics"');
    expect(stageRuntime).toContain("p_diagnostics: error.diagnostics");
    expect(stageRuntime).toContain('client.rpc("complete_fix_stage"');
    expect(readbackTask).toContain('from("fix_stage_runner_diagnostic_events")');
    expect(readbackTask).toContain('.eq("fix_run_id", TARGET.fixRunId)');
    expect(readbackTask).toContain('.eq("workspace_id", TARGET.workspaceId)');
    expect(readbackTask).toContain(".limit(4)");
    expect(readbackTask).toContain("sanitizeM1578RRunnerDiagnosticEvents");
  });

  it("keeps the logging fallback safe and preserves the original stage failure behavior", () => {
    const catchBody = stageRuntime.slice(stageRuntime.indexOf("} catch (error) {"));
    expect(catchBody).toContain('"fix_engine_runner_diagnostic_persistence_failed"');
    expect(catchBody).toContain('"fix_engine_verification_runner_failure"');
    expect(catchBody).toContain("JSON.stringify({");
    expect(catchBody).not.toContain("response.body");
    expect(catchBody).not.toContain("request.headers");
    expect(catchBody).not.toContain("signedUrl");
  });
});
