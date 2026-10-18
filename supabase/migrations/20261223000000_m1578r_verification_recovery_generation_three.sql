-- One strictly bounded generation-three recovery for the fixed M15.78R
-- evidence-only verification stage. Generations one and two remain immutable.
create table public.fix_verification_recovery_generation_three_authorizations (
  id uuid primary key default gen_random_uuid(),
  fix_run_id uuid not null,
  workspace_id uuid not null check (workspace_id = 'e140d48e-9dc0-4552-a9a4-a81fe3872422'),
  stage_id uuid not null check (stage_id = 'bd3238d9-79a9-46ca-88d1-e67f346ecc0a'),
  stage text not null default 'verify_patch' check (stage = 'verify_patch'),
  recovery_generation smallint not null default 3 check (recovery_generation = 3),
  generation_one_authorization_id uuid not null
    check (generation_one_authorization_id = '36ea2095-ad2b-4bb0-9235-2fb5b02e9106')
    references public.fix_verification_recovery_authorizations(id) on delete restrict,
  generation_two_authorization_id uuid not null
    check (generation_two_authorization_id = '4985982e-befe-483c-9a24-45dc160446bf')
    references public.fix_verification_recovery_generation_two_authorizations(id) on delete restrict,
  identity_fingerprint text not null check (identity_fingerprint ~ '^[a-f0-9]{64}$'),
  source_change_id uuid not null check (source_change_id = 'b5311d8d-28a9-4de7-80f0-056f16c168e7'),
  graph_build_id uuid not null check (graph_build_id = 'd104070c-ea38-44d6-b1bf-56d8b18d4248'),
  analysis_run_id uuid not null check (analysis_run_id = '6f64060d-1dd7-4b10-ac3d-4db4f8ad58a6'),
  product_id uuid not null check (product_id = 'de1f2a12-de3c-4644-8892-b6c2d458a300'),
  repository_id uuid not null check (repository_id = 'b2abf377-2dbc-4b9c-b546-b0604f3ee4fe'),
  commit_sha text not null check (commit_sha = '94135df6f85bfb34ac83c046e5541e1ad8d73a86'),
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[a-f0-9]{64}$'),
  diagnosis_id uuid not null check (diagnosis_id = 'be3f7337-55ed-4e0f-8fed-63b69d81c069'),
  diagnosis_fingerprint text not null check (diagnosis_fingerprint = '9152f9b4d2aab67c273752cf214c24cc3d2619be927b2866b0d994e23024959e'),
  plan_id uuid not null,
  plan_fingerprint text not null check (plan_fingerprint = 'ea769c328a8b44d3001a12f32c1980bb2d71e9fc2e0c5c011fc5a4a1fadfb51f'),
  patch_id uuid not null,
  patch_fingerprint text not null check (patch_fingerprint = 'c7e9cfc34baa27a69cbd724877bb549a21e8188fcd29cc5b3399fb5cac2b3ece'),
  patch_attempt_number smallint not null default 2 check (patch_attempt_number = 2),
  cache_identity_key text not null check (cache_identity_key = '86ab5d3a45b9e1a5218418e7856cb48b1c8fadf242c0b5ffb18ffb517463832c'),
  cache_manifest_fingerprint text not null check (cache_manifest_fingerprint ~ '^[a-f0-9]{64}$'),
  cache_archive_sha256 text not null check (cache_archive_sha256 ~ '^[a-f0-9]{64}$'),
  cache_tree_sha256 text not null check (cache_tree_sha256 ~ '^[a-f0-9]{64}$'),
  prior_run_status text not null check (prior_run_status = 'validation_failed'),
  prior_run_failure_category text not null check (prior_run_failure_category = 'runner_result_invalid'),
  prior_stage_status text not null check (prior_stage_status = 'failed'),
  prior_stage_failure_category text not null check (prior_stage_failure_category = 'runner_result_invalid'),
  prior_attempt_count integer not null check (prior_attempt_count = 3),
  prior_operator_retry_count integer not null check (prior_operator_retry_count = 2),
  prior_patch_status text not null check (prior_patch_status = 'applied'),
  authorization_actor text not null check (authorization_actor = 'codex_operator'),
  authorization_reference text not null check (
    authorization_reference = 'M15.78R user-authorized generation 3 after diagnostic readback preparation'
  ),
  trigger_run_id text not null check (trigger_run_id ~ '^run_[A-Za-z0-9]{8,80}$'),
  runner_attestation_account text not null check (runner_attestation_account = '737759272471'),
  runner_attestation_region text not null check (runner_attestation_region = 'eu-west-1'),
  runner_attestation_instance_id text not null check (runner_attestation_instance_id = 'i-0592719b99a518001'),
  runner_image_id text not null check (
    runner_image_id = 'sha256:408117eeeee5477f56eae8d8bb16cda12cf01ad0596b7ce3269bf2e2beaa56ee'
  ),
  runner_protocol text not null check (runner_protocol = 'm1578-verification-runner-v1'),
  runner_attestation_verified boolean not null default true check (runner_attestation_verified),
  runner_attestation_checked_at timestamptz not null default now(),
  diagnostics_contract_version text not null default 'runner-failure-diagnostics-v1'
    check (diagnostics_contract_version = 'runner-failure-diagnostics-v1'),
  authorization_reason text not null check (authorization_reason = 'one_time_operator_approved_verification_recovery_after_runner_attestation'),
  authorized_at timestamptz not null default now(),
  constraint fix_verification_recovery_generation_three_once unique (fix_run_id, stage),
  constraint fix_verification_recovery_generation_three_run_scope_fkey
    foreign key (fix_run_id, workspace_id) references public.fix_runs(id, workspace_id) on delete restrict,
  constraint fix_verification_recovery_generation_three_stage_scope_fkey
    foreign key (stage_id, fix_run_id, workspace_id)
    references public.fix_stage_queue(id, fix_run_id, workspace_id) on delete restrict,
  constraint fix_verification_recovery_generation_three_plan_scope_fkey
    foreign key (plan_id, fix_run_id) references public.fix_plans(id, fix_run_id) on delete restrict,
  constraint fix_verification_recovery_generation_three_patch_scope_fkey
    foreign key (patch_id, fix_run_id) references public.fix_patches(id, fix_run_id) on delete restrict
);

