-- Fix retry identity and serialize the final workspace remediation quota slot.

create or replace function public.mark_preflight_dispatch(
  p_queue_id uuid,
  p_status text,
  p_error_category text default null
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  resulting_attempt integer;
  workspace_id uuid;
begin
  if p_status not in ('dispatched','complete','failed','superseded') then
    raise exception 'invalid_preflight_queue_status' using errcode='22023';
  end if;
  if p_status='dispatched' then
    select queue.workspace_id into workspace_id
    from public.preflight_dispatch_queue queue
    where queue.id=p_queue_id;
    if workspace_id is null then
      raise exception 'preflight_queue_not_found' using errcode='P0002';
    end if;
    if not private.workspace_can_run_preflight(workspace_id) then
      update public.preflight_dispatch_queue
      set status='superseded',error_category=null
      where id=p_queue_id and status in ('queued','failed');
      return -1;
    end if;
  end if;
  update public.preflight_dispatch_queue
  set status=p_status,
      attempt_count=attempt_count+case when p_status='dispatched' then 1 else 0 end,
      trigger_run_id=case when p_status='dispatched' then null else trigger_run_id end,
      error_category=case when p_status='failed'
        then left(coalesce(p_error_category,'preflight_failed'),80)
        else null end
  where id=p_queue_id and (
    (p_status='dispatched' and attempt_count<6
      and (status in ('queued','failed')
        or (status='dispatched' and updated_at<now()-interval '15 minutes')))
    or (p_status<>'dispatched' and status in ('queued','dispatched','failed'))
  )
  returning attempt_count into resulting_attempt;
  if not found then
    raise exception 'preflight queue item is no longer current' using errcode='40001';
  end if;
  return resulting_attempt;
end;
$$;

create or replace function private.enforce_remediation_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan text;
  v_period_start timestamptz;
  v_limit integer;
begin
  if exists (
    select 1 from public.remediation_proposals proposal
    where proposal.preflight_run_id=new.preflight_run_id
      and proposal.proposal_fingerprint=new.proposal_fingerprint
  ) then
    return new;
  end if;

  -- Serialize quota checks for a workspace before counting existing proposals.
  perform 1 from public.workspaces workspace
  where workspace.id=new.workspace_id
  for update;
  if not found then
    raise exception 'workspace_not_found' using errcode='P0002';
  end if;

  select subscription.plan,
    coalesce(subscription.current_period_start,subscription.trial_started_at,date_trunc('month',now()))
  into v_plan,v_period_start
  from public.workspace_subscriptions subscription
  where subscription.workspace_id=new.workspace_id and (
    (subscription.status='trialing' and subscription.plan='pro'
      and subscription.trial_started_at<=now() and subscription.trial_ends_at>now())
    or (subscription.status='active' and subscription.plan in ('pro','business')
      and subscription.current_period_end>now())
  );
  if not found then
    raise exception 'pro_plan_required' using errcode='42501';
  end if;

  v_limit := case v_plan when 'pro' then 30 when 'business' then 500 else 0 end;
  if (
    select count(*) from public.remediation_proposals proposal
    where proposal.workspace_id=new.workspace_id and proposal.created_at>=v_period_start
  ) >= v_limit then
    raise exception 'remediation_quota_exceeded' using errcode='22023';
  end if;
  return new;
end;
$$;
