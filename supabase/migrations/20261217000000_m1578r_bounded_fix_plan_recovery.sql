-- One bounded recovery for the provider-success / deterministic Plan contract
-- failure in the fixed M15.78R internal Test acceptance. The failed attempt
-- remains immutable; this authorization permits one next attempt only.

create table public.fix_plan_recovery_authorizations (
  id uuid primary key default gen_random_uuid(),
  fix_run_id uuid not null,
  workspace_id uuid not null,
  stage_id uuid not null,
  stage text not null default 'plan' check (stage = 'plan'),
  recovery_generation smallint not null default 1 check (recovery_generation = 1),
  identity_fingerprint text not null check (identity_fingerprint ~ '^[a-f0-9]{64}$'),
  source_change_id uuid not null,
  graph_build_id uuid not null,
  analysis_run_id uuid not null,
  product_id uuid not null,
  repository_id uuid not null,
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{40,64}$'),
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[a-f0-9]{64}$'),
  prior_run_status text not null check (prior_run_status = 'plan_failed'),
  prior_run_failure_category text not null check (prior_run_failure_category = 'fix_plan_schema_invalid'),
  prior_stage_status text not null check (prior_stage_status = 'failed'),
  prior_stage_failure_category text not null check (prior_stage_failure_category = 'fix_plan_schema_invalid'),
  prior_attempt_count integer not null check (prior_attempt_count = 1),
  prior_operator_retry_count integer not null check (prior_operator_retry_count = 0),
  prior_model_attempt_id uuid not null,
  prior_model_output_fingerprint text not null check (prior_model_output_fingerprint ~ '^[a-f0-9]{64}$'),
  authorization_actor text not null check (authorization_actor = 'codex_operator'),
  authorization_reference text not null check (authorization_reference = 'M15.78R user-authorized single bounded plan recovery'),
  trigger_run_id text not null check (trigger_run_id ~ '^run_[A-Za-z0-9]{8,80}$'),
  authorization_reason text not null check (authorization_reason = 'plan_contract_schema_prompt_repair'),
  authorized_at timestamptz not null default now(),
  constraint fix_plan_recovery_once unique (fix_run_id, stage),
  constraint fix_plan_recovery_run_scope_fkey
    foreign key (fix_run_id, workspace_id) references public.fix_runs(id, workspace_id) on delete restrict,
  constraint fix_plan_recovery_stage_scope_fkey
    foreign key (stage_id, fix_run_id, workspace_id)
    references public.fix_stage_queue(id, fix_run_id, workspace_id) on delete restrict,
  constraint fix_plan_recovery_attempt_fkey
    foreign key (prior_model_attempt_id, fix_run_id, workspace_id, stage, prior_attempt_count)
    references public.fix_model_attempts(id, fix_run_id, workspace_id, stage, attempt_number) on delete restrict
);

alter table public.fix_plan_recovery_authorizations enable row level security;
revoke all on public.fix_plan_recovery_authorizations from public, anon, authenticated, service_role;
grant select on public.fix_plan_recovery_authorizations to service_role;

create trigger fix_plan_recovery_authorizations_immutable
  before update or delete on public.fix_plan_recovery_authorizations
  for each row execute function private.reject_fix_stage_recovery_mutation();

