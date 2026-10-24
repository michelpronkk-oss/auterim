import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite, type PGliteInterface } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeAll, describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
const RECOVERY_MIGRATION = "20261226000000_m1578r_fresh_v4_verification_recovery.sql";
const recoveryMigration = await readFile(`${migrationsDirectory}${RECOVERY_MIGRATION}`, "utf8");
const recoveryTask = await readFile(
  fileURLToPath(new URL("../src/trigger/recover-fresh-v4-verification.ts", import.meta.url)),
  "utf8",
);

const WORKSPACE = "e140d48e-9dc0-4552-a9a4-a81fe3872422";
const PRODUCT = "de1f2a12-de3c-4644-8892-b6c2d458a300";
const REPOSITORY = "b2abf377-2dbc-4b9c-b546-b0604f3ee4fe";
const MAPPING = "0f1e2d3c-4b5a-4968-8776-655443322110";
const WORKSPACE_DEPENDENCY = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const CATALOG_DEPENDENCY = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const SOURCE = "b607267b-307b-4b50-9cde-2f3aa3b205f6";
const SOURCE_CHANGE = "43ab3e52-aa18-4955-ad44-06b3991ef956";
const ROUTE_INTENT = "63919c7c-3970-425a-a5fe-2b65747aeb73";
const ANALYSIS = "6f64060d-1dd7-4b10-ac3d-4db4f8ad58a6";
const GRAPH = "382d7644-370b-4d43-965e-907bf379c1f3";
const FIX_RUN = "8d38263a-8c0c-41cc-aaf0-e85770c1bfdb";
const VERIFY_STAGE = "731cab44-66df-4fe4-9794-b55ecabd1b3f";
const DIAGNOSIS = "a5f3b4b7-c445-46bd-bc6f-d3888be8cc3b";
const PLAN = "c1034b08-39a1-4324-b224-2ceb220e86c9";
const PATCH = "6a3980ff-b098-4a7e-808a-6980f5b61688";
const PRIOR_EVENT = "6986257c-e97a-46d1-8bb6-135104683976";
const COMMIT = "94135df6f85bfb34ac83c046e5541e1ad8d73a86";
const PLAN_FINGERPRINT = "3e0dd0cf6b0af47835a7e008b13afbdb8322818593bec2cae8da7347faecb4e3";
const PATCH_FINGERPRINT = "c7e9cfc34baa27a69cbd724877bb549a21e8188fcd29cc5b3399fb5cac2b3ece";
const PRIOR_JOB = "5c51d42cac9d923dc32578fbf47ba81280cba3b0715acae8b5ddd053c991dd0b";
const PRIOR_REQUEST = "bd86f37e3c9073f9f97233d82b8eaf05c5dab7163cc173030841348622b1fcd5";
const CACHE_IDENTITY_KEY = "86ab5d3a45b9e1a5218418e7856cb48b1c8fadf242c0b5ffb18ffb517463832c";
const RUNNER_IMAGE = "sha256:6b5bcfbade5f2a8293918884cf6225ce24e705e7328529aee2772f264b4a32c4";
const REFERENCE =
  "M15.78R user-authorized fresh V4 verification recovery after snapshot extraction repair";
const hex = (seed: string) => seed.repeat(64).slice(0, 64);

type RpcArgs = Record<string, string>;
const validArgs: RpcArgs = {
  p_fix_run_id: FIX_RUN,
  p_authorization_reference: REFERENCE,
  p_trigger_run_id: "run_freshv4recovery01",
  p_cache_identity_key: CACHE_IDENTITY_KEY,
  p_cache_manifest_fingerprint: hex("a"),
  p_cache_archive_sha256: hex("b"),
  p_cache_tree_sha256: hex("c"),
  p_runner_attestation_account: "737759272471",
  p_runner_attestation_region: "eu-west-1",
  p_runner_attestation_instance_id: "i-0592719b99a518001",
  p_runner_image_id: RUNNER_IMAGE,
  p_runner_protocol: "m1578-verification-runner-v1",
};

