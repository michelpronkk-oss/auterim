-- One operator-authorized recovery for a rejected Azure coding-model diagnosis
-- on an internal Test/evidence-only run. Customer runs and external actions are
-- never made retryable by this transition.

alter table public.fix_stage_queue
  add column operator_retry_count integer not null default 0
  check (operator_retry_count between 0 and 1);

create function public.requeue_internal_fix_diagnosis_after_model_auth_repair(p_fix_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.fix_runs%rowtype;
  v_stage public.fix_stage_queue%rowtype;
  v_attempt_count integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;
  if p_fix_run_id is null then
    raise exception 'invalid_fix_run_id' using errcode='22023';
  end if;

  select * into v_run
  from public.fix_runs r
  where r.id=p_fix_run_id
    and r.workspace_id='e140d48e-9dc0-4552-a9a4-a81fe3872422'::uuid
  for update;
  if not found then
    raise exception 'internal_fix_run_not_found' using errcode='P0002';
  end if;

  select * into v_stage
  from public.fix_stage_queue q
  where q.fix_run_id=v_run.id and q.workspace_id=v_run.workspace_id and q.stage='diagnose'
  for update;
  if not found then
    raise exception 'internal_fix_diagnosis_stage_not_found' using errcode='P0002';
  end if;

  if v_stage.operator_retry_count=1 then
    return jsonb_build_object(
      'status','already_used',
      'fixRunId',v_run.id,
      'stageId',v_stage.id,
      'retryGeneration',1
    );
  end if;

  if v_run.source_mode<>'internal_test'
    or v_run.processing_mode<>'evidence_only'
    or v_run.provenance_mode<>'evidence_only'
    or v_run.product_id<>'de1f2a12-de3c-4644-8892-b6c2d458a300'::uuid
    or v_run.status<>'diagnosis_failed'
    or v_run.current_stage<>'diagnose'
    or coalesce(v_run.failure_category,'') not in ('fix_model_provider_rejected','fix_model_provider_rejected_401')
    or v_stage.status<>'failed'
    or v_stage.attempt_count<>1
    or coalesce(v_stage.failure_category,'') not in ('fix_model_provider_rejected','fix_model_provider_rejected_401')
    or exists(select 1 from public.fix_diagnoses d where d.fix_run_id=v_run.id)
    or exists(select 1 from public.fix_plans p where p.fix_run_id=v_run.id)
    or exists(select 1 from public.fix_patches p where p.fix_run_id=v_run.id)
    or not exists(
      select 1 from public.source_changes s
      where s.id=v_run.source_change_id
        and s.workspace_id=v_run.workspace_id
        and s.scope_product_id=v_run.product_id
        and s.source_mode='internal_test'
        and s.processing_mode='evidence_only'
    ) then
    raise exception 'internal_fix_diagnosis_retry_ineligible' using errcode='42501';
  end if;

  select count(*) into v_attempt_count
  from public.fix_model_attempts a
  where a.fix_run_id=v_run.id
    and a.workspace_id=v_run.workspace_id
    and a.stage='diagnose'
    and a.attempt_number=1
    and a.provider='azure-openai'
    and a.model='gpt-6.1-sol'
    and a.status='failed'
    and a.failure_category in ('fix_model_provider_rejected','fix_model_provider_rejected_401');
  if v_attempt_count<>1 then
    raise exception 'internal_fix_model_attempt_not_retryable' using errcode='42501';
  end if;

  update public.fix_stage_queue q
  set status='queued',operator_retry_count=1,claim_token=null,lease_expires_at=null,
      failure_category=null,completed_at=null
  where q.id=v_stage.id and q.status='failed' and q.operator_retry_count=0;
  if not found then
    raise exception 'internal_fix_diagnosis_retry_race' using errcode='40001';
  end if;

  update public.fix_runs r
  set status='queued',failure_category=null,completed_at=null,updated_at=now()
  where r.id=v_run.id and r.workspace_id=v_run.workspace_id and r.status='diagnosis_failed';
  if not found then
    raise exception 'internal_fix_run_retry_race' using errcode='40001';
  end if;

  return jsonb_build_object(
    'status','retry_queued',
    'fixRunId',v_run.id,
    'stageId',v_stage.id,
    'retryGeneration',1
  );
end;
$$;

revoke all on function public.requeue_internal_fix_diagnosis_after_model_auth_repair(uuid)
  from public,anon,authenticated;
grant execute on function public.requeue_internal_fix_diagnosis_after_model_auth_repair(uuid)
  to service_role;
