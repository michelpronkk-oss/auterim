-- M15.5: resumable, Product-scoped onboarding progress.
create table public.product_onboarding_progress (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null,
  company_id uuid not null,
  stage text not null default 'scan_import' check (stage in (
    'scan_import','company','product','discovery','dependency_confirmation',
    'protection_graph','strengthen_protection','activation','complete'
  )),
  completed_stages text[] not null default '{}',
  milestone_times jsonb not null default '{}'::jsonb check (
    jsonb_typeof(milestone_times)='object' and octet_length(milestone_times::text)<=2048
  ),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id,product_id),
  constraint product_onboarding_progress_product_workspace_fkey
    foreign key (product_id,workspace_id)
    references public.workspace_products(id,workspace_id) on delete cascade,
  constraint product_onboarding_progress_company_workspace_fkey
    foreign key (company_id,workspace_id)
    references public.companies(id,workspace_id) on delete cascade
);
create index product_onboarding_progress_workspace_stage_idx
  on public.product_onboarding_progress(workspace_id,stage,updated_at desc);
create trigger product_onboarding_progress_set_updated_at
  before update on public.product_onboarding_progress
  for each row execute function private.set_updated_at();

alter table public.product_onboarding_progress enable row level security;
revoke all on public.product_onboarding_progress from public,anon,authenticated;
grant select on public.product_onboarding_progress to authenticated;
grant all on public.product_onboarding_progress to service_role;
create policy product_onboarding_progress_select_member
  on public.product_onboarding_progress for select to authenticated
  using ((select private.has_workspace_role(workspace_id,array['owner','admin','member'])));

