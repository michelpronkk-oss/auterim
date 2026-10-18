import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20261221000000_m1578r_bounded_verification_recovery_generation_two.sql",
    import.meta.url,
  ),
  "utf8",
);
const task = readFileSync(
  new URL(
    "../src/trigger/recover-internal-fix-verification-after-cache-repair.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("M15.78R bounded verification recovery generation two", () => {
  it("adds one immutable generation-two ledger without changing generation one", () => {
    expect(migration).toContain(
      "recovery_generation smallint not null default 2 check (recovery_generation = 2)",
    );
    expect(migration).toContain("unique (fix_run_id, stage)");
    expect(migration).toContain("generation_one_authorization_id uuid not null");
    expect(migration).toContain(
      "before update or delete on public.fix_verification_recovery_generation_two_authorizations",
    );
    expect(migration).toContain("enable row level security");
    expect(migration).toContain(
      "revoke all on public.fix_verification_recovery_generation_two_authorizations from public, anon, authenticated, service_role",
    );
    expect(migration).toContain(
      "grant select on public.fix_verification_recovery_generation_two_authorizations to service_role",
    );
    expect(migration).not.toMatch(
      /(?:update|delete)\s+public\.fix_verification_recovery_authorizations/i,
    );
    expect(migration).toContain(
      "grant execute on function public.authorize_internal_fix_verification_recovery_generation_two",
    );
    expect(migration).toContain("to service_role");
  });

  it("fails closed to the exact Test evidence-only run and applied patch", () => {
    for (const value of [
      "7de04a75-aefa-43a6-ba64-9fa4a70e0ec1",
      "e140d48e-9dc0-4552-a9a4-a81fe3872422",
      "de1f2a12-de3c-4644-8892-b6c2d458a300",
      "b2abf377-2dbc-4b9c-b546-b0604f3ee4fe",
      "94135df6f85bfb34ac83c046e5541e1ad8d73a86",
      "c7e9cfc34baa27a69cbd724877bb549a21e8188fcd29cc5b3399fb5cac2b3ece",
      "cache_signature_invalid",
      "v_stage.attempt_count <> 2",
      "v_stage.operator_retry_count <> 1",
      "v_stage.failure_category is distinct from 'cache_signature_invalid'",
      "p.attempt_number = 2",
      "p.status = 'applied'",
      "v_generation_one.cache_archive_sha256 <> p_cache_archive_sha256",
      "exists (select 1 from public.fix_verification_runs x where x.fix_run_id = v_run.id)",
      "exists (select 1 from public.fix_pr_outcomes x where x.fix_run_id = v_run.id)",
      "operator_retry_count = 2",
    ]) {
      expect(migration).toContain(value);
    }
    expect(migration).toContain(
      "v_run.source_mode <> 'internal_test' or v_run.processing_mode <> 'evidence_only'",
    );
    expect(migration).toContain("v_run.provenance_mode <> 'evidence_only'");
    expect(migration).toContain("v_run.review_disposition <> 'review_required'");
  });

  it("requires signed-cache revalidation, disabled Draft PR writes, and live runner protocol proof before recovery", () => {
    expect(task).toContain('action: z.literal("recover_generation_two")');
    expect(task).toContain("EXPECTED_CACHE_PUBLIC_KEY_FINGERPRINT");
    expect(task).toContain("draft_pr_writes_must_remain_disabled");
    expect(task).toContain("verificationRunnerProtocolMatches");
    expect(task).toContain('new URL("/healthz", origin)');
    expect(task).toContain("VERIFICATION_RUNNER_PROTOCOL_VERSION");
    expect(task).toContain(
      'client.rpc("authorize_internal_fix_verification_recovery_generation_two", rpcArgs)',
    );
    expect(task).toContain("data.recoveryGeneration !== recoveryGeneration");
    expect(task).toContain("fix-engine:authorized-recovery:${data.recoveryId}");
  });
});
