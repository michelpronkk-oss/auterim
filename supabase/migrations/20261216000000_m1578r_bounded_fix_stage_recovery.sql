-- M15.78R: preserve a one-time, operator-authorized fourth diagnosis attempt
-- after the original three attempts are exhausted. The existing rows remain
-- historical evidence; this authorization is append-only and scope-pinned.

alter table public.fix_model_attempts
  drop constraint if exists fix_model_attempts_attempt_number_check;
alter table public.fix_model_attempts
  add constraint fix_model_attempts_attempt_number_check
  check (attempt_number between 1 and 4);
alter table public.fix_model_attempts
  add constraint fix_model_attempt_recovery_identity
  unique (id, fix_run_id, workspace_id, stage, attempt_number);

alter table public.fix_stage_queue
  drop constraint if exists fix_stage_queue_attempt_count_check;
alter table public.fix_stage_queue
  add constraint fix_stage_queue_attempt_count_check
  check (attempt_count between 0 and 4);
alter table public.fix_stage_queue
  add constraint fix_stage_recovery_identity
  unique (id, fix_run_id, workspace_id);

create table public.fix_stage_recovery_authorizations (
  id uuid primary key default gen_random_uuid(),
  fix_run_id uuid not null,
  workspace_id uuid not null,
  stage_id uuid not null,
  stage text not null default 'diagnose' check (stage = 'diagnose'),
  recovery_generation smallint not null default 1 check (recovery_generation = 1),
  identity_fingerprint text not null check (identity_fingerprint ~ '^[a-f0-9]{64}$'),
  source_change_id uuid not null,
  graph_build_id uuid not null,
  analysis_run_id uuid not null,
  product_id uuid not null,
  repository_id uuid not null,
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{40,64}$'),
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[a-f0-9]{64}$'),
  prior_run_status text not null check (prior_run_status = 'diagnosis_failed'),
  prior_run_failure_category text not null check (prior_run_failure_category in (
    'fix_stage_failed', 'fix_diagnosis_schema_invalid', 'diagnosis_identity_mismatch',
    'diagnosis_invented_evidence', 'diagnosis_evidence_provenance_mismatch'
  )),
  prior_stage_status text not null check (prior_stage_status = 'failed'),
  prior_stage_failure_category text not null check (prior_stage_failure_category in (
    'fix_stage_failed', 'fix_diagnosis_schema_invalid', 'diagnosis_identity_mismatch',
    'diagnosis_invented_evidence', 'diagnosis_evidence_provenance_mismatch'
  )),
  prior_attempt_count integer not null check (prior_attempt_count = 3),
  prior_operator_retry_count integer not null check (prior_operator_retry_count = 2),
  prior_model_attempt_id uuid not null,
  prior_model_output_fingerprint text not null check (prior_model_output_fingerprint ~ '^[a-f0-9]{64}$'),
  authorization_actor text not null check (authorization_actor = 'codex_operator'),
  authorization_reference text not null check (authorization_reference = 'M15.78R user-authorized single post-model recovery'),
  trigger_run_id text not null check (trigger_run_id ~ '^run_[A-Za-z0-9]{8,80}$'),
  authorization_reason text not null check (authorization_reason = 'diagnosis_contract_observability_repair'),
  authorized_at timestamptz not null default now(),
  constraint fix_stage_recovery_once unique (fix_run_id, stage),
  constraint fix_stage_recovery_run_scope_fkey
    foreign key (fix_run_id, workspace_id) references public.fix_runs(id, workspace_id) on delete restrict,
  constraint fix_stage_recovery_stage_scope_fkey
    foreign key (stage_id, fix_run_id, workspace_id)
    references public.fix_stage_queue(id, fix_run_id, workspace_id) on delete restrict,
  constraint fix_stage_recovery_model_attempt_fkey
    foreign key (prior_model_attempt_id, fix_run_id, workspace_id, stage, prior_attempt_count)
    references public.fix_model_attempts(id, fix_run_id, workspace_id, stage, attempt_number) on delete restrict
);

alter table public.fix_stage_recovery_authorizations enable row level security;
revoke all on public.fix_stage_recovery_authorizations from public, anon, authenticated;
grant select on public.fix_stage_recovery_authorizations to service_role;

