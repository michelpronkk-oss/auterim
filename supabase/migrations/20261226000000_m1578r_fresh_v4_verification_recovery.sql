-- One strictly bounded verification recovery for the fresh M15.78R V4
-- acceptance Fix Run. Its only failure was a runner admission rejection during
-- snapshot archive extraction (repaired by the reviewed snapshot-extraction
-- runner image). Diagnosis, plan, patch and apply results are reused unchanged.
-- Applying this migration authorizes nothing: the requeue happens only through
-- the service-role RPC below, at most once, and only for the exact pinned state.
-- The historical Fix Run 7de04a75 and its generation ledgers are untouched.
create table public.fix_fresh_v4_verification_recovery_authorizations (
  id uuid primary key default gen_random_uuid(),
  fix_run_id uuid not null check (fix_run_id = '8d38263a-8c0c-41cc-aaf0-e85770c1bfdb'),
  workspace_id uuid not null check (workspace_id = 'e140d48e-9dc0-4552-a9a4-a81fe3872422'),
  stage_id uuid not null check (stage_id = '731cab44-66df-4fe4-9794-b55ecabd1b3f'),
  stage text not null default 'verify_patch' check (stage = 'verify_patch'),
  acceptance_key text not null default 'm1578r-internal-qa-fix-engine-v4'
    check (acceptance_key = 'm1578r-internal-qa-fix-engine-v4'),
  identity_fingerprint text not null check (identity_fingerprint ~ '^[a-f0-9]{64}$'),
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[a-f0-9]{64}$'),
  source_change_id uuid not null check (source_change_id = '43ab3e52-aa18-4955-ad44-06b3991ef956'),
  route_intent_id uuid not null check (route_intent_id = '63919c7c-3970-425a-a5fe-2b65747aeb73'),
  graph_build_id uuid not null check (graph_build_id = '382d7644-370b-4d43-965e-907bf379c1f3'),
  analysis_run_id uuid not null check (analysis_run_id = '6f64060d-1dd7-4b10-ac3d-4db4f8ad58a6'),
  product_id uuid not null check (product_id = 'de1f2a12-de3c-4644-8892-b6c2d458a300'),
  repository_id uuid not null check (repository_id = 'b2abf377-2dbc-4b9c-b546-b0604f3ee4fe'),
  commit_sha text not null check (commit_sha = '94135df6f85bfb34ac83c046e5541e1ad8d73a86'),
  diagnosis_id uuid not null check (diagnosis_id = 'a5f3b4b7-c445-46bd-bc6f-d3888be8cc3b'),
  diagnosis_fingerprint text not null check (diagnosis_fingerprint ~ '^[a-f0-9]{64}$'),
  plan_id uuid not null check (plan_id = 'c1034b08-39a1-4324-b224-2ceb220e86c9'),
  plan_fingerprint text not null
    check (plan_fingerprint = '3e0dd0cf6b0af47835a7e008b13afbdb8322818593bec2cae8da7347faecb4e3'),
  patch_id uuid not null check (patch_id = '6a3980ff-b098-4a7e-808a-6980f5b61688'),
  patch_fingerprint text not null
    check (patch_fingerprint = 'c7e9cfc34baa27a69cbd724877bb549a21e8188fcd29cc5b3399fb5cac2b3ece'),
  patch_attempt_number smallint not null default 1 check (patch_attempt_number = 1),
  prior_runner_event_id uuid not null
    check (prior_runner_event_id = '6986257c-e97a-46d1-8bb6-135104683976'),
  prior_runner_job_id text not null
    check (prior_runner_job_id = '5c51d42cac9d923dc32578fbf47ba81280cba3b0715acae8b5ddd053c991dd0b'),
  prior_runner_request_fingerprint text not null
    check (prior_runner_request_fingerprint = 'bd86f37e3c9073f9f97233d82b8eaf05c5dab7163cc173030841348622b1fcd5'),
  prior_admission_state text not null check (prior_admission_state = 'rejected'),
  prior_admission_subphase text not null
    check (prior_admission_subphase = 'snapshot_archive_extraction'),
  prior_run_status text not null check (prior_run_status = 'validation_failed'),
  prior_run_failure_category text not null check (prior_run_failure_category = 'runner_result_invalid'),
  prior_stage_status text not null check (prior_stage_status = 'failed'),
  prior_stage_failure_category text not null check (prior_stage_failure_category = 'runner_result_invalid'),
  prior_attempt_count integer not null check (prior_attempt_count = 1),
  prior_operator_retry_count integer not null check (prior_operator_retry_count = 0),
  prior_patch_status text not null check (prior_patch_status = 'applied'),
  cache_identity_key text not null
    check (cache_identity_key = '86ab5d3a45b9e1a5218418e7856cb48b1c8fadf242c0b5ffb18ffb517463832c'),
  cache_manifest_fingerprint text not null check (cache_manifest_fingerprint ~ '^[a-f0-9]{64}$'),
  cache_archive_sha256 text not null check (cache_archive_sha256 ~ '^[a-f0-9]{64}$'),
  cache_tree_sha256 text not null check (cache_tree_sha256 ~ '^[a-f0-9]{64}$'),
  runner_attestation_account text not null check (runner_attestation_account = '737759272471'),
  runner_attestation_region text not null check (runner_attestation_region = 'eu-west-1'),
  runner_attestation_instance_id text not null check (runner_attestation_instance_id = 'i-0592719b99a518001'),
  runner_image_id text not null check (
    runner_image_id = 'sha256:6b5bcfbade5f2a8293918884cf6225ce24e705e7328529aee2772f264b4a32c4'
  ),
  runner_protocol text not null check (runner_protocol = 'm1578-verification-runner-v1'),
  runner_attestation_verified boolean not null default true check (runner_attestation_verified),
  authorization_actor text not null default 'operator' check (authorization_actor = 'operator'),
  authorization_reference text not null check (
    authorization_reference = 'M15.78R user-authorized fresh V4 verification recovery after snapshot extraction repair'
  ),
  trigger_run_id text not null check (trigger_run_id ~ '^run_[A-Za-z0-9]{8,80}$'),
  authorized_at timestamptz not null default now(),
  constraint fix_fresh_v4_verification_recovery_once unique (fix_run_id, stage),
  constraint fix_fresh_v4_verification_recovery_run_scope_fkey
    foreign key (fix_run_id, workspace_id) references public.fix_runs(id, workspace_id) on delete restrict,
  constraint fix_fresh_v4_verification_recovery_stage_scope_fkey
    foreign key (stage_id, fix_run_id, workspace_id)
    references public.fix_stage_queue(id, fix_run_id, workspace_id) on delete restrict,
  constraint fix_fresh_v4_verification_recovery_plan_scope_fkey
    foreign key (plan_id, fix_run_id) references public.fix_plans(id, fix_run_id) on delete restrict,
  constraint fix_fresh_v4_verification_recovery_patch_scope_fkey
    foreign key (patch_id, fix_run_id) references public.fix_patches(id, fix_run_id) on delete restrict
);

