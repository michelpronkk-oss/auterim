-- One additional, explicitly authorized verification recovery after the
-- generation-one attempt failed before reaching the remote runner because the
-- runner trusted a different cache-signing public key. Generation one remains
-- immutable; this ledger admits exactly one generation-two authorization.
create table public.fix_verification_recovery_generation_two_authorizations (
  id uuid primary key default gen_random_uuid(),
  fix_run_id uuid not null,
  workspace_id uuid not null check (workspace_id = 'e140d48e-9dc0-4552-a9a4-a81fe3872422'),
  stage_id uuid not null check (stage_id = 'bd3238d9-79a9-46ca-88d1-e67f346ecc0a'),
  stage text not null default 'verify_patch' check (stage = 'verify_patch'),
  recovery_generation smallint not null default 2 check (recovery_generation = 2),
  generation_one_authorization_id uuid not null
    references public.fix_verification_recovery_authorizations(id) on delete restrict,
  identity_fingerprint text not null check (identity_fingerprint ~ '^[a-f0-9]{64}$'),
  source_change_id uuid not null check (source_change_id = 'b5311d8d-28a9-4de7-80f0-056f16c168e7'),
  graph_build_id uuid not null check (graph_build_id = 'd104070c-ea38-44d6-b1bf-56d8b18d4248'),
  analysis_run_id uuid not null check (analysis_run_id = '6f64060d-1dd7-4b10-ac3d-4db4f8ad58a6'),
  product_id uuid not null check (product_id = 'de1f2a12-de3c-4644-8892-b6c2d458a300'),
  repository_id uuid not null check (repository_id = 'b2abf377-2dbc-4b9c-b546-b0604f3ee4fe'),
  commit_sha text not null check (commit_sha = '94135df6f85bfb34ac83c046e5541e1ad8d73a86'),
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[a-f0-9]{64}$'),
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
  prior_run_failure_category text not null check (prior_run_failure_category = 'cache_signature_invalid'),
  prior_stage_status text not null check (prior_stage_status = 'failed'),
  prior_stage_failure_category text not null check (prior_stage_failure_category = 'cache_signature_invalid'),
  prior_attempt_count integer not null check (prior_attempt_count = 2),
  prior_operator_retry_count integer not null check (prior_operator_retry_count = 1),
  prior_patch_status text not null check (prior_patch_status = 'applied'),
  authorization_actor text not null check (authorization_actor = 'codex_operator'),
  authorization_reference text not null check (
    authorization_reference = 'M15.78R user-authorized generation 2 after AWS runner public-key correction'
  ),
  trigger_run_id text not null check (trigger_run_id ~ '^run_[A-Za-z0-9]{8,80}$'),
  authorization_reason text not null check (
    authorization_reason = 'verified_runner_trust_correction_after_generation_one_cache_signature_failure'
  ),
  authorized_at timestamptz not null default now(),
  constraint fix_verification_recovery_generation_two_once unique (fix_run_id, stage),
  constraint fix_verification_recovery_generation_two_run_scope_fkey
    foreign key (fix_run_id, workspace_id) references public.fix_runs(id, workspace_id) on delete restrict,
  constraint fix_verification_recovery_generation_two_stage_scope_fkey
    foreign key (stage_id, fix_run_id, workspace_id)
    references public.fix_stage_queue(id, fix_run_id, workspace_id) on delete restrict,
  constraint fix_verification_recovery_generation_two_plan_scope_fkey
    foreign key (plan_id, fix_run_id) references public.fix_plans(id, fix_run_id) on delete restrict,
  constraint fix_verification_recovery_generation_two_patch_scope_fkey
    foreign key (patch_id, fix_run_id) references public.fix_patches(id, fix_run_id) on delete restrict
);

alter table public.fix_verification_recovery_generation_two_authorizations enable row level security;
revoke all on public.fix_verification_recovery_generation_two_authorizations from public, anon, authenticated, service_role;
grant select on public.fix_verification_recovery_generation_two_authorizations to service_role;

create trigger fix_verification_recovery_generation_two_authorizations_immutable
  before update or delete on public.fix_verification_recovery_generation_two_authorizations
  for each row execute function private.reject_fix_stage_recovery_mutation();