create function private.reject_fix_stage_recovery_mutation()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'fix_stage_recovery_authorization_immutable' using errcode = '23514';
end;
$$;
revoke all on function private.reject_fix_stage_recovery_mutation() from public, anon, authenticated;
create trigger fix_stage_recovery_authorizations_immutable
  before update or delete on public.fix_stage_recovery_authorizations
  for each row execute function private.reject_fix_stage_recovery_mutation();

create function public.authorize_internal_fix_diagnosis_recovery(
  p_fix_run_id uuid,
  p_authorization_reference text,
  p_trigger_run_id text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.fix_runs%rowtype;
  v_stage public.fix_stage_queue%rowtype;
  v_attempt public.fix_model_attempts%rowtype;
  v_authorization public.fix_stage_recovery_authorizations%rowtype;
  v_failed_attempts integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_fix_run_id is null
    or p_authorization_reference is distinct from 'M15.78R user-authorized single post-model recovery'
    or p_trigger_run_id is null or p_trigger_run_id !~ '^run_[A-Za-z0-9]{8,80}$' then
    raise exception 'internal_fix_diagnosis_recovery_request_invalid' using errcode = '22023';
  end if;

  select * into v_run
  from public.fix_runs r
  where r.id = p_fix_run_id
  for update;
  if not found then
    raise exception 'internal_fix_diagnosis_recovery_run_not_found' using errcode = 'P0002';
  end if;

  select * into v_stage
  from public.fix_stage_queue q
  where q.fix_run_id = v_run.id and q.workspace_id = v_run.workspace_id and q.stage = 'diagnose'
  for update;
  if not found then
    raise exception 'internal_fix_diagnosis_recovery_stage_not_found' using errcode = 'P0002';
  end if;

  select * into v_authorization
  from public.fix_stage_recovery_authorizations a
  where a.fix_run_id = v_run.id and a.stage_id = v_stage.id and a.stage = 'diagnose';
  if found then
    return jsonb_build_object(
      'status', 'already_authorized',
      'fixRunId', v_run.id,
      'stageId', v_stage.id,
      'recoveryId', v_authorization.id,
      'recoveryGeneration', v_authorization.recovery_generation
    );
  end if;

  if v_run.workspace_id <> 'e140d48e-9dc0-4552-a9a4-a81fe3872422'::uuid
    or v_run.product_id <> 'de1f2a12-de3c-4644-8892-b6c2d458a300'::uuid
    or v_run.repository_id <> 'b2abf377-2dbc-4b9c-b546-b0604f3ee4fe'::uuid
    or v_run.product_repository_mapping_id <> 'ed0fa73d-3dd2-46b4-a8bd-a603919e01a0'::uuid
    or v_run.workspace_dependency_id <> '867eb92b-2ed2-4917-ac68-44a22773e369'::uuid
    or lower(v_run.provider_repository_identity) <> 'michelpronkk-oss/auterim-m15-github-qa'
    or v_run.source_mode <> 'internal_test'
    or v_run.processing_mode <> 'evidence_only'
    or v_run.provenance_mode <> 'evidence_only'
    or v_run.semantic_route <> 'deprecation'
    or v_run.route_target <> 'dependency_product_impact'
    or v_run.review_disposition <> 'review_required'
    or v_run.review_reason is distinct from 'critical_change'
    or v_run.status <> 'diagnosis_failed'
    or v_run.current_stage <> 'diagnose'
    or coalesce(v_run.failure_category, '') not in ('fix_stage_failed', 'fix_diagnosis_schema_invalid',
      'diagnosis_identity_mismatch', 'diagnosis_invented_evidence', 'diagnosis_evidence_provenance_mismatch')
    or v_stage.status <> 'failed'
    or v_stage.attempt_count <> 3
    or v_stage.operator_retry_count <> 2
    or coalesce(v_stage.failure_category, '') not in ('fix_stage_failed', 'fix_diagnosis_schema_invalid',
      'diagnosis_identity_mismatch', 'diagnosis_invented_evidence', 'diagnosis_evidence_provenance_mismatch')
    or exists (select 1 from public.fix_diagnoses d where d.fix_run_id = v_run.id)
    or exists (select 1 from public.fix_plans p where p.fix_run_id = v_run.id)
    or exists (select 1 from public.fix_patches p where p.fix_run_id = v_run.id)
    or not exists (
      select 1 from public.source_changes s
      where s.id = v_run.source_change_id
        and s.workspace_id = v_run.workspace_id
        and s.scope_product_id = v_run.product_id
        and s.source_mode = 'internal_test'
        and s.processing_mode = 'evidence_only'
    )
    or not exists (
      select 1 from public.workspace_products p
      where p.id = v_run.product_id and p.workspace_id = v_run.workspace_id and p.status = 'protected'
    )
    or not exists (
      select 1 from public.repositories r
      where r.id = v_run.repository_id and r.workspace_id = v_run.workspace_id
        and lower(r.owner || '/' || r.name) = lower(v_run.provider_repository_identity)
        and r.status = 'available' and not r.archived
    )
    or not exists (
      select 1 from public.workspace_product_repositories m
      where m.id = v_run.product_repository_mapping_id and m.workspace_id = v_run.workspace_id
        and m.protected_product_id = v_run.product_id and m.repository_id = v_run.repository_id and m.status = 'active'
    )
    or not exists (
      select 1 from public.workspace_dependencies d
      where d.id = v_run.workspace_dependency_id and d.workspace_id = v_run.workspace_id
        and d.protected_product_id = v_run.product_id and d.monitoring_enabled
    ) then
    raise exception 'internal_fix_diagnosis_recovery_scope_invalid' using errcode = '42501';
  end if;

  select * into v_attempt
  from public.fix_model_attempts a
  where a.fix_run_id = v_run.id and a.workspace_id = v_run.workspace_id
    and a.stage = 'diagnose' and a.attempt_number = 3
  for update;
  if not found
    or v_attempt.provider is distinct from 'azure-openai'
    or v_attempt.model is distinct from 'gpt-6.1-sol'
    or v_attempt.status is distinct from 'succeeded'
    or v_attempt.output_fingerprint is null then
    raise exception 'internal_fix_diagnosis_recovery_attempt_invalid' using errcode = '42501';
  end if;

  select count(*) into v_failed_attempts
  from public.fix_model_attempts a
  where a.fix_run_id = v_run.id and a.workspace_id = v_run.workspace_id
    and a.stage = 'diagnose' and a.attempt_number in (1, 2)
    and a.provider = 'azure-openai' and a.model = 'gpt-6.1-sol'
    and a.status = 'failed'
    and ((a.attempt_number = 1 and a.failure_category in ('fix_model_provider_rejected', 'fix_model_provider_rejected_401'))
      or (a.attempt_number = 2 and a.failure_category = 'fix_model_provider_rejected_400'));
  if v_failed_attempts <> 2 then
    raise exception 'internal_fix_diagnosis_recovery_history_invalid' using errcode = '42501';
  end if;

  insert into public.fix_stage_recovery_authorizations (
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
    v_attempt.id, v_attempt.output_fingerprint, 'codex_operator',
    p_authorization_reference, p_trigger_run_id, 'diagnosis_contract_observability_repair'
  ) returning * into v_authorization;

  update public.fix_stage_queue q
  set status = 'queued', claim_token = null, lease_expires_at = null,
      failure_category = null, completed_at = null
  where q.id = v_stage.id and q.status = 'failed' and q.attempt_count = 3
    and q.operator_retry_count = 2;
  if not found then
    raise exception 'internal_fix_diagnosis_recovery_stage_race' using errcode = '40001';
  end if;

  update public.fix_runs r
  set status = 'queued', failure_category = null, completed_at = null, updated_at = now()
  where r.id = v_run.id and r.workspace_id = v_run.workspace_id and r.status = 'diagnosis_failed';
  if not found then
    raise exception 'internal_fix_diagnosis_recovery_run_race' using errcode = '40001';
  end if;

  return jsonb_build_object(
    'status', 'retry_queued',
    'fixRunId', v_run.id,
    'stageId', v_stage.id,
    'recoveryId', v_authorization.id,
    'recoveryGeneration', v_authorization.recovery_generation
  );
end;
$$;
revoke all on function public.authorize_internal_fix_diagnosis_recovery(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.authorize_internal_fix_diagnosis_recovery(uuid, text, text)
  to service_role;

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
    and (x.attempt_count < 3 or (x.stage = 'diagnose' and x.attempt_count = 3 and exists (
      select 1 from public.fix_stage_recovery_authorizations a
      where a.fix_run_id = x.fix_run_id and a.workspace_id = x.workspace_id and a.stage_id = x.id
        and a.stage = 'diagnose' and a.recovery_generation = 1
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
    'recoveryGeneration', case when q.stage = 'diagnose' and q.attempt_count = 4 then 1 else 0 end);
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
    where ((q.status = 'queued' and (q.attempt_count < 3 or (q.stage = 'diagnose' and q.attempt_count = 3 and exists (
        select 1 from public.fix_stage_recovery_authorizations a
        where a.fix_run_id = q.fix_run_id and a.workspace_id = q.workspace_id and a.stage_id = q.id
          and a.stage = 'diagnose' and a.recovery_generation = 1
      )))) or (q.status = 'claimed' and q.lease_expires_at < now()))
    order by q.created_at, q.id limit p_limit;
end;
$$;
revoke all on function public.list_fix_stage_work(integer) from public, anon, authenticated;
grant execute on function public.list_fix_stage_work(integer) to service_role;

create or replace function public.begin_fix_model_attempt(
  p_stage_id uuid, p_claim_token uuid, p_attempt_number integer, p_provider text, p_model text,
  p_schema_version text, p_prompt_contract_version text, p_input_fingerprint text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare q public.fix_stage_queue%rowtype; r public.fix_runs%rowtype; v_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_provider is null or p_provider !~ '^[a-zA-Z0-9._:-]{1,80}$' or p_model is null or char_length(p_model) not between 1 and 160
    or p_schema_version is null or char_length(p_schema_version) not between 1 and 80
    or p_prompt_contract_version is null or char_length(p_prompt_contract_version) not between 1 and 80
    or p_input_fingerprint is null or p_input_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid_fix_model_attempt' using errcode = '22023';
  end if;
  select * into q from public.fix_stage_queue x where x.id = p_stage_id and x.status = 'claimed'
    and x.claim_token = p_claim_token and x.lease_expires_at > now() for update;
  if not found or q.stage not in ('diagnose', 'plan', 'generate_patch')
    or q.attempt_count not between 1 and 4 or p_attempt_number <> q.attempt_count
    or (q.attempt_count = 4 and (q.stage <> 'diagnose' or not exists (
      select 1 from public.fix_stage_recovery_authorizations a
      where a.fix_run_id = q.fix_run_id and a.workspace_id = q.workspace_id and a.stage_id = q.id
        and a.stage = 'diagnose' and a.recovery_generation = 1
    ))) then
    raise exception 'fix_model_attempt_stage_invalid' using errcode = '42501';
  end if;
  select * into r from public.fix_runs x where x.id = q.fix_run_id and x.workspace_id = q.workspace_id;
  if not found then raise exception 'fix_run_not_found' using errcode = 'P0002'; end if;
  update public.fix_model_attempts set status = 'ambiguous', failure_category = 'previous_model_attempt_interrupted', completed_at = now()
    where fix_run_id = r.id and stage = q.stage and attempt_number < q.attempt_count and status = 'started';
  insert into public.fix_model_attempts(fix_run_id, workspace_id, stage, attempt_number, provider, model, schema_version,
    prompt_contract_version, status, input_fingerprint)
    values(r.id, r.workspace_id, q.stage, q.attempt_count, p_provider, p_model, p_schema_version,
      p_prompt_contract_version, 'started', p_input_fingerprint)
    on conflict(fix_run_id, stage, attempt_number) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from public.fix_model_attempts where fix_run_id = r.id and stage = q.stage
      and attempt_number = q.attempt_count and input_fingerprint = p_input_fingerprint
      and provider = p_provider and model = p_model and status = 'started';
    if v_id is null then raise exception 'fix_model_attempt_replay_conflict' using errcode = '23505'; end if;
  end if;
  return jsonb_build_object('attemptId', v_id, 'attemptNumber', q.attempt_count);
end;
$$;
revoke all on function public.begin_fix_model_attempt(uuid, uuid, integer, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.begin_fix_model_attempt(uuid, uuid, integer, text, text, text, text, text)
  to service_role;
