import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20261223000000_m1578r_verification_recovery_generation_three.sql",
    import.meta.url,
  ),
  "utf8",
);
const recoveryTask = readFileSync(
  new URL(
    "../src/trigger/recover-internal-fix-verification-after-cache-repair.ts",
    import.meta.url,
  ),
  "utf8",
);
const runtime = readFileSync(
  new URL("../src/lib/fix-engine/stage-runtime.ts", import.meta.url),
  "utf8",
);

describe("M15.78R one-time Generation 3 recovery preparation", () => {
  it("does not authorize a fourth attempt merely by applying the migration", () => {
    const tableDefinition = migration.split(
      "create function public.authorize_internal_fix_verification_recovery_generation_three(",
    )[0];
    expect(tableDefinition).not.toMatch(
      /insert\s+into\s+public\.fix_verification_recovery_generation_three_authorizations/i,
    );
    expect(tableDefinition).toContain("unique (fix_run_id, stage)");
    expect(tableDefinition).toContain("fix_stage_generation_three_retry_not_authorized");
    expect(tableDefinition).toContain("new.attempt_count = 3");
    expect(tableDefinition).toContain("new.status = 'queued'");
    expect(tableDefinition).toContain("a.recovery_generation = 3");
  });

  it("adds one immutable service-only ledger while leaving generation-one and generation-two ledgers untouched", () => {
    expect(migration).toContain(
      "recovery_generation smallint not null default 3 check (recovery_generation = 3)",
    );
    expect(migration).toContain("unique (fix_run_id, stage)");
    expect(migration).toContain("generation_one_authorization_id uuid not null");
    expect(migration).toContain("generation_two_authorization_id uuid not null");
    expect(migration).toContain(
      "before update or delete on public.fix_verification_recovery_generation_three_authorizations",
    );
    expect(migration).toContain(
      "alter table public.fix_verification_recovery_generation_three_authorizations enable row level security",
    );
    expect(migration).toContain(
      "grant select on public.fix_verification_recovery_generation_three_authorizations to service_role",
    );
    expect(migration).not.toMatch(
      /(?:update|delete)\s+public\.fix_verification_recovery_(?:authorizations|generation_two_authorizations)/i,
    );
    expect(migration).toContain(
      "prior_run_failure_category text not null check (prior_run_failure_category = 'runner_result_invalid')",
    );
    expect(migration).toContain(
      "prior_attempt_count integer not null check (prior_attempt_count = 3)",
    );
    expect(migration).toContain(
      "prior_operator_retry_count integer not null check (prior_operator_retry_count = 2)",
    );
    expect(migration).toContain(
      "authorization_reference = 'M15.78R user-authorized generation 3 after diagnostic readback preparation'",
    );
    expect(migration).toContain(
      "runner_image_id = 'sha256:408117eeeee5477f56eae8d8bb16cda12cf01ad0596b7ce3269bf2e2beaa56ee'",
    );
    expect(migration).toContain(
      "runner_attestation_verified boolean not null default true check (runner_attestation_verified)",
    );
    expect(migration).toContain("diagnostics_contract_version = 'runner-failure-diagnostics-v1'");
  });

  it("pins the exact existing scope, diagnosis, plan, applied patch, signed cache and prior authorizations", () => {
    for (const value of [
      "7de04a75-aefa-43a6-ba64-9fa4a70e0ec1",
      "e140d48e-9dc0-4552-a9a4-a81fe3872422",
      "de1f2a12-de3c-4644-8892-b6c2d458a300",
      "b2abf377-2dbc-4b9c-b546-b0604f3ee4fe",
      "94135df6f85bfb34ac83c046e5541e1ad8d73a86",
      "be3f7337-55ed-4e0f-8fed-63b69d81c069",
      "9152f9b4d2aab67c273752cf214c24cc3d2619be927b2866b0d994e23024959e",
      "aa9c2345-5134-4097-b0f9-0204d88f76f9",
      "ea769c328a8b44d3001a12f32c1980bb2d71e9fc2e0c5c011fc5a4a1fadfb51f",
      "c258f201-854e-4469-8bf7-7f4d2805a1e5",
      "c7e9cfc34baa27a69cbd724877bb549a21e8188fcd29cc5b3399fb5cac2b3ece",
      "36ea2095-ad2b-4bb0-9235-2fb5b02e9106",
      "4985982e-befe-483c-9a24-45dc160446bf",
      "runner_result_invalid",
      "cache_signature_invalid",
      "operator_retry_count = 3",
      "p.attempt_number = 2",
      "p.status = 'applied'",
      "v_run.source_mode <> 'internal_test' or v_run.processing_mode <> 'evidence_only'",
      "v_run.provenance_mode <> 'evidence_only'",
      "v_run.review_disposition <> 'review_required'",
      "v_run.production_exposure_state is distinct from 'unknown'",
      "exists (select 1 from public.fix_verification_runs x where x.fix_run_id = v_run.id)",
      "exists (select 1 from public.fix_risk_assessments x where x.fix_run_id = v_run.id)",
      "exists (select 1 from public.fix_external_operations x where x.fix_run_id = v_run.id)",
      "exists (select 1 from public.fix_pr_outcomes x where x.fix_run_id = v_run.id)",
    ]) {
      expect(migration).toContain(value);
    }
    expect(migration).toContain("runner_attestation_account is distinct from '737759272471'");
    expect(migration).toContain("runner_attestation_region is distinct from 'eu-west-1'");
    expect(migration).toContain(
      "runner_attestation_instance_id is distinct from 'i-0592719b99a518001'",
    );
  });

  it("serializes concurrent authorization and makes replay return the same authorization without creating a new generation", () => {
    expect(migration).toContain("for update");
    expect(migration).toContain("unique (fix_run_id, stage)");
    expect(migration).toContain("return jsonb_build_object('status', 'already_authorized'");
    expect(migration).toContain("return jsonb_build_object('status', 'already_consumed'");
    expect(migration).toContain(
      "where q.id = v_stage.id and q.status = 'failed' and q.attempt_count = 3",
    );
    expect(migration).toContain(
      "q.operator_retry_count = 2 and q.failure_category = 'runner_result_invalid'",
    );
    expect(migration).toContain("and (x.attempt_count < 3");
    expect(migration).toContain("x.stage = 'verify_patch' and x.attempt_count = 3 and exists (");
    expect(migration).toContain("a.recovery_generation = 3");
    expect(migration).toContain("fix_stage_generation_three_retry_not_authorized");
    expect(migration).toContain("v_stage.attempt_count <> 3 or v_stage.operator_retry_count <> 2");
    expect(migration).toContain(
      "where q.id = v_stage.id and q.status = 'failed' and q.attempt_count = 3",
    );
    expect(migration).toContain("set status = 'queued', operator_retry_count = 3");
    expect(migration).toContain("attempt_count = attempt_count + 1");
    expect(migration).toContain("q.attempt_count >= 3");
    expect(migration).toContain("v_stage.attempt_count = 4 and v_stage.operator_retry_count = 3");
    expect(migration).toContain("v_stage.status in ('claimed', 'completed', 'failed')");
    expect(migration).toContain("recoveryGeneration', 3");
    expect(migration).toMatch(/recovery_generation_three_once unique \(fix_run_id, stage\)/);
    expect(runtime).toMatch(
      /value\.stage === "verify_patch"\s*&&\s*value\.attemptNumber === 4\s*&&\s*value\.recoveryGeneration === 3/,
    );
  });

  it("requires explicit operator intent, revalidates runner identity/cache, and dispatches by the authorization identity", () => {
    expect(recoveryTask).toContain('action: z.literal("recover_generation_three")');
    expect(recoveryTask).toContain("authorizationReference: z.literal(G3_AUTHORIZATION_REFERENCE)");
    expect(recoveryTask).toContain('id: "recover-internal-fix-verification-after-cache-repair"');
    expect(recoveryTask).toContain("retry: { maxAttempts: 1 }");
    expect(recoveryTask).toContain("queue: { concurrencyLimit: 1 }");
    expect(recoveryTask).toContain('url.origin !== "https://verify.auterim.com"');
    expect(recoveryTask).toContain("verifyRunnerIdentityAttestation({");
    expect(recoveryTask).toContain("EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS.includes(");
    expect(recoveryTask).toContain("dependencyCacheManifestFingerprint(cache.manifest)");
    expect(recoveryTask).toContain("cache.manifest.archiveSha256");
    expect(recoveryTask).toContain(
      'client.rpc("authorize_internal_fix_verification_recovery_generation_three"',
    );
    expect(recoveryTask).toContain("fix-engine:authorized-recovery:${data.recoveryId}");
    expect(recoveryTask).toContain('FIX_GITHUB_DRAFT_PR_WRITES !== "0"');
    expect(recoveryTask).toContain('data?.status === "already_consumed"');
    expect(recoveryTask.indexOf('data?.status === "already_consumed"')).toBeLessThan(
      recoveryTask.indexOf("tasks.trigger("),
    );
    expect(recoveryTask).toContain('!["retry_queued", "already_authorized"].includes(data.status)');
    expect(recoveryTask.match(/tasks\.trigger\(/g)).toHaveLength(1);
  });
});