create function public.authorize_internal_fix_verification_recovery_generation_two(
  p_fix_run_id uuid,
  p_authorization_reference text,
  p_trigger_run_id text,
  p_cache_identity_key text,
  p_cache_manifest_fingerprint text,
  p_cache_archive_sha256 text,
  p_cache_tree_sha256 text
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
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_fix_run_id is distinct from '7de04a75-aefa-43a6-ba64-9fa4a70e0ec1'::uuid
    or p_authorization_reference is distinct from
      'M15.78R user-authorized generation 2 after AWS runner public-key correction'
    or p_trigger_run_id is null or p_trigger_run_id !~ '^run_[A-Za-z0-9]{8,80}$'
    or p_cache_identity_key is distinct from '86ab5d3a45b9e1a5218418e7856cb48b1c8fadf242c0b5ffb18ffb517463832c'
    or p_cache_manifest_fingerprint is null or p_cache_manifest_fingerprint !~ '^[a-f0-9]{64}$'
    or p_cache_archive_sha256 is null or p_cache_archive_sha256 !~ '^[a-f0-9]{64}$'
    or p_cache_tree_sha256 is null or p_cache_tree_sha256 !~ '^[a-f0-9]{64}$' then
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
  if not found
    or v_generation_one.patch_attempt_number <> 2
    or v_generation_one.patch_id <> 'c258f201-854e-4469-8bf7-7f4d2805a1e5'::uuid
    or v_generation_one.patch_fingerprint <> 'c7e9cfc34baa27a69cbd724877bb549a21e8188fcd29cc5b3399fb5cac2b3ece'
    or v_generation_one.cache_identity_key <> p_cache_identity_key
    or v_generation_one.cache_manifest_fingerprint <> p_cache_manifest_fingerprint
    or v_generation_one.cache_archive_sha256 <> p_cache_archive_sha256
    or v_generation_one.cache_tree_sha256 <> p_cache_tree_sha256 then
    raise exception 'internal_fix_verification_recovery_generation_one_invalid' using errcode = '42501';
  end if;

  select * into v_generation_two from public.fix_verification_recovery_generation_two_authorizations a
  where a.fix_run_id = v_run.id and a.stage_id = v_stage.id and a.stage = 'verify_patch';
  if found then
    if v_generation_two.generation_one_authorization_id <> v_generation_one.id
      or v_generation_two.cache_identity_key <> p_cache_identity_key
      or v_generation_two.cache_manifest_fingerprint <> p_cache_manifest_fingerprint
      or v_generation_two.cache_archive_sha256 <> p_cache_archive_sha256
      or v_generation_two.cache_tree_sha256 <> p_cache_tree_sha256 then
      raise exception 'internal_fix_verification_recovery_generation_two_conflict' using errcode = '42501';
    end if;
    return jsonb_build_object('status', 'already_authorized', 'fixRunId', v_run.id,
      'stageId', v_stage.id, 'recoveryId', v_generation_two.id, 'recoveryGeneration', 2);
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
    or v_run.preflight_required is distinct from false
    or v_run.status <> 'validation_failed' or v_run.current_stage <> 'verify_patch'
    or v_run.failure_category is distinct from 'cache_signature_invalid'
    or v_stage.status <> 'failed' or v_stage.attempt_count <> 2 or v_stage.operator_retry_count <> 1
    or v_stage.failure_category is distinct from 'cache_signature_invalid'
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

  insert into public.fix_verification_recovery_generation_two_authorizations (
    fix_run_id, workspace_id, stage_id, generation_one_authorization_id,
    identity_fingerprint, source_change_id, graph_build_id, analysis_run_id,
    product_id, repository_id, commit_sha, evidence_fingerprint, plan_id,
    plan_fingerprint, patch_id, patch_fingerprint, patch_attempt_number,
    cache_identity_key, cache_manifest_fingerprint, cache_archive_sha256, cache_tree_sha256,
    prior_run_status, prior_run_failure_category, prior_stage_status,
    prior_stage_failure_category, prior_attempt_count, prior_operator_retry_count,
    prior_patch_status, authorization_actor, authorization_reference, trigger_run_id,
    authorization_reason
  ) values (
    v_run.id, v_run.workspace_id, v_stage.id, v_generation_one.id,
    v_run.identity_fingerprint, v_run.source_change_id, v_run.graph_build_id, v_run.analysis_run_id,
    v_run.product_id, v_run.repository_id, v_run.commit_sha, v_run.evidence_fingerprint, v_plan.id,
    v_plan.plan_fingerprint, v_patch.id, v_patch.patch_fingerprint, v_patch.attempt_number,
    p_cache_identity_key, p_cache_manifest_fingerprint, p_cache_archive_sha256, p_cache_tree_sha256,
    v_run.status, v_run.failure_category, v_stage.status, v_stage.failure_category,
    v_stage.attempt_count, v_stage.operator_retry_count, v_patch.status, 'codex_operator',
    p_authorization_reference, p_trigger_run_id,
    'verified_runner_trust_correction_after_generation_one_cache_signature_failure'
  ) returning * into v_generation_two;

  update public.fix_stage_queue q set status = 'queued', operator_retry_count = 2,
    claim_token = null, lease_expires_at = null, failure_category = null, completed_at = null
  where q.id = v_stage.id and q.status = 'failed' and q.attempt_count = 2
    and q.operator_retry_count = 1 and q.failure_category = 'cache_signature_invalid';
  if not found then
    raise exception 'internal_fix_verification_recovery_stage_race' using errcode = '40001';
  end if;
  update public.fix_runs r set status = 'queued', failure_category = null, completed_at = null,
    updated_at = now()
  where r.id = v_run.id and r.workspace_id = v_run.workspace_id
    and r.status = 'validation_failed' and r.current_stage = 'verify_patch'
    and r.failure_category = 'cache_signature_invalid';
  if not found then
    raise exception 'internal_fix_verification_recovery_run_race' using errcode = '40001';
  end if;

  return jsonb_build_object('status', 'retry_queued', 'fixRunId', v_run.id,
    'stageId', v_stage.id, 'recoveryId', v_generation_two.id, 'recoveryGeneration', 2);
end;
$$;

revoke all on function public.authorize_internal_fix_verification_recovery_generation_two(uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.authorize_internal_fix_verification_recovery_generation_two(uuid, text, text, text, text, text, text)
  to service_role;