alter table public.fix_verification_recovery_generation_three_authorizations enable row level security;
revoke all on public.fix_verification_recovery_generation_three_authorizations
  from public, anon, authenticated, service_role;
grant select on public.fix_verification_recovery_generation_three_authorizations to service_role;

create trigger fix_verification_recovery_generation_three_authorizations_immutable
  before update or delete on public.fix_verification_recovery_generation_three_authorizations
  for each row execute function private.reject_fix_stage_recovery_mutation();

-- Keep the retry cap at two for every ordinary stage. A third operator retry
-- is permitted only for this exact verify_patch row after its immutable G3
-- authorization has been inserted in the same transaction.
alter table public.fix_stage_queue
  drop constraint if exists fix_stage_queue_operator_retry_count_check;
alter table public.fix_stage_queue
  add constraint fix_stage_queue_operator_retry_count_check
  check (operator_retry_count between 0 and 3);

create function private.guard_m1578r_generation_three_operator_retry()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.operator_retry_count = 3 and not (
    new.id = 'bd3238d9-79a9-46ca-88d1-e67f346ecc0a'::uuid
    and new.fix_run_id = '7de04a75-aefa-43a6-ba64-9fa4a70e0ec1'::uuid
    and new.workspace_id = 'e140d48e-9dc0-4552-a9a4-a81fe3872422'::uuid
    and new.stage = 'verify_patch'
    and new.status = 'queued'
    and new.attempt_count = 3
    and new.failure_category is null
    and exists (
      select 1 from public.fix_verification_recovery_generation_three_authorizations a
      where a.fix_run_id = new.fix_run_id and a.workspace_id = new.workspace_id
        and a.stage_id = new.id and a.stage = 'verify_patch' and a.recovery_generation = 3
    )
  ) then
    raise exception 'fix_stage_generation_three_retry_not_authorized' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_m1578r_generation_three_operator_retry() from public, anon, authenticated;