create function public.start_product_onboarding_v2(p_workspace_id uuid,p_product_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_company uuid; v_status text; v_row public.product_onboarding_progress%rowtype;
begin
  if v_user is null or not exists(select 1 from public.workspace_members m
    where m.workspace_id=p_workspace_id and m.user_id=v_user and m.role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode='42501';
  end if;
  select o.company_id into v_company from public.workspace_onboarding o where o.workspace_id=p_workspace_id;
  if v_company is null then raise exception 'onboarding_company_not_found' using errcode='P0002'; end if;
  select p.status into v_status from public.workspace_products p
    where p.id=p_product_id and p.workspace_id=p_workspace_id;
  if v_status is null then raise exception 'product_not_found' using errcode='P0002'; end if;
  if v_status='archived' then raise exception 'product_archived' using errcode='22023'; end if;
  insert into public.product_onboarding_progress(workspace_id,product_id,company_id,created_by)
  values(p_workspace_id,p_product_id,v_company,v_user)
  on conflict(workspace_id,product_id) do nothing;
  select * into v_row from public.product_onboarding_progress
    where workspace_id=p_workspace_id and product_id=p_product_id;
  if v_status='protected' and v_row.stage<>'complete' then
    update public.product_onboarding_progress set stage='complete',
      completed_stages=array(select distinct unnest(completed_stages || array[
        'scan_import','company','product','discovery','dependency_confirmation','protection_graph','strengthen_protection','activation'
      ])),
      milestone_times=milestone_times || jsonb_build_object('complete',now())
    where workspace_id=p_workspace_id and product_id=p_product_id returning * into v_row;
  end if;
  return jsonb_build_object('workspaceId',v_row.workspace_id,'companyId',v_row.company_id,
    'productId',v_row.product_id,'stage',v_row.stage,'completedStages',v_row.completed_stages,
    'milestoneTimes',v_row.milestone_times,'updatedAt',v_row.updated_at);
end;
$$;

create function public.transition_product_onboarding_v2(
  p_workspace_id uuid,p_product_id uuid,p_target_stage text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_row public.product_onboarding_progress%rowtype;
  v_product public.workspace_products%rowtype; v_order text[] := array[
    'scan_import','company','product','discovery','dependency_confirmation',
    'protection_graph','strengthen_protection','activation','complete'
  ]; v_current integer; v_target integer; v_discovery text; v_dependency_count integer;
begin
  if v_user is null or not exists(select 1 from public.workspace_members m
    where m.workspace_id=p_workspace_id and m.user_id=v_user and m.role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode='42501';
  end if;
  select * into v_product from public.workspace_products p
    where p.id=p_product_id and p.workspace_id=p_workspace_id for update;
  if not found then raise exception 'product_not_found' using errcode='P0002'; end if;
  if v_product.status='archived' then raise exception 'product_archived' using errcode='22023'; end if;
  select * into v_row from public.product_onboarding_progress
    where workspace_id=p_workspace_id and product_id=p_product_id for update;
  if not found then raise exception 'onboarding_progress_not_found' using errcode='P0002'; end if;
  v_current:=array_position(v_order,v_row.stage); v_target:=array_position(v_order,p_target_stage);
  if v_target is null then raise exception 'invalid_onboarding_stage' using errcode='22023'; end if;
  if p_target_stage=v_row.stage then
    return jsonb_build_object('workspaceId',p_workspace_id,'productId',p_product_id,
      'stage',v_row.stage,'completedStages',v_row.completed_stages,'milestoneTimes',v_row.milestone_times);
  end if;
  if p_target_stage='complete' and v_product.status<>'protected' then
    raise exception 'product_not_protected' using errcode='23514';
  end if;
  if v_target>v_current+1 then raise exception 'onboarding_stage_out_of_order' using errcode='23514'; end if;
  if v_target=v_current-1 then
    if v_row.stage in ('activation','complete') then raise exception 'onboarding_back_navigation_closed' using errcode='23514'; end if;
    update public.product_onboarding_progress set stage=p_target_stage
      where workspace_id=p_workspace_id and product_id=p_product_id returning * into v_row;
  elsif v_target=v_current+1 then
    if p_target_stage in ('company','product','discovery') and not exists(
      select 1 from public.workspace_onboarding o where o.workspace_id=p_workspace_id and o.company_id=v_row.company_id
    ) then raise exception 'onboarding_company_not_found' using errcode='23514'; end if;
    if p_target_stage='dependency_confirmation' then
      select run.status into v_discovery from public.dependency_discovery_runs run
      where run.workspace_id=p_workspace_id and run.company_id=v_row.company_id
      order by run.started_at desc limit 1;
      if v_discovery='running' then raise exception 'discovery_still_running' using errcode='23514'; end if;
    end if;
    if p_target_stage='activation' then
      select count(*)::integer into v_dependency_count from public.workspace_dependencies wd
      where wd.workspace_id=p_workspace_id and wd.protected_product_id=p_product_id;
      if v_dependency_count=0 then raise exception 'confirmed_dependency_required' using errcode='23514'; end if;
      if exists(select 1 from public.dependency_discovery_runs run
        where run.workspace_id=p_workspace_id and run.company_id=v_row.company_id and run.status='running') then
        raise exception 'discovery_still_running' using errcode='23514';
      end if;
      if exists(select 1 from public.discovered_dependencies candidate
        where candidate.workspace_id=p_workspace_id and candidate.company_id=v_row.company_id and candidate.status='candidate') then
        raise exception 'review_pending_candidates' using errcode='23514';
      end if;
    end if;
    update public.product_onboarding_progress set
      stage=p_target_stage,
      completed_stages=array(select distinct unnest(completed_stages || array[v_row.stage])),
      milestone_times=milestone_times || jsonb_build_object(v_row.stage,now())
      where workspace_id=p_workspace_id and product_id=p_product_id returning * into v_row;
  end if;
  return jsonb_build_object('workspaceId',p_workspace_id,'productId',p_product_id,
    'stage',v_row.stage,'completedStages',v_row.completed_stages,
    'milestoneTimes',v_row.milestone_times,'updatedAt',v_row.updated_at);
end;
$$;

-- Existing workspace activation remains the compatibility path for the default Product,
-- but its evidence and baseline eligibility are now explicitly Product-scoped.
create or replace function public.activate_workspace_protection(p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := (select auth.uid()); v_onboarding public.workspace_onboarding%rowtype;
  v_product_id uuid; v_activated_at timestamptz; v_dependencies integer; v_sources integer;
  v_critical integer; v_snapshots integer; v_failed integer; v_baseline_status text;
begin
  if v_user_id is null or not exists(select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=v_user_id and role in ('owner','admin')) then
    raise exception 'Owner or admin permission is required to activate protection' using errcode='42501';
  end if;
  select * into v_onboarding from public.workspace_onboarding where workspace_id=p_workspace_id for update;
  if not found then raise exception 'Workspace onboarding was not found' using errcode='P0002'; end if;
  select id into v_product_id from public.workspace_products
    where workspace_id=p_workspace_id and is_default and status<>'archived' for update;
  if v_product_id is null then raise exception 'default_product_not_found' using errcode='P0002'; end if;
  if v_onboarding.state='active' then
    v_activated_at:=v_onboarding.activated_at;
  else
    if v_onboarding.state<>'notifications_setup' or v_onboarding.dependency_review_completed_at is null
      or v_onboarding.context_completed_at is null or v_onboarding.notifications_completed_at is null then
      raise exception 'Complete onboarding steps before activating protection' using errcode='23514';
    end if;
    if not exists(select 1 from public.workspace_dependencies
      where workspace_id=p_workspace_id and protected_product_id=v_product_id) then
      raise exception 'Confirm or add at least one dependency before activating protection' using errcode='23514';
    end if;
    if exists(select 1 from public.dependency_discovery_runs run
      join public.workspace_onboarding onboarding on onboarding.company_id=run.company_id
      where onboarding.workspace_id=p_workspace_id and run.status='running') then
      raise exception 'Discovery must settle before activation' using errcode='23514';
    end if;
    if exists(select 1 from public.discovered_dependencies candidate
      join public.workspace_onboarding onboarding on onboarding.company_id=candidate.company_id
      where onboarding.workspace_id=p_workspace_id and candidate.status='candidate') then
      raise exception 'Review pending discovery candidates before activation' using errcode='23514';
    end if;
    update public.workspace_onboarding set state='activating' where workspace_id=p_workspace_id;
    v_activated_at:=now();
    update public.workspace_dependencies set monitoring_enabled=true,
      protection_started_at=coalesce(protection_started_at,v_activated_at)
    where workspace_id=p_workspace_id and protected_product_id=v_product_id;
    insert into public.baseline_scan_queue(source_id)
    select distinct source.id from public.workspace_dependencies wd
      join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
    where wd.workspace_id=p_workspace_id and wd.protected_product_id=v_product_id and wd.monitoring_enabled
      and not exists(select 1 from public.source_snapshots snapshot where snapshot.source_id=source.id)
      and not exists(select 1 from public.scan_runs run where run.source_id=source.id and run.status='pending'
        and run.started_at>now()-interval '15 minutes')
    on conflict(source_id) do nothing;
    update public.workspace_products set status='protected',protected_at=coalesce(protected_at,v_activated_at)
      where id=v_product_id and workspace_id=p_workspace_id and status='draft';
    update public.workspace_onboarding set state='active',activated_at=v_activated_at,activated_by=v_user_id
      where workspace_id=p_workspace_id;
  end if;
  select count(*)::integer into v_dependencies from public.workspace_dependencies
    where workspace_id=p_workspace_id and protected_product_id=v_product_id and monitoring_enabled;
  select count(distinct source.id)::integer into v_sources from public.workspace_dependencies wd
    join public.source_catalog source on source.dependency_id=wd.dependency_id
    where wd.workspace_id=p_workspace_id and wd.protected_product_id=v_product_id and wd.monitoring_enabled and source.enabled;
  select count(*)::integer into v_critical from public.workspace_dependencies wd
    left join public.dependency_context context on context.workspace_dependency_id=wd.id
    where wd.workspace_id=p_workspace_id and wd.protected_product_id=v_product_id and wd.monitoring_enabled
      and coalesce(context.criticality,'normal')='critical';
  select count(distinct source.id)::integer into v_snapshots from public.workspace_dependencies wd
    join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
    join public.source_snapshots snapshot on snapshot.source_id=source.id
    where wd.workspace_id=p_workspace_id and wd.protected_product_id=v_product_id and wd.monitoring_enabled;
  select count(distinct source.id)::integer into v_failed from public.workspace_dependencies wd
    join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
    join public.baseline_scan_queue queue on queue.source_id=source.id and queue.status='failed'
    where wd.workspace_id=p_workspace_id and wd.protected_product_id=v_product_id and wd.monitoring_enabled;
  v_baseline_status:=case when v_sources=0 then 'partial' when v_snapshots=v_sources then 'ready'
    when v_failed>0 then 'partial' else 'in_progress' end;
  return jsonb_build_object('workspaceId',p_workspace_id,'productId',v_product_id,'activatedAt',v_activated_at,
    'protection',jsonb_build_object('dependencies',v_dependencies,'authoritativeSources',v_sources,
      'criticalDependencies',v_critical,'baselineStatus',v_baseline_status));
end;
$$;

create function public.activate_product_protection_v2(p_workspace_id uuid,p_product_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_product public.workspace_products%rowtype;
  v_activated_at timestamptz; v_dependencies integer; v_sources integer; v_critical integer;
  v_snapshots integer; v_failed integer; v_status text;
begin
  if v_user is null or not exists(select 1 from public.workspace_members m
    where m.workspace_id=p_workspace_id and m.user_id=v_user and m.role in ('owner','admin')) then
    raise exception 'Owner or admin permission is required to activate protection' using errcode='42501';
  end if;
  perform 1 from public.workspaces w where w.id=p_workspace_id for update;
  select * into v_product from public.workspace_products p
    where p.id=p_product_id and p.workspace_id=p_workspace_id for update;
  if not found then raise exception 'product_not_found' using errcode='P0002'; end if;
  if v_product.status='archived' then raise exception 'product_archived' using errcode='22023'; end if;
  if not exists(select 1 from public.product_onboarding_progress progress
    where progress.workspace_id=p_workspace_id and progress.product_id=p_product_id
      and progress.stage in ('activation','complete')) then
    raise exception 'onboarding_activation_stage_required' using errcode='23514';
  end if;
  if v_product.is_default then
    return public.activate_workspace_protection(p_workspace_id);
  end if;
  if not exists(select 1 from public.workspace_onboarding onboarding
    where onboarding.workspace_id=p_workspace_id and onboarding.state='active') then
    raise exception 'workspace_protection_not_active' using errcode='23514';
  end if;
  if not exists(select 1 from public.workspace_dependencies wd
    where wd.workspace_id=p_workspace_id and wd.protected_product_id=p_product_id) then
    raise exception 'confirmed_dependency_required' using errcode='23514';
  end if;
  if exists(select 1 from public.workspace_onboarding onboarding
    join public.dependency_discovery_runs run on run.company_id=onboarding.company_id
    where onboarding.workspace_id=p_workspace_id and run.workspace_id=p_workspace_id and run.status='running') then
    raise exception 'discovery_still_running' using errcode='23514';
  end if;
  if exists(select 1 from public.workspace_onboarding onboarding
    join public.discovered_dependencies candidate on candidate.company_id=onboarding.company_id
    where onboarding.workspace_id=p_workspace_id and candidate.workspace_id=p_workspace_id and candidate.status='candidate') then
    raise exception 'review_pending_candidates' using errcode='23514';
  end if;
  if v_product.status<>'protected' then
    update public.workspace_dependencies set monitoring_enabled=true,
      protection_started_at=coalesce(protection_started_at,now())
      where workspace_id=p_workspace_id and protected_product_id=p_product_id;
  end if;
  insert into public.baseline_scan_queue(source_id)
  select distinct source.id from public.workspace_dependencies wd
    join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
  where wd.workspace_id=p_workspace_id and wd.protected_product_id=p_product_id and wd.monitoring_enabled
    and not exists(select 1 from public.source_snapshots snapshot where snapshot.source_id=source.id)
    and not exists(select 1 from public.scan_runs run where run.source_id=source.id and run.status='pending'
      and run.started_at>now()-interval '15 minutes')
  on conflict(source_id) do nothing;
  if v_product.status<>'protected' then
    update public.workspace_products set status='protected',protected_at=coalesce(protected_at,now())
      where id=p_product_id and workspace_id=p_workspace_id;
  end if;
  update public.product_onboarding_progress set stage='complete',
    completed_stages=array(select distinct unnest(completed_stages || array[
      'scan_import','company','product','discovery','dependency_confirmation',
      'protection_graph','strengthen_protection','activation'
    ])),
    milestone_times=milestone_times || jsonb_build_object('activation',now(),'complete',now())
    where workspace_id=p_workspace_id and product_id=p_product_id;
  select protected_at into v_activated_at from public.workspace_products
    where id=p_product_id and workspace_id=p_workspace_id;
  select count(*)::integer into v_dependencies from public.workspace_dependencies
    where workspace_id=p_workspace_id and protected_product_id=p_product_id and monitoring_enabled;
  select count(distinct source.id)::integer into v_sources from public.workspace_dependencies wd
    join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
    where wd.workspace_id=p_workspace_id and wd.protected_product_id=p_product_id and wd.monitoring_enabled;
  select count(*)::integer into v_critical from public.workspace_dependencies wd
    left join public.dependency_context context on context.workspace_dependency_id=wd.id
    where wd.workspace_id=p_workspace_id and wd.protected_product_id=p_product_id and wd.monitoring_enabled
      and coalesce(context.criticality,'normal')='critical';
  select count(distinct source.id)::integer into v_snapshots from public.workspace_dependencies wd
    join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
    join public.source_snapshots snapshot on snapshot.source_id=source.id
    where wd.workspace_id=p_workspace_id and wd.protected_product_id=p_product_id and wd.monitoring_enabled;
  select count(distinct source.id)::integer into v_failed from public.workspace_dependencies wd
    join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
    join public.baseline_scan_queue queue on queue.source_id=source.id and queue.status='failed'
    where wd.workspace_id=p_workspace_id and wd.protected_product_id=p_product_id and wd.monitoring_enabled;
  v_status:=case when v_sources=0 then 'partial' when v_snapshots=v_sources then 'ready'
    when v_failed>0 then 'partial' else 'in_progress' end;
  return jsonb_build_object('workspaceId',p_workspace_id,'productId',p_product_id,
    'activatedAt',v_activated_at,'protection',jsonb_build_object('dependencies',v_dependencies,
      'authoritativeSources',v_sources,'criticalDependencies',v_critical,'baselineStatus',v_status));
end;
$$;

-- Onboarding may immediately claim shared baselines, but only dependencies belonging to
-- already protected Products may be introduced by this request path. The global scheduler
-- remains responsible for global source coverage and recovery.
drop function public.claim_onboarding_baseline_sources(uuid,uuid,integer);
create function public.claim_onboarding_baseline_sources(
  p_actor_user_id uuid,p_workspace_id uuid,p_limit integer default 50
)
returns table(queue_id uuid,source_id uuid,dispatch_attempt integer,lease_recovery_count integer,recovered boolean)
language plpgsql security definer set search_path = '' as $$
begin
  if p_actor_user_id is null or not exists (
    select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=p_actor_user_id
      and role in ('owner','admin','member')
  ) then
    raise exception 'Workspace is not available to this user' using errcode='42501';
  end if;
  if not exists (
    select 1 from public.workspace_onboarding
    where workspace_id=p_workspace_id and state='active'
  ) then
    raise exception 'Workspace protection is not active' using errcode='42501';
  end if;
  insert into public.baseline_scan_queue(source_id)
  select distinct source.id
  from public.workspace_dependencies wd
  join public.workspace_products product
    on product.id=wd.protected_product_id and product.workspace_id=wd.workspace_id
      and product.status='protected'
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

revoke all on function public.start_product_onboarding_v2(uuid,uuid) from public,anon;
revoke all on function public.transition_product_onboarding_v2(uuid,uuid,text) from public,anon;
revoke all on function public.activate_product_protection_v2(uuid,uuid) from public,anon;
grant execute on function public.start_product_onboarding_v2(uuid,uuid) to authenticated;
grant execute on function public.transition_product_onboarding_v2(uuid,uuid,text) to authenticated;
grant execute on function public.activate_product_protection_v2(uuid,uuid) to authenticated;
revoke all on function public.claim_onboarding_baseline_sources(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_onboarding_baseline_sources(uuid,uuid,integer) to service_role;
