-- Baseline dispatch is global work: activation creates/reclaims claims, while the existing
-- global source scheduler provides recovery even if a workspace never re-enters onboarding.
alter table public.baseline_scan_queue
  add column lease_recovery_count integer not null default 0,
  add column retry_after timestamptz;

alter table public.baseline_scan_queue
  add constraint baseline_scan_queue_lease_recovery_count_check
    check (lease_recovery_count between 0 and 3);

create index baseline_scan_queue_retry_idx
  on public.baseline_scan_queue (retry_after, created_at, source_id)
  where status in ('queued', 'failed');

create or replace function public.list_due_source_ids(
  p_now timestamptz default now(),
  p_limit integer default 100
)
returns table(source_id uuid)
language sql
security invoker
set search_path = ''
as $$
  select source.id
  from public.source_catalog source
  where source.enabled
    and (source.last_checked_at is null
      or source.last_checked_at + make_interval(secs => source.default_interval_seconds) <= p_now)
    and not exists (
      select 1 from public.baseline_scan_queue queue
      where queue.source_id=source.id and queue.status <> 'complete'
    )
  order by source.last_checked_at asc nulls first,source.id
  limit least(greatest(coalesce(p_limit,1),1),100);
$$;

drop function public.claim_onboarding_baseline_sources(uuid,uuid,integer);

create function private.claim_baseline_scan_sources(p_workspace_id uuid, p_limit integer)
returns table(
  out_queue_id uuid,
  out_source_id uuid,
  out_dispatch_attempt integer,
  out_lease_recovery_count integer,
  out_recovered boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A stale dispatched run is eligible only after its scan has had ample time to start.
  -- Successful/failed scan persistence updates the queue directly through existing triggers.
  update public.baseline_scan_queue queue
  set status='failed', dispatch_lease_until=null, retry_after=now()+interval '15 minutes',
      error_category='lease_recovery_exhausted'
  where queue.lease_recovery_count >= 3
    and (p_workspace_id is null or exists (
      select 1 from public.source_catalog scoped_source
      join public.workspace_dependencies scoped_dependency
        on scoped_dependency.dependency_id=scoped_source.dependency_id
      where scoped_source.id=queue.source_id
        and scoped_dependency.workspace_id=p_workspace_id
        and scoped_dependency.monitoring_enabled
    ))
    and (
      (queue.status='dispatching' and queue.dispatch_lease_until < now())
      or (queue.status='dispatched' and queue.updated_at < now()-interval '15 minutes'
        and not exists (
          select 1 from public.scan_runs run
          where run.trigger_run_id=queue.trigger_run_id and run.status='pending'
            and run.started_at > now()-interval '15 minutes'
        ))
    );

  return query
  with claimable as (
    select queue.source_id, queue.status as prior_status
    from public.baseline_scan_queue queue
    join public.source_catalog source on source.id=queue.source_id and source.enabled
    where (p_workspace_id is null or exists (
      select 1 from public.workspace_dependencies wd
      where wd.workspace_id=p_workspace_id and wd.dependency_id=source.dependency_id
        and wd.monitoring_enabled
    ))
      and (
        (queue.status in ('queued','failed') and queue.dispatch_attempt < 5
          and coalesce(queue.retry_after, '-infinity'::timestamptz) <= now())
        or (queue.status='dispatching' and queue.dispatch_lease_until < now()
          and queue.lease_recovery_count < 3)
        or (queue.status='dispatched' and queue.updated_at < now()-interval '15 minutes'
          and queue.lease_recovery_count < 3
          and not exists (
            select 1 from public.scan_runs run
            where run.trigger_run_id=queue.trigger_run_id and run.status='pending'
              and run.started_at > now()-interval '15 minutes'
          ))
      )
    order by queue.created_at,queue.source_id
    for update of queue skip locked
    limit least(greatest(coalesce(p_limit,1),1),100)
  ), claimed as (
    update public.baseline_scan_queue queue
    set status='dispatching',
        dispatch_attempt=case when claimable.prior_status in ('queued','failed')
          then queue.dispatch_attempt+1 else queue.dispatch_attempt end,
        lease_recovery_count=case when claimable.prior_status in ('dispatching','dispatched')
          then queue.lease_recovery_count+1 else 0 end,
        dispatch_lease_until=now()+interval '2 minutes',
        retry_after=null,
        error_category=null
    from claimable
    where queue.source_id=claimable.source_id
    returning queue.source_id,queue.dispatch_attempt,queue.lease_recovery_count,
      (claimable.prior_status in ('dispatching','dispatched')) as recovered
  ), saved as (
    insert into public.baseline_scan_dispatch_claims(id,source_id,dispatch_attempt)
    select gen_random_uuid(),claimed.source_id,claimed.dispatch_attempt from claimed
    on conflict (source_id,dispatch_attempt) do update
      set created_at=public.baseline_scan_dispatch_claims.created_at
    returning id,source_id,dispatch_attempt
  )
  select saved.id,saved.source_id,saved.dispatch_attempt,claimed.lease_recovery_count,claimed.recovered
  from saved
  join claimed on claimed.source_id=saved.source_id
    and claimed.dispatch_attempt=saved.dispatch_attempt;
end;
$$;

create function public.claim_onboarding_baseline_sources(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_limit integer default 50
)
returns table(queue_id uuid,source_id uuid,dispatch_attempt integer,lease_recovery_count integer,recovered boolean)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_actor_user_id is null or not exists (
    select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=p_actor_user_id
      and role in ('owner','admin','member')
  ) then
    raise exception 'Workspace is not available to this user' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.workspace_onboarding
    where workspace_id=p_workspace_id and state='active'
  ) then
    raise exception 'Workspace protection is not active' using errcode = '42501';
  end if;
  insert into public.baseline_scan_queue (source_id)
  select distinct source.id from public.workspace_dependencies wd
  join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
  where wd.workspace_id=p_workspace_id and wd.monitoring_enabled
    and not exists (select 1 from public.source_snapshots snapshot where snapshot.source_id=source.id)
    and not exists (select 1 from public.scan_runs run where run.source_id=source.id and run.status='pending'
      and run.started_at > now()-interval '15 minutes')
  on conflict on constraint baseline_scan_queue_pkey do nothing;
  return query
  select claim.out_queue_id,claim.out_source_id,claim.out_dispatch_attempt,
    claim.out_lease_recovery_count,claim.out_recovered
  from private.claim_baseline_scan_sources(p_workspace_id,p_limit) claim;