create trigger fix_stage_generation_three_operator_retry_guard
  before insert or update of operator_retry_count on public.fix_stage_queue
  for each row execute function private.guard_m1578r_generation_three_operator_retry();

create function public.authorize_internal_fix_verification_recovery_generation_three(
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
  v_generation_one public.fix_verification_recovery_authorizations%rowtype;
  v_generation_two public.fix_verification_recovery_generation_two_authorizations%rowtype;
  v_generation_three public.fix_verification_recovery_generation_three_authorizations%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_fix_run_id is distinct from '7de04a75-aefa-43a6-ba64-9fa4a70e0ec1'::uuid
    or p_authorization_reference is distinct from
      'M15.78R user-authorized generation 3 after diagnostic readback preparation'
    or p_trigger_run_id is null or p_trigger_run_id !~ '^run_[A-Za-z0-9]{8,80}$'
    or p_cache_identity_key is distinct from '86ab5d3a45b9e1a5218418e7856cb48b1c8fadf242c0b5ffb18ffb517463832c'
    or p_cache_manifest_fingerprint is null or p_cache_manifest_fingerprint !~ '^[a-f0-9]{64}$'
    or p_cache_archive_sha256 is null or p_cache_archive_sha256 !~ '^[a-f0-9]{64}$'
    or p_cache_tree_sha256 is null or p_cache_tree_sha256 !~ '^[a-f0-9]{64}$'
    or p_runner_attestation_account is distinct from '737759272471'
    or p_runner_attestation_region is distinct from 'eu-west-1'
    or p_runner_attestation_instance_id is distinct from 'i-0592719b99a518001'
    or p_runner_image_id is distinct from 'sha256:408117eeeee5477f56eae8d8bb16cda12cf01ad0596b7ce3269bf2e2beaa56ee'
    or p_runner_protocol is distinct from 'm1578-verification-runner-v1' then
    raise exception 'internal_fix_verification_recovery_request_invalid' using errcode = '22023';
  end if;

  select * into v_run from public.fix_runs r
  where r.id = p_fix_run_id and r.workspace_id = 'e140d48e-9dc0-4552-a9a4-a81fe3872422'::uuid
  for update;
  if not found then
    raise exception 'internal_fix_verification_recovery_run_not_found' using errcode = 'P0002';
  end if;
  select * into v_stage from public.fix_stage_queue q
  where q.fix_run_id = v_run.id and q.workspace_id = v_run.workspace_id
    and q.id = 'bd3238d9-79a9-46ca-88d1-e67f346ecc0a'::uuid and q.stage = 'verify_patch'
  for update;
  if not found then
    raise exception 'internal_fix_verification_recovery_stage_not_found' using errcode = 'P0002';
  end if;

  select * into v_generation_one from public.fix_verification_recovery_authorizations a
  where a.id = '36ea2095-ad2b-4bb0-9235-2fb5b02e9106'::uuid
    and a.fix_run_id = v_run.id and a.stage_id = v_stage.id and a.stage = 'verify_patch'
    and a.recovery_generation = 1;
  select * into v_generation_two from public.fix_verification_recovery_generation_two_authorizations a
  where a.id = '4985982e-befe-483c-9a24-45dc160446bf'::uuid
    and a.fix_run_id = v_run.id and a.stage_id = v_stage.id and a.stage = 'verify_patch'
    and a.recovery_generation = 2;
  if not found
    or v_generation_one.id is null
    or v_generation_one.patch_id <> 'c258f201-854e-4469-8bf7-7f4d2805a1e5'::uuid
    or v_generation_one.patch_fingerprint <> 'c7e9cfc34baa27a69cbd724877bb549a21e8188fcd29cc5b3399fb5cac2b3ece'
    or v_generation_two.generation_one_authorization_id <> v_generation_one.id
    or v_generation_two.patch_id <> 'c258f201-854e-4469-8bf7-7f4d2805a1e5'::uuid
    or v_generation_two.patch_fingerprint <> 'c7e9cfc34baa27a69cbd724877bb549a21e8188fcd29cc5b3399fb5cac2b3ece'
    or v_generation_two.prior_attempt_count <> 2
    or v_generation_two.prior_operator_retry_count <> 1
    or v_generation_two.prior_run_failure_category <> 'cache_signature_invalid'
    or v_generation_two.prior_stage_failure_category <> 'cache_signature_invalid'
    or v_generation_two.cache_identity_key <> p_cache_identity_key
    or v_generation_two.cache_manifest_fingerprint <> p_cache_manifest_fingerprint
    or v_generation_two.cache_archive_sha256 <> p_cache_archive_sha256
    or v_generation_two.cache_tree_sha256 <> p_cache_tree_sha256 then
    raise exception 'internal_fix_verification_recovery_prior_history_invalid' using errcode = '42501';
  end if;

  select * into v_generation_three from public.fix_verification_recovery_generation_three_authorizations a
  where a.fix_run_id = v_run.id and a.stage_id = v_stage.id and a.stage = 'verify_patch';
  if found then
    if v_generation_three.generation_one_authorization_id <> v_generation_one.id
      or v_generation_three.generation_two_authorization_id <> v_generation_two.id
      or v_generation_three.cache_identity_key <> p_cache_identity_key
      or v_generation_three.cache_manifest_fingerprint <> p_cache_manifest_fingerprint
      or v_generation_three.cache_archive_sha256 <> p_cache_archive_sha256
      or v_generation_three.cache_tree_sha256 <> p_cache_tree_sha256
      or v_generation_three.runner_image_id <> p_runner_image_id then
      raise exception 'internal_fix_verification_recovery_generation_three_conflict' using errcode = '42501';
    end if;
    if v_stage.status = 'queued' and v_stage.attempt_count = 3
      and v_stage.operator_retry_count = 3 and v_stage.failure_category is null
      and v_run.status = 'queued' and v_run.failure_category is null then
      return jsonb_build_object('status', 'already_authorized', 'fixRunId', v_run.id,
        'stageId', v_stage.id, 'recoveryId', v_generation_three.id, 'recoveryGeneration', 3);
    end if;
    if v_stage.attempt_count = 4 and v_stage.operator_retry_count = 3
      and v_stage.status in ('claimed', 'completed', 'failed') then
      return jsonb_build_object('status', 'already_consumed', 'fixRunId', v_run.id,
        'stageId', v_stage.id, 'stageStatus', v_stage.status,
        'recoveryId', v_generation_three.id, 'recoveryGeneration', 3);
    end if;
    raise exception 'internal_fix_verification_recovery_generation_three_state_conflict'
      using errcode = '42501';
  end if;

  if v_run.product_id <> 'de1f2a12-de3c-4644-8892-b6c2d458a300'::uuid
    or v_run.repository_id <> 'b2abf377-2dbc-4b9c-b546-b0604f3ee4fe'::uuid
    or v_run.product_repository_mapping_id <> 'ed0fa73d-3dd2-46b4-a8bd-a603919e01a0'::uuid
    or v_run.workspace_dependency_id <> '867eb92b-2ed2-4917-ac68-44a22773e369'::uuid
    or lower(v_run.provider_repository_identity) <> 'michelpronkk-oss/auterim-m15-github-qa'
    or v_run.source_change_id <> 'b5311d8d-28a9-4de7-80f0-056f16c168e7'::uuid
    or v_run.analysis_run_id <> '6f64060d-1dd7-4b10-ac3d-4db4f8ad58a6'::uuid
    or v_run.graph_build_id <> 'd104070c-ea38-44d6-b1bf-56d8b18d4248'::uuid
    or v_run.commit_sha <> '94135df6f85bfb34ac83c046e5541e1ad8d73a86'
    or v_run.source_mode <> 'internal_test' or v_run.processing_mode <> 'evidence_only'
    or v_run.provenance_mode <> 'evidence_only'
    or v_run.semantic_route <> 'deprecation' or v_run.route_target <> 'dependency_product_impact'
    or v_run.review_disposition <> 'review_required' or v_run.review_reason is distinct from 'critical_change'
    or v_run.production_exposure_state is distinct from 'unknown'
    or v_run.preflight_required is distinct from false
    or v_run.status <> 'validation_failed' or v_run.current_stage <> 'verify_patch'
    or v_run.failure_category is distinct from 'runner_result_invalid'
    or v_stage.status <> 'failed' or v_stage.attempt_count <> 3 or v_stage.operator_retry_count <> 2
    or v_stage.failure_category is distinct from 'runner_result_invalid'
    or exists (select 1 from public.fix_verification_runs x where x.fix_run_id = v_run.id)
    or exists (select 1 from public.fix_preflight_results x where x.fix_run_id = v_run.id)
    or exists (select 1 from public.fix_risk_assessments x where x.fix_run_id = v_run.id)
    or exists (select 1 from public.fix_external_operations x where x.fix_run_id = v_run.id)
    or exists (select 1 from public.fix_pr_outcomes x where x.fix_run_id = v_run.id) then
    raise exception 'internal_fix_verification_recovery_scope_invalid' using errcode = '42501';
  end if;

  if not exists (
      select 1 from public.source_changes s where s.id = v_run.source_change_id
        and s.workspace_id = v_run.workspace_id and s.scope_product_id = v_run.product_id
        and s.source_mode = 'internal_test' and s.processing_mode = 'evidence_only'
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
    raise exception 'internal_fix_verification_recovery_scope_invalid' using errcode = '42501';
  end if;

  select * into v_diagnosis from public.fix_diagnoses d
  where d.id = 'be3f7337-55ed-4e0f-8fed-63b69d81c069'::uuid
    and d.fix_run_id = v_run.id and d.workspace_id = v_run.workspace_id
    and d.graph_build_id = v_run.graph_build_id and d.analysis_run_id = v_run.analysis_run_id
    and d.repository_id = v_run.repository_id and d.commit_sha = v_run.commit_sha;
  if not found or v_diagnosis.output_fingerprint is distinct from '9152f9b4d2aab67c273752cf214c24cc3d2619be927b2866b0d994e23024959e'
    or cardinality(v_diagnosis.evidence_ids) = 0 then
    raise exception 'internal_fix_verification_recovery_diagnosis_invalid' using errcode = '42501';
  end if;

  select * into v_plan from public.fix_plans p
  where p.id = 'aa9c2345-5134-4097-b0f9-0204d88f76f9'::uuid and p.fix_run_id = v_run.id
    and p.workspace_id = v_run.workspace_id and p.plan_version = 1
    and p.plan_fingerprint = 'ea769c328a8b44d3001a12f32c1980bb2d71e9fc2e0c5c011fc5a4a1fadfb51f'
    and p.provider = 'azure-openai' and p.model = 'gpt-6.1-sol'
    and p.prompt_contract_version = 'fix-coding-contract-v3';
  if not found then
    raise exception 'internal_fix_verification_recovery_plan_invalid' using errcode = '42501';
  end if;

  select * into v_patch from public.fix_patches p
  where p.id = 'c258f201-854e-4469-8bf7-7f4d2805a1e5'::uuid and p.fix_run_id = v_run.id
    and p.workspace_id = v_run.workspace_id and p.plan_id = v_plan.id and p.attempt_number = 2
    and p.base_sha = v_run.commit_sha
    and p.patch_fingerprint = 'c7e9cfc34baa27a69cbd724877bb549a21e8188fcd29cc5b3399fb5cac2b3ece'
    and p.status = 'applied';
  if not found then
    raise exception 'internal_fix_verification_recovery_patch_invalid' using errcode = '42501';
  end if;

  insert into public.fix_verification_recovery_generation_three_authorizations (
    fix_run_id, workspace_id, stage_id, generation_one_authorization_id,
    generation_two_authorization_id, identity_fingerprint, source_change_id, graph_build_id,
    analysis_run_id, product_id, repository_id, commit_sha, evidence_fingerprint,
    diagnosis_id, diagnosis_fingerprint,
    plan_id, plan_fingerprint, patch_id, patch_fingerprint, patch_attempt_number,
    cache_identity_key, cache_manifest_fingerprint, cache_archive_sha256, cache_tree_sha256,
    prior_run_status, prior_run_failure_category, prior_stage_status, prior_stage_failure_category,
    prior_attempt_count, prior_operator_retry_count, prior_patch_status,
    authorization_actor, authorization_reference, trigger_run_id, runner_attestation_account,
    runner_attestation_region, runner_attestation_instance_id, runner_image_id, runner_protocol,
    runner_attestation_verified, runner_attestation_checked_at, authorization_reason
  ) values (
    v_run.id, v_run.workspace_id, v_stage.id, v_generation_one.id, v_generation_two.id,
    v_run.identity_fingerprint, v_run.source_change_id, v_run.graph_build_id, v_run.analysis_run_id,
    v_run.product_id, v_run.repository_id, v_run.commit_sha, v_run.evidence_fingerprint,
    v_diagnosis.id, v_diagnosis.output_fingerprint,
    v_plan.id, v_plan.plan_fingerprint, v_patch.id, v_patch.patch_fingerprint, v_patch.attempt_number,
    p_cache_identity_key, p_cache_manifest_fingerprint, p_cache_archive_sha256, p_cache_tree_sha256,
    v_run.status, v_run.failure_category, v_stage.status, v_stage.failure_category,
    v_stage.attempt_count, v_stage.operator_retry_count, v_patch.status, 'codex_operator',
    p_authorization_reference, p_trigger_run_id, p_runner_attestation_account,
    p_runner_attestation_region, p_runner_attestation_instance_id, p_runner_image_id, p_runner_protocol,
    true, now(), 'one_time_operator_approved_verification_recovery_after_runner_attestation'
  ) returning * into v_generation_three;

  update public.fix_stage_queue q set status = 'queued', operator_retry_count = 3,
    claim_token = null, lease_expires_at = null, failure_category = null, completed_at = null
  where q.id = v_stage.id and q.status = 'failed' and q.attempt_count = 3
    and q.operator_retry_count = 2 and q.failure_category = 'runner_result_invalid';
  if not found then
    raise exception 'internal_fix_verification_recovery_stage_race' using errcode = '40001';
  end if;
  update public.fix_runs r set status = 'queued', failure_category = null, completed_at = null,
    updated_at = now()
  where r.id = v_run.id and r.workspace_id = v_run.workspace_id
    and r.status = 'validation_failed' and r.current_stage = 'verify_patch'
    and r.failure_category = 'runner_result_invalid';
  if not found then
    raise exception 'internal_fix_verification_recovery_run_race' using errcode = '40001';
  end if;

  return jsonb_build_object('status', 'retry_queued', 'fixRunId', v_run.id,
    'stageId', v_stage.id, 'recoveryId', v_generation_three.id, 'recoveryGeneration', 3);
end;
$$;

revoke all on function public.authorize_internal_fix_verification_recovery_generation_three(
  uuid,text,text,text,text,text,text,text,text,text,text,text
) from public, anon, authenticated;
grant execute on function public.authorize_internal_fix_verification_recovery_generation_three(
  uuid,text,text,text,text,text,text,text,text,text,text,text
) to service_role;

-- The general stage cap remains three. Attempt four is claimable only for the
-- exact verify_patch stage after the unique, immutable generation-three row.
create or replace function public.claim_fix_stage(p_stage_id uuid, p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  q public.fix_stage_queue%rowtype;
  v_run public.fix_runs%rowtype;
  v_policy public.product_remediation_policies%rowtype;
  v_policy_found boolean := false;
  v_preflight_required boolean := false;
  v_token uuid := gen_random_uuid();
  v_next text;
  v_status text;
  v_recovery_generation smallint := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_lease_seconds not between 15 and 300 then raise exception 'invalid_fix_stage_lease' using errcode = '22023'; end if;
  select * into q from public.fix_stage_queue where id = p_stage_id for update;
  if found and q.status = 'completed' then
    select stage into v_next from public.fix_stage_queue where fix_run_id = q.fix_run_id and status = 'queued'
      order by created_at limit 1;
    return jsonb_build_object('status', 'completed', 'stageId', q.id, 'fixRunId', q.fix_run_id, 'replayed', true, 'nextStage', v_next);
  end if;
  if found and q.status = 'claimed' and q.lease_expires_at < now() and q.attempt_count >= 3 then
    select * into v_run from public.fix_runs where id = q.fix_run_id and workspace_id = q.workspace_id for update;
    v_status := case q.stage when 'diagnose' then 'diagnosis_failed' when 'plan' then 'plan_failed'
      when 'generate_patch' then 'patch_failed' when 'apply_patch' then 'patch_conflict'
      when 'verify_patch' then 'validation_failed' when 'preflight' then 'preflight_failed'
      when 'risk_assess' then 'risk_blocked' else 'failed' end;
    update public.fix_stage_queue set status = 'failed', claim_token = null, lease_expires_at = null,
      failure_category = 'fix_stage_lease_retry_limit', completed_at = now() where id = q.id;
    update public.fix_runs set status = v_status, failure_category = 'fix_stage_lease_retry_limit', updated_at = now(), completed_at = now() where id = v_run.id;
    return jsonb_build_object('status', v_status, 'stageId', q.id, 'fixRunId', q.fix_run_id, 'retryExhausted', true);
  end if;
  update public.fix_stage_queue x
  set status = 'claimed', claim_token = v_token, lease_expires_at = now() + make_interval(secs => p_lease_seconds), attempt_count = attempt_count + 1
  where x.id = p_stage_id
    and (x.attempt_count < 3
      or (x.stage = 'diagnose' and x.attempt_count = 3 and exists (
        select 1 from public.fix_stage_recovery_authorizations a
        where a.fix_run_id = x.fix_run_id and a.workspace_id = x.workspace_id and a.stage_id = x.id
          and a.stage = 'diagnose' and a.recovery_generation = 1
      ))
      or (x.stage = 'verify_patch' and x.attempt_count = 3 and exists (
        select 1 from public.fix_verification_recovery_generation_three_authorizations a
        where a.fix_run_id = x.fix_run_id and a.workspace_id = x.workspace_id and a.stage_id = x.id
          and a.stage = 'verify_patch' and a.recovery_generation = 3
      )))
    and (x.status = 'queued' or (x.status = 'claimed' and x.lease_expires_at < now()))
  returning x.* into q;
  if not found then return jsonb_build_object('status', 'busy'); end if;

  select * into v_run from public.fix_runs where id = q.fix_run_id and workspace_id = q.workspace_id;
  select * into v_policy from public.product_remediation_policies p where p.workspace_id = v_run.workspace_id and p.product_id = v_run.product_id;
  v_policy_found := found;
  v_preflight_required := private.fix_preflight_applicable(
    v_run.source_mode, v_run.semantic_route, v_policy_found and v_policy.enabled,
    v_policy_found and v_policy.draft_pr_preparation_allowed,
    v_policy_found and v_run.repository_id = any(v_policy.allowed_repository_ids)
  );
  if v_run.product_policy_version <> (case when v_policy_found then v_policy.policy_version else 0 end)
    or v_run.preflight_applicability_version <> 'fix-preflight-v1'
    or v_run.preflight_required is distinct from v_preflight_required then
    update public.fix_stage_queue set status = 'failed', claim_token = null, lease_expires_at = null,
      failure_category = 'fix_product_policy_stale', completed_at = now() where id = q.id;
    update public.fix_runs set status = 'failed', failure_category = 'fix_product_policy_stale', updated_at = now(), completed_at = now()
      where id = v_run.id;
    return jsonb_build_object('status', 'stale_policy', 'stageId', q.id, 'fixRunId', q.fix_run_id);
  end if;
  if not exists(select 1 from public.workspace_products p where p.id = v_run.product_id and p.workspace_id = v_run.workspace_id and p.status = 'protected')
    or not exists(select 1 from public.repositories r where r.id = v_run.repository_id and r.workspace_id = v_run.workspace_id and r.status = 'available' and not r.archived)
    or not exists(select 1 from public.workspace_dependencies d where d.id = v_run.workspace_dependency_id and d.workspace_id = v_run.workspace_id
      and d.protected_product_id = v_run.product_id and d.monitoring_enabled)
    or not exists(select 1 from public.workspace_product_repositories m where m.id = v_run.product_repository_mapping_id
      and m.workspace_id = v_run.workspace_id and m.protected_product_id = v_run.product_id and m.repository_id = v_run.repository_id and m.status = 'active') then
    update public.fix_stage_queue set status = 'failed', claim_token = null, lease_expires_at = null,
      failure_category = 'fix_scope_stale', completed_at = now() where id = q.id;
    update public.fix_runs set status = 'failed', failure_category = 'fix_scope_stale', updated_at = now(), completed_at = now()
      where id = v_run.id;
    return jsonb_build_object('status', 'stale_scope', 'stageId', q.id, 'fixRunId', q.fix_run_id);
  end if;
  if q.stage = 'verify_patch' and q.attempt_count = 4 then
    v_recovery_generation := 3;
  elsif q.stage = 'diagnose' and q.attempt_count = 4 then
    v_recovery_generation := 1;
  end if;
  update public.fix_runs set current_stage = q.stage,
    status = case q.stage when 'diagnose' then 'diagnosing' when 'plan' then 'planning'
      when 'generate_patch' then 'generating_patch' when 'apply_patch' then 'applying_patch'
      when 'verify_patch' then 'validating' when 'preflight' then 'preflight_pending'
      when 'risk_assess' then 'risk_assessing' else 'creating_pr' end,
    updated_at = now() where id = v_run.id;
  return jsonb_build_object('status', 'claimed', 'stageId', q.id, 'fixRunId', q.fix_run_id,
    'claimToken', v_token, 'stage', q.stage, 'attemptNumber', q.attempt_count,
    'workspaceId', v_run.workspace_id, 'productId', v_run.product_id, 'repositoryId', v_run.repository_id,
    'commitSha', v_run.commit_sha, 'provenanceMode', v_run.provenance_mode,
    'reviewDisposition', v_run.review_disposition, 'reviewReason', v_run.review_reason,
    'recoveryGeneration', v_recovery_generation);
end;
$$;
revoke all on function public.claim_fix_stage(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_fix_stage(uuid, integer) to service_role;

create or replace function public.list_fix_stage_work(p_limit integer default 50)
returns table(fix_run_id uuid, stage text, attempt_count integer, idempotency_key text)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_limit not between 1 and 100 then raise exception 'invalid_fix_stage_batch_size' using errcode = '22023'; end if;
  return query
    select q.fix_run_id, q.stage, q.attempt_count, q.idempotency_key
    from public.fix_stage_queue q
    where ((q.status = 'queued' and (
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
