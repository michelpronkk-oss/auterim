alter table public.code_analysis_runs
  add column cleanup_failure_category text
  check (cleanup_failure_category is null or cleanup_failure_category = 'cleanup_failed');

create or replace function public.clear_code_analysis_failure_stage_on_claim()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'running' and new.claim_token is distinct from old.claim_token then
    new.failure_stage := null;
    new.cleanup_failure_category := null;
  end if;
  return new;
end;
$$;

drop function public.fail_code_analysis_run(uuid,uuid,text,text,boolean);

create function public.fail_code_analysis_run(
  p_analysis_run_id uuid,
  p_claim_token uuid,
  p_failure_category text,
  p_failure_stage text,
  p_retryable boolean,
  p_cleanup_failure_category text
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_failure_category is null or p_failure_category !~ '^[a-z0-9_]{1,80}$' then
    raise exception 'Code analysis failure category is invalid' using errcode='22023';
  end if;
  if p_failure_stage is not null and p_failure_stage not in (
    'environment_validation',
    'github_provider_setup',
    'repository_materialization',
    'snapshot_collection',
    'static_analysis',
    'analysis_persistence'
  ) then
    raise exception 'Code analysis failure stage is invalid' using errcode='22023';
  end if;
  if p_cleanup_failure_category is not null and p_cleanup_failure_category <> 'cleanup_failed' then
    raise exception 'Code analysis cleanup category is invalid' using errcode='22023';
  end if;
  if p_failure_stage is null and (p_cleanup_failure_category is null or p_failure_category <> 'analysis_failed' or p_retryable) then
    raise exception 'Code analysis failure stage is required' using errcode='22023';
  end if;

  update public.code_analysis_runs set
    status = case when p_retryable and attempt_count < 8 then 'queued' else 'failed' end,
    coverage_state = case when p_retryable and attempt_count < 8 then 'partial' else 'failed' end,
    failure_category = p_failure_category,
    failure_stage = p_failure_stage,
    cleanup_failure_category = p_cleanup_failure_category,
    completed_at = case when p_retryable and attempt_count < 8 then null else now() end,
    claim_token = null,
    lease_expires_at = null
  where id = p_analysis_run_id and status = 'running' and claim_token = p_claim_token;
  if not found then return false; end if;

  if not p_retryable or not exists (
    select 1 from public.code_analysis_runs
    where id = p_analysis_run_id and status = 'queued'
  ) then
    update public.code_analysis_route_handoffs
    set status = 'failed'
    where analysis_run_id = p_analysis_run_id and status = 'queued';
  end if;
  return true;
end;
$$;

revoke all on function public.fail_code_analysis_run(uuid,uuid,text,text,boolean,text) from public, anon, authenticated;
grant execute on function public.fail_code_analysis_run(uuid,uuid,text,text,boolean,text) to service_role;