end;
$$;

create function public.claim_due_baseline_sources(p_limit integer default 100)
returns table(queue_id uuid,source_id uuid,dispatch_attempt integer,lease_recovery_count integer,recovered boolean)
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.baseline_scan_queue (source_id)
  select distinct source.id
  from public.workspace_onboarding onboarding
  join public.workspace_dependencies wd on wd.workspace_id=onboarding.workspace_id
    and wd.monitoring_enabled
  join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
  where onboarding.state='active'
    and not exists (select 1 from public.source_snapshots snapshot where snapshot.source_id=source.id)
    and not exists (select 1 from public.scan_runs run where run.source_id=source.id and run.status='pending'
      and run.started_at > now()-interval '15 minutes')
  on conflict on constraint baseline_scan_queue_pkey do nothing;
  return query
  select claim.out_queue_id,claim.out_source_id,claim.out_dispatch_attempt,
    claim.out_lease_recovery_count,claim.out_recovered
  from private.claim_baseline_scan_sources(null,p_limit) claim;
end;
$$;

create function private.mark_baseline_scan_dispatched(p_queue_id uuid,p_dispatch_attempt integer,p_trigger_run_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_source_id uuid; v_queue public.baseline_scan_queue%rowtype;
begin
  select source_id into v_source_id from public.baseline_scan_dispatch_claims
  where id=p_queue_id and dispatch_attempt=p_dispatch_attempt;
  if not found then raise exception 'Baseline claim was not found' using errcode='P0002'; end if;
  select * into v_queue from public.baseline_scan_queue where source_id=v_source_id for update;
  if not found or v_queue.dispatch_attempt <> p_dispatch_attempt then
    raise exception 'Baseline claim is no longer current' using errcode='40001';
  end if;
  if v_queue.status='complete' then return; end if;
  if v_queue.status='dispatched' and v_queue.trigger_run_id=p_trigger_run_id then return; end if;
  if v_queue.status <> 'dispatching' then
    raise exception 'Baseline claim is no longer current' using errcode='40001';
  end if;
  update public.baseline_scan_queue
  set status='dispatched',dispatch_lease_until=null,trigger_run_id=p_trigger_run_id
  where source_id=v_source_id;
end;
$$;

create or replace function public.mark_onboarding_baseline_dispatched(
  p_actor_user_id uuid,p_workspace_id uuid,p_queue_id uuid,p_dispatch_attempt integer,p_trigger_run_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_actor_user_id is null or not exists (
    select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=p_actor_user_id
      and role in ('owner','admin','member')
  ) then
    raise exception 'Workspace is not available to this user' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.baseline_scan_dispatch_claims claim
    join public.source_catalog source on source.id=claim.source_id
    join public.workspace_dependencies wd on wd.dependency_id=source.dependency_id
    where claim.id=p_queue_id and claim.dispatch_attempt=p_dispatch_attempt
      and wd.workspace_id=p_workspace_id and wd.monitoring_enabled
  ) then raise exception 'Baseline claim is not available to this workspace' using errcode='42501'; end if;
  perform private.mark_baseline_scan_dispatched(p_queue_id,p_dispatch_attempt,p_trigger_run_id);
end;
$$;

create function public.mark_due_baseline_source_dispatched(
  p_queue_id uuid,p_dispatch_attempt integer,p_trigger_run_id text
)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.mark_baseline_scan_dispatched(p_queue_id,p_dispatch_attempt,p_trigger_run_id);
$$;

create function private.release_baseline_scan_claim(p_queue_id uuid,p_dispatch_attempt integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_source_id uuid;
begin
  select source_id into v_source_id from public.baseline_scan_dispatch_claims
  where id=p_queue_id and dispatch_attempt=p_dispatch_attempt;
  if not found then raise exception 'Baseline claim was not found' using errcode='P0002'; end if;
  update public.baseline_scan_queue
  set status=case when dispatch_attempt >= 5 then 'failed' else 'queued' end,
      dispatch_lease_until=null,
      retry_after=case when dispatch_attempt >= 5 then null else now()+interval '5 minutes' end,
      error_category='trigger_dispatch_failed'
  where source_id=v_source_id and status='dispatching' and dispatch_attempt=p_dispatch_attempt;
end;
$$;

create or replace function public.release_onboarding_baseline_claim(
  p_actor_user_id uuid,p_workspace_id uuid,p_queue_id uuid,p_dispatch_attempt integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_actor_user_id is null or not exists (
    select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=p_actor_user_id
      and role in ('owner','admin','member')
  ) then
    raise exception 'Workspace is not available to this user' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.baseline_scan_dispatch_claims claim
    join public.source_catalog source on source.id=claim.source_id
    join public.workspace_dependencies wd on wd.dependency_id=source.dependency_id
    where claim.id=p_queue_id and claim.dispatch_attempt=p_dispatch_attempt
      and wd.workspace_id=p_workspace_id and wd.monitoring_enabled
  ) then raise exception 'Baseline claim is not available to this workspace' using errcode='42501'; end if;
  perform private.release_baseline_scan_claim(p_queue_id,p_dispatch_attempt);
end;
$$;

create function public.release_due_baseline_source_claim(p_queue_id uuid,p_dispatch_attempt integer)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.release_baseline_scan_claim(p_queue_id,p_dispatch_attempt);
$$;

create or replace function private.mark_baseline_queue_from_scan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('success','unchanged','changed','not_modified') then
    update public.baseline_scan_queue
    set status='complete',dispatch_lease_until=null,retry_after=null,error_category=null
    where source_id=new.source_id;
  elsif new.status='failed' then
    update public.baseline_scan_queue
    set status='failed',dispatch_lease_until=null,
        retry_after=case when dispatch_attempt < 5 then now()+interval '5 minutes' else null end,
        error_category=coalesce(new.error_category,'scan_failed')
    where source_id=new.source_id and status <> 'complete';
  end if;
  return new;
end;
$$;

create or replace function private.mark_baseline_queue_from_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.baseline_scan_queue
  set status='complete',dispatch_lease_until=null,retry_after=null,error_category=null
  where source_id=new.source_id;
  return new;
end;
$$;

-- The existing immutable scan/snapshot history remains untouched. Updating source_catalog keeps
-- the canonical source identity while directing future scans to the current official page.
update public.source_catalog source
set url='https://developers.openai.com/api/docs/pricing',
    last_checked_at=null,
    last_success_at=null,
    etag=null,
    last_modified=null
from public.dependency_catalog dependency
where source.dependency_id=dependency.id
  and dependency.slug='openai'
  and source.source_type='pricing'
  and source.name='OpenAI API pricing'
  and source.url='https://openai.com/api/pricing/';

revoke all on function private.claim_baseline_scan_sources(uuid,integer) from public,anon,authenticated;
revoke all on function private.mark_baseline_scan_dispatched(uuid,integer,text) from public,anon,authenticated;
revoke all on function private.release_baseline_scan_claim(uuid,integer) from public,anon,authenticated;
revoke all on function public.claim_onboarding_baseline_sources(uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.claim_due_baseline_sources(integer) from public,anon,authenticated;
revoke all on function public.mark_onboarding_baseline_dispatched(uuid,uuid,uuid,integer,text) from public,anon,authenticated;
revoke all on function public.mark_due_baseline_source_dispatched(uuid,integer,text) from public,anon,authenticated;
revoke all on function public.release_onboarding_baseline_claim(uuid,uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.release_due_baseline_source_claim(uuid,integer) from public,anon,authenticated;
grant execute on function private.claim_baseline_scan_sources(uuid,integer) to service_role;
grant execute on function private.mark_baseline_scan_dispatched(uuid,integer,text) to service_role;
grant execute on function private.release_baseline_scan_claim(uuid,integer) to service_role;
grant execute on function public.claim_onboarding_baseline_sources(uuid,uuid,integer) to service_role;
grant execute on function public.claim_due_baseline_sources(integer) to service_role;
grant execute on function public.mark_onboarding_baseline_dispatched(uuid,uuid,uuid,integer,text) to service_role;
grant execute on function public.mark_due_baseline_source_dispatched(uuid,integer,text) to service_role;
grant execute on function public.release_onboarding_baseline_claim(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.release_due_baseline_source_claim(uuid,integer) to service_role;