alter table public.fix_fresh_v4_verification_recovery_authorizations enable row level security;
revoke all on public.fix_fresh_v4_verification_recovery_authorizations
  from public, anon, authenticated, service_role;
grant select on public.fix_fresh_v4_verification_recovery_authorizations to service_role;

create trigger fix_fresh_v4_verification_recovery_authorizations_immutable
  before update or delete on public.fix_fresh_v4_verification_recovery_authorizations
  for each row execute function private.reject_fix_stage_recovery_mutation();

create function public.authorize_fresh_v4_fix_verification_recovery(
  p_fix_run_id uuid,
  p_authorization_reference text,
  p_trigger_run_id text,
  p_cache_identity_key text,
  p_cache_manifest_fingerprint text,
  p_cache_archive_sha256 text,
  p_cache_tree_sha256 text,
  p_runner_attestation_account text,
  p_runner_attestation_region text,
  p_runner_attestation_instance_id text,
  p_runner_image_id text,
  p_runner_protocol text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.fix_runs%rowtype;
  v_stage public.fix_stage_queue%rowtype;
  v_diagnosis public.fix_diagnoses%rowtype;
  v_plan public.fix_plans%rowtype;
  v_patch public.fix_patches%rowtype;
  v_event public.fix_stage_runner_diagnostic_events%rowtype;
  v_existing public.fix_fresh_v4_verification_recovery_authorizations%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_fix_run_id is distinct from '8d38263a-8c0c-41cc-aaf0-e85770c1bfdb'::uuid
    or p_authorization_reference is distinct from
      'M15.78R user-authorized fresh V4 verification recovery after snapshot extraction repair'
    or p_trigger_run_id is null or p_trigger_run_id !~ '^run_[A-Za-z0-9]{8,80}$'
    or p_cache_identity_key is distinct from '86ab5d3a45b9e1a5218418e7856cb48b1c8fadf242c0b5ffb18ffb517463832c'
    or p_cache_manifest_fingerprint is null or p_cache_manifest_fingerprint !~ '^[a-f0-9]{64}$'
    or p_cache_archive_sha256 is null or p_cache_archive_sha256 !~ '^[a-f0-9]{64}$'
    or p_cache_tree_sha256 is null or p_cache_tree_sha256 !~ '^[a-f0-9]{64}$'
    or p_runner_attestation_account is distinct from '737759272471'
    or p_runner_attestation_region is distinct from 'eu-west-1'
    or p_runner_attestation_instance_id is distinct from 'i-0592719b99a518001'
    or p_runner_image_id is distinct from 'sha256:6b5bcfbade5f2a8293918884cf6225ce24e705e7328529aee2772f264b4a32c4'
    or p_runner_protocol is distinct from 'm1578-verification-runner-v1' then
    raise exception 'fresh_v4_verification_recovery_request_invalid' using errcode = '22023';
  end if;

  select * into v_run from public.fix_runs r
  where r.id = p_fix_run_id and r.workspace_id = 'e140d48e-9dc0-4552-a9a4-a81fe3872422'::uuid
  for update;
  if not found then
    raise exception 'fresh_v4_verification_recovery_run_not_found' using errcode = 'P0002';
  end if;
  select * into v_stage from public.fix_stage_queue q
  where q.id = '731cab44-66df-4fe4-9794-b55ecabd1b3f'::uuid and q.fix_run_id = v_run.id
    and q.workspace_id = v_run.workspace_id and q.stage = 'verify_patch'
  for update;
  if not found then
    raise exception 'fresh_v4_verification_recovery_stage_not_found' using errcode = 'P0002';
  end if;

  -- Replays: the single authorization is either still queued or already consumed.
  select * into v_existing from public.fix_fresh_v4_verification_recovery_authorizations a
  where a.fix_run_id = v_run.id and a.stage = 'verify_patch';
  if found then
    if v_existing.stage_id <> v_stage.id
      or v_existing.cache_identity_key <> p_cache_identity_key
      or v_existing.cache_manifest_fingerprint <> p_cache_manifest_fingerprint
      or v_existing.cache_archive_sha256 <> p_cache_archive_sha256
      or v_existing.cache_tree_sha256 <> p_cache_tree_sha256
      or v_existing.runner_image_id <> p_runner_image_id then
      raise exception 'fresh_v4_verification_recovery_conflict' using errcode = '42501';
    end if;
    if v_stage.status = 'queued' and v_stage.attempt_count = 1
      and v_stage.operator_retry_count = 1 and v_stage.failure_category is null
      and v_run.status = 'queued' and v_run.failure_category is null then
      return jsonb_build_object('status', 'already_authorized', 'fixRunId', v_run.id,
        'stageId', v_stage.id, 'recoveryId', v_existing.id);
    end if;
    if v_stage.attempt_count = 2 and v_stage.operator_retry_count = 1
      and v_stage.status in ('claimed', 'completed', 'failed') then
      return jsonb_build_object('status', 'already_consumed', 'fixRunId', v_run.id,
        'stageId', v_stage.id, 'stageStatus', v_stage.status, 'recoveryId', v_existing.id);
    end if;
    raise exception 'fresh_v4_verification_recovery_state_conflict' using errcode = '42501';
  end if;

  -- Exact terminal state left by the rejected admission; nothing downstream exists.
  if v_run.product_id <> 'de1f2a12-de3c-4644-8892-b6c2d458a300'::uuid
    or v_run.repository_id <> 'b2abf377-2dbc-4b9c-b546-b0604f3ee4fe'::uuid
    or lower(v_run.provider_repository_identity) <> 'michelpronkk-oss/auterim-m15-github-qa'
    or v_run.source_change_id <> '43ab3e52-aa18-4955-ad44-06b3991ef956'::uuid
    or v_run.route_intent_id <> '63919c7c-3970-425a-a5fe-2b65747aeb73'::uuid
    or v_run.analysis_run_id <> '6f64060d-1dd7-4b10-ac3d-4db4f8ad58a6'::uuid
    or v_run.graph_build_id <> '382d7644-370b-4d43-965e-907bf379c1f3'::uuid
    or v_run.commit_sha <> '94135df6f85bfb34ac83c046e5541e1ad8d73a86'
    or v_run.source_mode <> 'internal_test' or v_run.processing_mode <> 'evidence_only'
    or v_run.provenance_mode <> 'evidence_only'
    or v_run.semantic_route <> 'deprecation' or v_run.route_target <> 'dependency_product_impact'
    or v_run.review_disposition <> 'review_required' or v_run.review_reason is distinct from 'critical_change'
    or v_run.production_exposure_state is distinct from 'unknown'
    or v_run.preflight_required is distinct from false
    or v_run.status <> 'validation_failed' or v_run.current_stage <> 'verify_patch'
    or v_run.failure_category is distinct from 'runner_result_invalid'
    or v_stage.status <> 'failed' or v_stage.attempt_count <> 1 or v_stage.operator_retry_count <> 0
    or v_stage.failure_category is distinct from 'runner_result_invalid'
    or exists (select 1 from public.fix_stage_queue x where x.fix_run_id = v_run.id
      and x.id <> v_stage.id and (x.stage not in ('diagnose', 'plan', 'generate_patch', 'apply_patch')
        or x.status <> 'completed'))
    or exists (select 1 from public.fix_verification_runs x where x.fix_run_id = v_run.id)
    or exists (select 1 from public.fix_preflight_results x where x.fix_run_id = v_run.id)
    or exists (select 1 from public.fix_risk_assessments x where x.fix_run_id = v_run.id)
    or exists (select 1 from public.fix_external_operations x where x.fix_run_id = v_run.id)
    or exists (select 1 from public.fix_pr_outcomes x where x.fix_run_id = v_run.id) then
    raise exception 'fresh_v4_verification_recovery_scope_invalid' using errcode = '42501';
  end if;

  -- The protected scope must still be live and correctly mapped.
  if not exists (
      select 1 from public.source_catalog c join public.source_changes s on s.source_id = c.id
      where s.id = v_run.source_change_id and s.workspace_id = v_run.workspace_id
        and s.scope_product_id = v_run.product_id
        and s.source_mode = 'internal_test' and s.processing_mode = 'evidence_only'
        and c.internal_acceptance_key = 'm1578r-internal-qa-fix-engine-v4'
    )
    or not exists (
      select 1 from public.workspace_products p where p.id = v_run.product_id
        and p.workspace_id = v_run.workspace_id and p.status = 'protected'
    )
    or not exists (
      select 1 from public.repositories r where r.id = v_run.repository_id
        and r.workspace_id = v_run.workspace_id
        and lower(r.owner || '/' || r.name) = lower(v_run.provider_repository_identity)
        and r.status = 'available' and not r.archived
    )
    or not exists (
      select 1 from public.workspace_product_repositories m
        where m.id = v_run.product_repository_mapping_id and m.workspace_id = v_run.workspace_id
          and m.protected_product_id = v_run.product_id and m.repository_id = v_run.repository_id
          and m.status = 'active'
    )
    or not exists (
      select 1 from public.workspace_dependencies d where d.id = v_run.workspace_dependency_id
        and d.workspace_id = v_run.workspace_id and d.protected_product_id = v_run.product_id
        and d.monitoring_enabled
    ) then
    raise exception 'fresh_v4_verification_recovery_scope_invalid' using errcode = '42501';
  end if;

  -- Exactly one immutable diagnosis, plan and applied patch, all bound to this run.
  if (select count(*) from public.fix_diagnoses d where d.fix_run_id = v_run.id) <> 1
    or (select count(*) from public.fix_plans p where p.fix_run_id = v_run.id) <> 1
    or (select count(*) from public.fix_patches p where p.fix_run_id = v_run.id) <> 1 then
    raise exception 'fresh_v4_verification_recovery_artifacts_ambiguous' using errcode = '42501';
  end if;
  select * into v_diagnosis from public.fix_diagnoses d
  where d.id = 'a5f3b4b7-c445-46bd-bc6f-d3888be8cc3b'::uuid
    and d.fix_run_id = v_run.id and d.workspace_id = v_run.workspace_id
    and d.graph_build_id = v_run.graph_build_id and d.analysis_run_id = v_run.analysis_run_id
    and d.repository_id = v_run.repository_id and d.commit_sha = v_run.commit_sha;
  if not found or v_diagnosis.output_fingerprint !~ '^[a-f0-9]{64}$'
    or cardinality(v_diagnosis.evidence_ids) = 0 then
    raise exception 'fresh_v4_verification_recovery_diagnosis_invalid' using errcode = '42501';
  end if;
  select * into v_plan from public.fix_plans p
  where p.id = 'c1034b08-39a1-4324-b224-2ceb220e86c9'::uuid and p.fix_run_id = v_run.id
    and p.workspace_id = v_run.workspace_id and p.plan_version = 1
    and p.plan_fingerprint = '3e0dd0cf6b0af47835a7e008b13afbdb8322818593bec2cae8da7347faecb4e3';
  if not found then
    raise exception 'fresh_v4_verification_recovery_plan_invalid' using errcode = '42501';
  end if;
  select * into v_patch from public.fix_patches p
  where p.id = '6a3980ff-b098-4a7e-808a-6980f5b61688'::uuid and p.fix_run_id = v_run.id
    and p.workspace_id = v_run.workspace_id and p.plan_id = v_plan.id and p.attempt_number = 1
    and p.base_sha = v_run.commit_sha
    and p.patch_fingerprint = 'c7e9cfc34baa27a69cbd724877bb549a21e8188fcd29cc5b3399fb5cac2b3ece'
    and p.status = 'applied';
  if not found then
    raise exception 'fresh_v4_verification_recovery_patch_invalid' using errcode = '42501';
  end if;

  -- The only prior runner evidence must be the rejected snapshot-extraction admission.
  if (select count(*) from public.fix_stage_runner_diagnostic_events e
      where e.fix_run_id = v_run.id) <> 1 then
    raise exception 'fresh_v4_verification_recovery_prior_failure_invalid' using errcode = '42501';
  end if;
  select * into v_event from public.fix_stage_runner_diagnostic_events e
  where e.id = '6986257c-e97a-46d1-8bb6-135104683976'::uuid and e.fix_run_id = v_run.id
    and e.workspace_id = v_run.workspace_id and e.stage_id = v_stage.id and e.attempt_number = 1
    and e.failure_category = 'runner_result_invalid' and not e.retryable
    and e.job_id = '5c51d42cac9d923dc32578fbf47ba81280cba3b0715acae8b5ddd053c991dd0b'
    and e.request_fingerprint = 'bd86f37e3c9073f9f97233d82b8eaf05c5dab7163cc173030841348622b1fcd5'
    and e.admission_state = 'rejected'
    and jsonb_array_length(e.diagnostics) = 1
    and e.diagnostics -> 0 ->> 'phase' = 'admission'
    and e.diagnostics -> 0 ->> 'admissionSubphase' = 'snapshot_archive_extraction';
  if not found then
    raise exception 'fresh_v4_verification_recovery_prior_failure_invalid' using errcode = '42501';
  end if;

  insert into public.fix_fresh_v4_verification_recovery_authorizations (
    fix_run_id, workspace_id, stage_id, identity_fingerprint, evidence_fingerprint,
    source_change_id, route_intent_id, graph_build_id, analysis_run_id, product_id,
    repository_id, commit_sha, diagnosis_id, diagnosis_fingerprint, plan_id, plan_fingerprint,
    patch_id, patch_fingerprint, patch_attempt_number, prior_runner_event_id,
    prior_runner_job_id, prior_runner_request_fingerprint, prior_admission_state,
    prior_admission_subphase, prior_run_status, prior_run_failure_category, prior_stage_status,
    prior_stage_failure_category, prior_attempt_count, prior_operator_retry_count,
    prior_patch_status, cache_identity_key, cache_manifest_fingerprint, cache_archive_sha256,
    cache_tree_sha256, runner_attestation_account, runner_attestation_region,
    runner_attestation_instance_id, runner_image_id, runner_protocol, authorization_reference,
    trigger_run_id
  ) values (
    v_run.id, v_run.workspace_id, v_stage.id, v_run.identity_fingerprint, v_run.evidence_fingerprint,
    v_run.source_change_id, v_run.route_intent_id, v_run.graph_build_id, v_run.analysis_run_id,
    v_run.product_id, v_run.repository_id, v_run.commit_sha, v_diagnosis.id,
    v_diagnosis.output_fingerprint, v_plan.id, v_plan.plan_fingerprint, v_patch.id,
    v_patch.patch_fingerprint, v_patch.attempt_number, v_event.id, v_event.job_id,
    v_event.request_fingerprint, v_event.admission_state,
    v_event.diagnostics -> 0 ->> 'admissionSubphase', v_run.status, v_run.failure_category,
    v_stage.status, v_stage.failure_category, v_stage.attempt_count, v_stage.operator_retry_count,
    v_patch.status, p_cache_identity_key, p_cache_manifest_fingerprint, p_cache_archive_sha256,
    p_cache_tree_sha256, p_runner_attestation_account, p_runner_attestation_region,
    p_runner_attestation_instance_id, p_runner_image_id, p_runner_protocol,
    p_authorization_reference, p_trigger_run_id
  ) returning * into v_existing;

  -- Requeue only the verify stage; earlier stages and their artifacts stay as recorded.
  update public.fix_stage_queue q set status = 'queued', operator_retry_count = 1,
    claim_token = null, lease_expires_at = null, failure_category = null, completed_at = null
  where q.id = v_stage.id and q.status = 'failed' and q.attempt_count = 1
    and q.operator_retry_count = 0 and q.failure_category = 'runner_result_invalid';
  if not found then
    raise exception 'fresh_v4_verification_recovery_stage_race' using errcode = '40001';
  end if;
  update public.fix_runs r set status = 'queued', failure_category = null, completed_at = null,
    updated_at = now()
  where r.id = v_run.id and r.workspace_id = v_run.workspace_id
    and r.status = 'validation_failed' and r.current_stage = 'verify_patch'
    and r.failure_category = 'runner_result_invalid';
  if not found then
    raise exception 'fresh_v4_verification_recovery_run_race' using errcode = '40001';
  end if;

  return jsonb_build_object('status', 'retry_queued', 'fixRunId', v_run.id,
    'stageId', v_stage.id, 'recoveryId', v_existing.id);
end;
$$;

revoke all on function public.authorize_fresh_v4_fix_verification_recovery(
  uuid,text,text,text,text,text,text,text,text,text,text,text
) from public, anon, authenticated;
grant execute on function public.authorize_fresh_v4_fix_verification_recovery(
  uuid,text,text,text,text,text,text,text,text,text,text,text
) to service_role;

-- Keep the recovered stage out of the cron dispatcher so it is delivered exactly
-- once, by the recovery task, under a recovery-specific idempotency key.
create or replace function public.list_fix_stage_work(p_limit integer default 50)
returns table(fix_run_id uuid, stage text, attempt_count integer, idempotency_key text)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_limit not between 1 and 100 then raise exception 'invalid_fix_stage_batch_size' using errcode = '22023'; end if;
  return query
    select q.fix_run_id, q.stage, q.attempt_count, q.idempotency_key
    from public.fix_stage_queue q
    where not (
      q.id = 'bd3238d9-79a9-46ca-88d1-e67f346ecc0a'::uuid
      and q.fix_run_id = '7de04a75-aefa-43a6-ba64-9fa4a70e0ec1'::uuid
      and q.workspace_id = 'e140d48e-9dc0-4552-a9a4-a81fe3872422'::uuid
      and q.stage = 'verify_patch'
    )
      and not (
        q.id = '731cab44-66df-4fe4-9794-b55ecabd1b3f'::uuid
        and q.fix_run_id = '8d38263a-8c0c-41cc-aaf0-e85770c1bfdb'::uuid
        and q.workspace_id = 'e140d48e-9dc0-4552-a9a4-a81fe3872422'::uuid
        and q.stage = 'verify_patch'
      )
      and ((q.status = 'queued' and (
        q.attempt_count < 3
        or (q.stage = 'diagnose' and q.attempt_count = 3 and exists (
          select 1 from public.fix_stage_recovery_authorizations a
          where a.fix_run_id = q.fix_run_id and a.workspace_id = q.workspace_id and a.stage_id = q.id
            and a.stage = 'diagnose' and a.recovery_generation = 1
        ))
      )) or (q.status = 'claimed' and q.lease_expires_at < now()))
    order by q.created_at, q.id limit p_limit;
end;
$$;
revoke all on function public.list_fix_stage_work(integer) from public, anon, authenticated;
grant execute on function public.list_fix_stage_work(integer) to service_role;