create function public.authorize_internal_fix_plan_contract_recovery(
  p_fix_run_id uuid,
  p_authorization_reference text,
  p_trigger_run_id text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.fix_runs%rowtype;
  v_stage public.fix_stage_queue%rowtype;
  v_attempt public.fix_model_attempts%rowtype;
  v_diagnosis public.fix_diagnoses%rowtype;
  v_authorization public.fix_plan_recovery_authorizations%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_fix_run_id is distinct from '7de04a75-aefa-43a6-ba64-9fa4a70e0ec1'::uuid
    or p_authorization_reference is distinct from 'M15.78R user-authorized single bounded plan recovery'
    or p_trigger_run_id is null or p_trigger_run_id !~ '^run_[A-Za-z0-9]{8,80}$' then
    raise exception 'internal_fix_plan_recovery_request_invalid' using errcode = '22023';
  end if;

  select * into v_run from public.fix_runs r where r.id = p_fix_run_id for update;
  if not found then raise exception 'internal_fix_plan_recovery_run_not_found' using errcode = 'P0002'; end if;
  select * into v_stage from public.fix_stage_queue q
    where q.fix_run_id = v_run.id and q.workspace_id = v_run.workspace_id and q.id = '64455e32-f8c7-4f96-a26b-f1cbb04e1a6e'::uuid
      and q.stage = 'plan' for update;
  if not found then raise exception 'internal_fix_plan_recovery_stage_not_found' using errcode = 'P0002'; end if;

  select * into v_authorization from public.fix_plan_recovery_authorizations a
    where a.fix_run_id = v_run.id and a.stage_id = v_stage.id and a.stage = 'plan';
  if found then
    return jsonb_build_object('status', 'already_authorized', 'fixRunId', v_run.id,
      'stageId', v_stage.id, 'recoveryId', v_authorization.id,
      'recoveryGeneration', v_authorization.recovery_generation);
  end if;

  if v_run.workspace_id <> 'e140d48e-9dc0-4552-a9a4-a81fe3872422'::uuid
    or v_run.product_id <> 'de1f2a12-de3c-4644-8892-b6c2d458a300'::uuid
    or v_run.repository_id <> 'b2abf377-2dbc-4b9c-b546-b0604f3ee4fe'::uuid
    or v_run.product_repository_mapping_id <> 'ed0fa73d-3dd2-46b4-a8bd-a603919e01a0'::uuid
    or v_run.workspace_dependency_id <> '867eb92b-2ed2-4917-ac68-44a22773e369'::uuid
    or lower(v_run.provider_repository_identity) <> 'michelpronkk-oss/auterim-m15-github-qa'
    or v_run.source_change_id <> 'b5311d8d-28a9-4de7-80f0-056f16c168e7'::uuid
    or v_run.analysis_run_id <> '6f64060d-1dd7-4b10-ac3d-4db4f8ad58a6'::uuid
    or v_run.graph_build_id <> 'd104070c-ea38-44d6-b1bf-56d8b18d4248'::uuid
    or v_run.commit_sha <> '94135df6f85bfb34ac83c046e5541e1ad8d73a86'
    or v_run.source_mode <> 'internal_test'
    or v_run.processing_mode <> 'evidence_only'
    or v_run.provenance_mode <> 'evidence_only'
    or v_run.semantic_route <> 'deprecation'
    or v_run.route_target <> 'dependency_product_impact'
    or v_run.review_disposition <> 'review_required'
    or v_run.review_reason is distinct from 'critical_change'
    or v_run.preflight_required is distinct from false
    or v_run.status <> 'plan_failed'
    or v_run.current_stage <> 'plan'
    or v_run.failure_category is distinct from 'fix_plan_schema_invalid'
    or v_stage.status <> 'failed'
    or v_stage.attempt_count <> 1
    or v_stage.operator_retry_count <> 0
    or v_stage.failure_category is distinct from 'fix_plan_schema_invalid'
    or exists (select 1 from public.fix_plans p where p.fix_run_id = v_run.id)
    or exists (select 1 from public.fix_patches p where p.fix_run_id = v_run.id)
    or exists (select 1 from public.fix_verification_runs x where x.fix_run_id = v_run.id)
    or exists (select 1 from public.fix_external_operations x where x.fix_run_id = v_run.id)
    or exists (select 1 from public.fix_pr_outcomes x where x.fix_run_id = v_run.id)
    or not exists (
      select 1 from public.source_changes s where s.id = v_run.source_change_id
        and s.workspace_id = v_run.workspace_id and s.scope_product_id = v_run.product_id
        and s.source_mode = 'internal_test' and s.processing_mode = 'evidence_only'
    )
    or not exists (
      select 1 from public.workspace_products p where p.id = v_run.product_id
        and p.workspace_id = v_run.workspace_id and p.status = 'protected'
    )
    or not exists (
      select 1 from public.repositories r where r.id = v_run.repository_id and r.workspace_id = v_run.workspace_id
        and lower(r.owner || '/' || r.name) = lower(v_run.provider_repository_identity)
        and r.status = 'available' and not r.archived
    )
    or not exists (
      select 1 from public.workspace_product_repositories m where m.id = v_run.product_repository_mapping_id
        and m.workspace_id = v_run.workspace_id and m.protected_product_id = v_run.product_id
        and m.repository_id = v_run.repository_id and m.status = 'active'
    )
    or not exists (
      select 1 from public.workspace_dependencies d where d.id = v_run.workspace_dependency_id
        and d.workspace_id = v_run.workspace_id and d.protected_product_id = v_run.product_id and d.monitoring_enabled
    ) then
    raise exception 'internal_fix_plan_recovery_scope_invalid' using errcode = '42501';
  end if;

  select * into v_diagnosis from public.fix_diagnoses d
    where d.id = 'be3f7337-55ed-4e0f-8fed-63b69d81c069'::uuid
      and d.fix_run_id = v_run.id and d.workspace_id = v_run.workspace_id
      and d.graph_build_id = v_run.graph_build_id and d.analysis_run_id = v_run.analysis_run_id
      and d.repository_id = v_run.repository_id and d.commit_sha = v_run.commit_sha for update;
  if not found or v_diagnosis.output_fingerprint is distinct from '9152f9b4d2aab67c273752cf214c24cc3d2619be927b2866b0d994e23024959e'
    or cardinality(v_diagnosis.evidence_ids) = 0 then
    raise exception 'internal_fix_plan_recovery_diagnosis_invalid' using errcode = '42501';
  end if;

  select * into v_attempt from public.fix_model_attempts a
    where a.id = '15021f71-0fc0-4377-bf53-837382e27144'::uuid
      and a.fix_run_id = v_run.id and a.workspace_id = v_run.workspace_id
      and a.stage = 'plan' and a.attempt_number = 1 for update;
  if not found or v_attempt.provider is distinct from 'azure-openai'
    or v_attempt.model is distinct from 'gpt-6.1-sol'
    or v_attempt.status is distinct from 'succeeded'
    or v_attempt.prompt_contract_version is distinct from 'fix-coding-contract-v2'
    or v_attempt.output_fingerprint is distinct from '7a745136ce08ef58e79f28b770b089e77b6296d2b9e6cb1710f7894f5b7e0098' then
    raise exception 'internal_fix_plan_recovery_attempt_invalid' using errcode = '42501';
  end if;

  insert into public.fix_plan_recovery_authorizations (
    fix_run_id, workspace_id, stage_id, identity_fingerprint, source_change_id,
    graph_build_id, analysis_run_id, product_id, repository_id, commit_sha,
    evidence_fingerprint, prior_run_status, prior_run_failure_category,
    prior_stage_status, prior_stage_failure_category, prior_attempt_count,
    prior_operator_retry_count, prior_model_attempt_id, prior_model_output_fingerprint,
    authorization_actor, authorization_reference, trigger_run_id, authorization_reason
  ) values (
    v_run.id, v_run.workspace_id, v_stage.id, v_run.identity_fingerprint, v_run.source_change_id,
    v_run.graph_build_id, v_run.analysis_run_id, v_run.product_id, v_run.repository_id,
    v_run.commit_sha, v_run.evidence_fingerprint, v_run.status, v_run.failure_category,
    v_stage.status, v_stage.failure_category, v_stage.attempt_count, v_stage.operator_retry_count,
    v_attempt.id, v_attempt.output_fingerprint, 'codex_operator', p_authorization_reference,
    p_trigger_run_id, 'plan_contract_schema_prompt_repair'
  ) returning * into v_authorization;

  update public.fix_stage_queue q set status = 'queued', claim_token = null, lease_expires_at = null,
    failure_category = null, completed_at = null
    where q.id = v_stage.id and q.status = 'failed' and q.attempt_count = 1 and q.operator_retry_count = 0;
  if not found then raise exception 'internal_fix_plan_recovery_stage_race' using errcode = '40001'; end if;
  update public.fix_runs r set status = 'queued', failure_category = null, completed_at = null, updated_at = now()
    where r.id = v_run.id and r.workspace_id = v_run.workspace_id and r.status = 'plan_failed'
      and r.current_stage = 'plan' and r.failure_category = 'fix_plan_schema_invalid';
  if not found then raise exception 'internal_fix_plan_recovery_run_race' using errcode = '40001'; end if;

  return jsonb_build_object('status', 'retry_queued', 'fixRunId', v_run.id,
    'stageId', v_stage.id, 'recoveryId', v_authorization.id,
    'recoveryGeneration', v_authorization.recovery_generation);
end;
$$;
revoke all on function public.authorize_internal_fix_plan_contract_recovery(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.authorize_internal_fix_plan_contract_recovery(uuid, text, text)
  to service_role;