async function database() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.waitReady;
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create schema extensions;
    create extension pgcrypto with schema extensions;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz,
      raw_user_meta_data jsonb, created_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create function auth.role() returns text language sql stable as $$
      select nullif(current_setting('request.jwt.claim.role', true), '')
    $$;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean default false,
      file_size_limit bigint, allowed_mime_types text[]);
    grant usage on schema auth, storage, extensions to anon, authenticated, service_role;
  `);
  const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) await db.exec(await readFile(`${migrationsDirectory}${name}`, "utf8"));
  return db;
}

/** Seeds the exact persisted V4 terminal state observed in the 19 Oct readback. */
async function seedV4TerminalState(
  db: PGliteInterface,
  overrides: { operatorRetryCount?: number } = {},
) {
  await db.exec("set session_replication_role = replica");
  await db.exec(`
    insert into public.workspace_products (id, workspace_id, name, slug, status, protected_at)
      values ('${PRODUCT}', '${WORKSPACE}', 'QA', 'qa', 'protected', now());
    insert into public.repositories (id, workspace_id, connection_id, external_id, owner, name,
      default_branch, status, archived)
      values ('${REPOSITORY}', '${WORKSPACE}', gen_random_uuid(), 1409364414, 'michelpronkk-oss',
        'auterim-m15-github-qa', 'main', 'available', false);
    insert into public.workspace_product_repositories (id, workspace_id, protected_product_id,
      repository_id, provenance, status)
      values ('${MAPPING}', '${WORKSPACE}', '${PRODUCT}', '${REPOSITORY}', 'user_selected', 'active');
    insert into public.workspace_dependencies (id, workspace_id, dependency_id, selected_by,
      protected_product_id, monitoring_enabled)
      values ('${WORKSPACE_DEPENDENCY}', '${WORKSPACE}', '${CATALOG_DEPENDENCY}', gen_random_uuid(),
        '${PRODUCT}', true);
    insert into public.source_catalog (id, dependency_id, name, source_type, url, workspace_id,
      scope_product_id, source_mode, processing_mode, internal_acceptance_key)
      values ('${SOURCE}', '${CATALOG_DEPENDENCY}', 'qa', 'changelog', 'https://example.com/qa',
        '${WORKSPACE}', '${PRODUCT}', 'internal_test', 'evidence_only',
        'm1578r-internal-qa-fix-engine-v4');
    insert into public.source_changes (id, source_id, scan_run_id, previous_snapshot_id,
      new_snapshot_id, diff_text, added_lines, removed_lines, previous_bytes, new_bytes,
      workspace_id, scope_product_id, source_mode, processing_mode, internal_acceptance_key)
      values ('${SOURCE_CHANGE}', '${SOURCE}', gen_random_uuid(), gen_random_uuid(),
        gen_random_uuid(), 'diff', 1, 1, 1, 1, '${WORKSPACE}', '${PRODUCT}', 'internal_test',
        'evidence_only', 'm1578r-internal-qa-fix-engine-v4');
    insert into public.fix_runs (id, workspace_id, product_id, repository_id,
      workspace_dependency_id, product_repository_mapping_id, provider_repository_identity,
      source_change_id, classification_id, source_mode, processing_mode, intelligence_decision_id,
      route_intent_id, semantic_route, route_target, analysis_run_id, graph_build_id, commit_sha,
      analyzer_version, analysis_profile, graph_builder_version, policy_version,
      review_disposition, review_reason, provenance_mode, positive_graph_evidence_ids,
      evidence_fingerprint, identity_document, identity_fingerprint, idempotency_key,
      contract_version, eligibility_rules_version, preflight_required, status, current_stage,
      failure_category, completed_at)
      values ('${FIX_RUN}', '${WORKSPACE}', '${PRODUCT}', '${REPOSITORY}', '${WORKSPACE_DEPENDENCY}',
        '${MAPPING}', 'michelpronkk-oss/auterim-m15-github-qa', '${SOURCE_CHANGE}', gen_random_uuid(),
        'internal_test', 'evidence_only', gen_random_uuid(), '${ROUTE_INTENT}', 'deprecation',
        'dependency_product_impact', '${ANALYSIS}', '${GRAPH}', '${COMMIT}', 'code-intelligence-v3',
        'javascript-typescript-v2.3', 'impact-graph-v2', 'intelligence-policy-active-v2',
        'review_required', 'critical_change', 'evidence_only', array[gen_random_uuid()],
        '${hex("d")}', '{}'::jsonb, '${hex("e")}', '${hex("f")}', 'fix-engine-v1', 'rules-v1', false,
        'validation_failed', 'verify_patch', 'runner_result_invalid', now());
    insert into public.fix_stage_queue (id, fix_run_id, workspace_id, stage, status,
      idempotency_key, attempt_count, failure_category, completed_at, operator_retry_count)
      select gen_random_uuid(), '${FIX_RUN}', '${WORKSPACE}', s, 'completed',
        encode(extensions.digest(s, 'sha256'), 'hex'), 1, null, now(), 0
      from unnest(array['diagnose','plan','generate_patch','apply_patch']) s;
    insert into public.fix_stage_queue (id, fix_run_id, workspace_id, stage, status,
      idempotency_key, attempt_count, failure_category, completed_at, operator_retry_count)
      values ('${VERIFY_STAGE}', '${FIX_RUN}', '${WORKSPACE}', 'verify_patch', 'failed',
        '${hex("1")}', 1, 'runner_result_invalid', now(), ${overrides.operatorRetryCount ?? 0});
    insert into public.fix_diagnoses (id, fix_run_id, workspace_id, graph_build_id, analysis_run_id,
      repository_id, commit_sha, semantic_route, change_family, diagnosis, evidence_ids, provider,
      model, schema_version, prompt_contract_version, input_fingerprint, output_fingerprint)
      values ('${DIAGNOSIS}', '${FIX_RUN}', '${WORKSPACE}', '${GRAPH}', '${ANALYSIS}', '${REPOSITORY}',
        '${COMMIT}', 'deprecation', 'endpoint', '{}'::jsonb, array[gen_random_uuid()],
        'azure-openai', 'gpt-6.1-sol', 'fix-engine-v1', 'fix-coding-contract-v4', '${hex("2")}',
        '${hex("3")}');
    insert into public.fix_plans (id, fix_run_id, workspace_id, plan_version, plan,
      plan_fingerprint, provider, model, schema_version, prompt_contract_version)
      values ('${PLAN}', '${FIX_RUN}', '${WORKSPACE}', 1, '{}'::jsonb, '${PLAN_FINGERPRINT}',
        'azure-openai', 'gpt-6.1-sol', 'fix-engine-v1', 'fix-coding-contract-v4');
    insert into public.fix_patches (id, fix_run_id, workspace_id, plan_id, attempt_number, base_sha,
      patch_fingerprint, artifact_path, changed_paths, line_count, byte_count, status, provider,
      model)
      values ('${PATCH}', '${FIX_RUN}', '${WORKSPACE}', '${PLAN}', 1, '${COMMIT}',
        '${PATCH_FINGERPRINT}', '${FIX_RUN}/${PATCH}.diff', array['src/endpoint.js'], 2, 366,
        'applied', 'azure-openai', 'gpt-6.1-sol');
    insert into public.fix_stage_runner_diagnostic_events (id, fix_run_id, workspace_id, stage_id,
      claim_token, attempt_number, failure_category, retryable, diagnostics, job_id,
      request_fingerprint, admission_state)
      values ('${PRIOR_EVENT}', '${FIX_RUN}', '${WORKSPACE}', '${VERIFY_STAGE}', gen_random_uuid(),
        1, 'runner_result_invalid', false,
        '[{"phase":"admission","httpStatus":500,"responseCategory":"verification_runner_internal_error","reason":"http_error","admissionSubphase":"snapshot_archive_extraction"}]'::jsonb,
        '${PRIOR_JOB}', '${PRIOR_REQUEST}', 'rejected');
  `);
  await db.exec("set session_replication_role = origin");
}

async function asServiceRole(db: PGliteInterface) {
  await db.query("select set_config('request.jwt.claim.role', 'service_role', false)");
}

async function authorize(db: PGliteInterface, args: RpcArgs = validArgs) {
  const names = Object.keys(validArgs);
  const placeholders = names.map((name, index) => `${name} => $${index + 1}`).join(", ");
  const result = await db.query<{ value: Record<string, unknown> }>(
    `select public.authorize_fresh_v4_fix_verification_recovery(${placeholders}) as value`,
    names.map((name) => args[name]),
  );
  return result.rows[0]!.value;
}

async function verifyState(db: PGliteInterface) {
  const stage = await db.query<{
    status: string;
    attempt_count: number;
    operator_retry_count: number;
    failure_category: string | null;
  }>(
    "select status, attempt_count, operator_retry_count, failure_category from public.fix_stage_queue where id = $1",
    [VERIFY_STAGE],
  );
  const run = await db.query<{ status: string; failure_category: string | null }>(
    "select status, failure_category from public.fix_runs where id = $1",
    [FIX_RUN],
  );
  return { stage: stage.rows[0]!, run: run.rows[0]! };
}

describe("M15.78R fresh V4 bounded verification recovery (database)", { timeout: 60_000 }, () => {
  let migrated: PGlite;
  beforeAll(async () => {
    migrated = await database();
  }, 180_000);

  it("requeues only the exact failed verify stage, once, and records immutable provenance", async () => {
    const db = await migrated.clone();
    await seedV4TerminalState(db);
    await asServiceRole(db);

    const first = await authorize(db);
    expect(first).toMatchObject({
      status: "retry_queued",
      fixRunId: FIX_RUN,
      stageId: VERIFY_STAGE,
    });
    expect(await verifyState(db)).toEqual({
      stage: {
        status: "queued",
        attempt_count: 1,
        operator_retry_count: 1,
        failure_category: null,
      },
      run: { status: "queued", failure_category: null },
    });

    const ledger = await db.query<Record<string, unknown>>(
      "select * from public.fix_fresh_v4_verification_recovery_authorizations",
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      id: first.recoveryId,
      plan_fingerprint: PLAN_FINGERPRINT,
      patch_fingerprint: PATCH_FINGERPRINT,
      diagnosis_fingerprint: hex("3"),
      prior_runner_job_id: PRIOR_JOB,
      prior_runner_request_fingerprint: PRIOR_REQUEST,
      prior_admission_subphase: "snapshot_archive_extraction",
      runner_image_id: RUNNER_IMAGE,
      commit_sha: COMMIT,
    });

    // Earlier stages and the prior failure evidence are untouched.
    const earlier = await db.query<{ n: number }>(
      "select count(*)::int as n from public.fix_stage_queue where fix_run_id = $1 and id <> $2 and status = 'completed' and attempt_count = 1",
      [FIX_RUN, VERIFY_STAGE],
    );
    expect(earlier.rows[0]!.n).toBe(4);
    const events = await db.query<{ n: number }>(
      "select count(*)::int as n from public.fix_stage_runner_diagnostic_events where id = $1 and admission_state = 'rejected'",
      [PRIOR_EVENT],
    );
    expect(events.rows[0]!.n).toBe(1);

    // Replay is idempotent and reports the same authorization.
    expect(
      await authorize(db, { ...validArgs, p_trigger_run_id: "run_freshv4recovery02" }),
    ).toEqual({
      status: "already_authorized",
      fixRunId: FIX_RUN,
      stageId: VERIFY_STAGE,
      recoveryId: first.recoveryId,
    });

    // The cron dispatcher never delivers the recovered stage.
    const work = await db.query<{ n: number }>(
      "select count(*)::int as n from public.list_fix_stage_work(100) w where w.fix_run_id = $1",
      [FIX_RUN],
    );
    expect(work.rows[0]!.n).toBe(0);

    // After the single claim the authorization reports consumed and cannot requeue again.
    const claimed = await db.query<{ value: Record<string, unknown> }>(
      "select public.claim_fix_stage($1, 120) as value",
      [VERIFY_STAGE],
    );
    expect(claimed.rows[0]!.value).toMatchObject({ status: "claimed", attemptNumber: 2 });
    expect(await authorize(db)).toMatchObject({
      status: "already_consumed",
      stageStatus: "claimed",
      recoveryId: first.recoveryId,
    });

    // A transient runner failure on attempt 2 goes through the canonical retry transition;
    // a replay during that in-delivery retry still reports consumed and does not requeue.
    const retried = await db.query<{ value: Record<string, unknown> }>(
      "select public.complete_fix_stage($1, $2, 'retry', 'runner_unavailable') as value",
      [VERIFY_STAGE, claimed.rows[0]!.value.claimToken],
    );
    expect(retried.rows[0]!.value).toMatchObject({ status: "retry_queued" });
    expect(await authorize(db)).toMatchObject({
      status: "already_consumed",
      stageStatus: "queued",
    });
    expect((await verifyState(db)).stage).toMatchObject({
      attempt_count: 2,
      operator_retry_count: 1,
    });

    // Attempt 3 is the last claim under the existing stage cap; then the stage is terminal.
    const third = await db.query<{ value: Record<string, unknown> }>(
      "select public.claim_fix_stage($1, 120) as value",
      [VERIFY_STAGE],
    );
    expect(third.rows[0]!.value).toMatchObject({ status: "claimed", attemptNumber: 3 });
    const terminal = await db.query<{ value: Record<string, unknown> }>(
      "select public.complete_fix_stage($1, $2, 'failed', 'runner_result_invalid') as value",
      [VERIFY_STAGE, third.rows[0]!.value.claimToken],
    );
    expect(terminal.rows[0]!.value).toMatchObject({ status: "validation_failed" });
    expect(await authorize(db)).toMatchObject({
      status: "already_consumed",
      stageStatus: "failed",
    });
    expect((await verifyState(db)).stage).toMatchObject({ status: "failed", attempt_count: 3 });
    const fourth = await db.query<{ value: Record<string, unknown> }>(
      "select public.claim_fix_stage($1, 120) as value",
      [VERIFY_STAGE],
    );
    expect(fourth.rows[0]!.value).toMatchObject({ status: "busy" });

    // The ledger row is append-only.
    await expect(
      db.exec(
        "update public.fix_fresh_v4_verification_recovery_authorizations set trigger_run_id = 'run_tamperedxx'",
      ),
    ).rejects.toThrow(/fix_stage_recovery_authorization_immutable/);
    await expect(
      db.exec("delete from public.fix_fresh_v4_verification_recovery_authorizations"),
    ).rejects.toThrow(/fix_stage_recovery_authorization_immutable/);
  });

  it.each([
    ["another Fix Run", { p_fix_run_id: "7de04a75-aefa-43a6-ba64-9fa4a70e0ec1" }],
    ["a generic reference", { p_authorization_reference: "retry" }],
    [
      "the retired runner image",
      {
        p_runner_image_id:
          "sha256:408117eeeee5477f56eae8d8bb16cda12cf01ad0596b7ce3269bf2e2beaa56ee",
      },
    ],
    ["another runner instance", { p_runner_attestation_instance_id: "i-0000000000000000" }],
    ["another cache identity", { p_cache_identity_key: hex("9") }],
  ])("rejects %s without touching state", async (_label, change) => {
    const db = await migrated.clone();
    await seedV4TerminalState(db);
    await asServiceRole(db);
    await expect(authorize(db, { ...validArgs, ...change })).rejects.toThrow(
      /fresh_v4_verification_recovery_request_invalid/,
    );
    expect((await verifyState(db)).stage.status).toBe("failed");
  });

  it("fails closed when the stored state differs from the observed terminal failure", async () => {
    const retried = await migrated.clone();
    await seedV4TerminalState(retried, { operatorRetryCount: 1 });
    await asServiceRole(retried);
    await expect(authorize(retried)).rejects.toThrow(
      /fresh_v4_verification_recovery_scope_invalid/,
    );

    const drifted = await migrated.clone();
    await seedV4TerminalState(drifted);
    await drifted.exec(
      `set session_replication_role = replica;
       update public.fix_patches set patch_fingerprint = '${hex("7")}' where id = '${PATCH}';
       set session_replication_role = origin;`,
    );
    await asServiceRole(drifted);
    await expect(authorize(drifted)).rejects.toThrow(
      /fresh_v4_verification_recovery_patch_invalid/,
    );
    expect((await verifyState(drifted)).stage.status).toBe("failed");

    const secondFailure = await migrated.clone();
    await seedV4TerminalState(secondFailure);
    await secondFailure.exec(
      `set session_replication_role = replica;
       insert into public.fix_stage_runner_diagnostic_events (fix_run_id, workspace_id, stage_id,
         claim_token, attempt_number, failure_category, retryable, diagnostics)
       values ('${FIX_RUN}', '${WORKSPACE}', '${VERIFY_STAGE}', gen_random_uuid(), 1,
         'verification_failed', false, '[]'::jsonb);
       set session_replication_role = origin;`,
    );
    await asServiceRole(secondFailure);
    await expect(authorize(secondFailure)).rejects.toThrow(
      /fresh_v4_verification_recovery_prior_failure_invalid/,
    );
    expect((await verifyState(secondFailure)).stage.status).toBe("failed");
  });

  it("requires the service role", async () => {
    const db = await migrated.clone();
    await seedV4TerminalState(db);
    await expect(authorize(db)).rejects.toThrow(/service_role_required/);
  });
});

describe("M15.78R fresh V4 recovery wiring (static)", () => {
  it("authorizes nothing by applying the migration", () => {
    const beforeRpc = recoveryMigration.split(
      "create function public.authorize_fresh_v4_fix_verification_recovery(",
    )[0];
    expect(beforeRpc).not.toMatch(/insert\s+into/i);
    expect(beforeRpc).not.toMatch(/update\s+public\./i);
    expect(recoveryMigration).not.toMatch(
      /(?:update|delete\s+from)\s+public\.fix_verification_recovery_(?:authorizations|generation_two_authorizations|generation_three_authorizations)/i,
    );
  });

  it("dispatches once under a recovery-specific idempotency key after attestation", () => {
    expect(recoveryTask).toContain("authorize_fresh_v4_fix_verification_recovery");
    expect(recoveryTask).toContain("fix-engine:fresh-v4-verification-recovery:${data.recoveryId}");
    expect(recoveryTask).toContain(
      "runnerIdentity.runnerContainerImageId !== EXPECTED_RUNNER_IMAGE_ID",
    );
    expect(recoveryTask).toContain('FIX_GITHUB_DRAFT_PR_WRITES !== "0"');
    expect(recoveryTask).toContain("retry: { maxAttempts: 1 }");
    expect(recoveryTask).not.toMatch(/fix-engine:\$\{fixRunId\}:verify_patch/);
  });
});
