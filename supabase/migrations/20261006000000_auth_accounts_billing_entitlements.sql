-- Auterim Milestone 8: activation-based trial, authoritative billing state, and webhook receipts.

create table public.workspace_subscriptions (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  plan text check (plan is null or plan in ('core','pro','business')),
  status text not null default 'trialing' check (status in ('trialing','active','past_due','on_hold','cancelled','expired')),
  dodo_customer_id text unique check (dodo_customer_id is null or char_length(dodo_customer_id) between 1 and 160),
  dodo_subscription_id text unique check (dodo_subscription_id is null or char_length(dodo_subscription_id) between 1 and 160),
  dodo_product_id text check (dodo_product_id is null or char_length(dodo_product_id) between 1 and 160),
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  provider_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_subscriptions_trial_pair_check check (
    (trial_started_at is null and trial_ends_at is null)
    or (trial_started_at is not null and trial_ends_at = trial_started_at + interval '5 days')
  ),
  constraint workspace_subscriptions_period_check check (
    current_period_end is null or current_period_start is null or current_period_end >= current_period_start
  )
);

create index workspace_subscriptions_status_period_idx
  on public.workspace_subscriptions (status, current_period_end);
create index workspace_subscriptions_trial_end_idx
  on public.workspace_subscriptions (trial_ends_at)
  where status = 'trialing';

create trigger workspace_subscriptions_set_updated_at
  before update on public.workspace_subscriptions
  for each row execute function private.set_updated_at();

alter table public.workspace_subscriptions enable row level security;
grant select on public.workspace_subscriptions to authenticated;
grant all on public.workspace_subscriptions to service_role;
create policy workspace_subscriptions_select_member on public.workspace_subscriptions
  for select to authenticated
  using (exists (
    select 1 from public.workspace_members member
    where member.workspace_id = workspace_subscriptions.workspace_id
      and member.user_id = (select auth.uid())
  ));

create table public.billing_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'dodo' check (provider = 'dodo'),
  external_event_id text not null unique check (char_length(external_event_id) between 1 and 200),
  event_type text not null check (char_length(event_type) between 1 and 100),
  received_at timestamptz not null default now(),
  provider_event_at timestamptz,
  processed_at timestamptz,
  status text not null default 'received' check (status in ('received','processed','duplicate','ignored','stale','failed')),
  error_category text check (error_category is null or error_category ~ '^[a-z_]{1,80}$')
);
create index billing_webhook_events_received_idx
  on public.billing_webhook_events (received_at desc);
alter table public.billing_webhook_events enable row level security;
revoke all on public.billing_webhook_events from public, anon, authenticated;
grant all on public.billing_webhook_events to service_role;

create table public.workspace_initial_assessments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces (id) on delete cascade,
  activated_at timestamptz not null,
  dependencies_confirmed integer not null check (dependencies_confirmed >= 0),
  authoritative_sources_available integer not null check (authoritative_sources_available >= 0),
  current_global_baselines integer not null check (current_global_baselines >= 0),
  material_changes_evaluated integer not null check (material_changes_evaluated >= 0),
  relevant_changes integer not null check (relevant_changes >= 0),
  verified_repository_exposures integer not null check (verified_repository_exposures >= 0),
  remediation_available integer not null check (remediation_available >= 0),
  created_at timestamptz not null default now()
);
create index workspace_initial_assessments_created_idx
  on public.workspace_initial_assessments (created_at desc);
alter table public.workspace_initial_assessments enable row level security;
grant select on public.workspace_initial_assessments to authenticated;
grant all on public.workspace_initial_assessments to service_role;
create policy workspace_initial_assessments_select_member on public.workspace_initial_assessments
  for select to authenticated
  using (exists (
    select 1 from public.workspace_members member
    where member.workspace_id = workspace_initial_assessments.workspace_id
      and member.user_id = (select auth.uid())
  ));

-- The trial is created in the activation transaction, not during account creation.
create function private.start_workspace_pro_trial()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = 'active' and old.state <> 'active' then
    insert into public.workspace_subscriptions (
      workspace_id, plan, status, trial_started_at, trial_ends_at
    ) values (
      new.workspace_id, 'pro', 'trialing', new.activated_at, new.activated_at + interval '5 days'
    ) on conflict (workspace_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function private.start_workspace_pro_trial() from public, anon, authenticated;
create trigger workspace_onboarding_start_pro_trial
  after update of state on public.workspace_onboarding
  for each row execute function private.start_workspace_pro_trial();

create function private.capture_workspace_initial_assessment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_dependencies integer; v_sources integer; v_snapshots integer;
  v_material integer; v_relevant integer; v_verified integer; v_remediation integer;
begin
  if new.state <> 'active' or old.state = 'active' then return new; end if;
  select count(*)::integer into v_dependencies
    from public.workspace_dependencies wd
    where wd.workspace_id=new.workspace_id and wd.monitoring_enabled and wd.created_at <= new.activated_at;
  select count(distinct source.id)::integer into v_sources
    from public.workspace_dependencies wd
    join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
    where wd.workspace_id=new.workspace_id and wd.monitoring_enabled and wd.created_at <= new.activated_at;
  select count(distinct source.id)::integer into v_snapshots
    from public.workspace_dependencies wd
    join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
    join public.source_snapshots snapshot on snapshot.source_id=source.id and snapshot.created_at <= new.activated_at
    where wd.workspace_id=new.workspace_id and wd.monitoring_enabled and wd.created_at <= new.activated_at;
  select count(*)::integer, count(*) filter (where assessment.relevant)::integer
    into v_material, v_relevant
    from public.impact_assessments assessment
    join public.workspace_dependencies wd on wd.id=assessment.workspace_dependency_id
    where assessment.workspace_id=new.workspace_id and wd.monitoring_enabled
      and assessment.status='assessed' and assessment.assessed_at >= new.activated_at;
  select count(*)::integer into v_verified
    from public.preflight_runs run
    where run.workspace_id=new.workspace_id and run.created_at >= new.activated_at
      and run.status in ('completed','partial') and run.verified_impact='verified';
  select count(*)::integer into v_remediation
    from public.remediation_proposals proposal
    where proposal.workspace_id=new.workspace_id and proposal.created_at >= new.activated_at;
  insert into public.workspace_initial_assessments (
    workspace_id,activated_at,dependencies_confirmed,authoritative_sources_available,
    current_global_baselines,material_changes_evaluated,relevant_changes,
    verified_repository_exposures,remediation_available
  ) values (
    new.workspace_id,new.activated_at,v_dependencies,v_sources,v_snapshots,v_material,v_relevant,v_verified,v_remediation
  ) on conflict (workspace_id) do nothing;
  return new;
end;
$$;
revoke all on function private.capture_workspace_initial_assessment() from public, anon, authenticated;
create trigger workspace_onboarding_capture_initial_assessment
  after update of state on public.workspace_onboarding
  for each row execute function private.capture_workspace_initial_assessment();

-- Preserve historical activations without granting a fresh five-day trial from migration time.
insert into public.workspace_subscriptions (
  workspace_id, plan, status, trial_started_at, trial_ends_at
)
select workspace_id, 'pro', 'trialing', activated_at, activated_at + interval '5 days'
from public.workspace_onboarding
where state = 'active' and activated_at is not null
on conflict (workspace_id) do nothing;

-- Backfill the activation-time read model for workspaces that were already active.
insert into public.workspace_initial_assessments (
  workspace_id,activated_at,dependencies_confirmed,authoritative_sources_available,
  current_global_baselines,material_changes_evaluated,relevant_changes,
  verified_repository_exposures,remediation_available
)
select onboarding.workspace_id,onboarding.activated_at,
  (select count(*)::integer from public.workspace_dependencies wd
   where wd.workspace_id=onboarding.workspace_id and wd.monitoring_enabled and wd.created_at<=onboarding.activated_at),
  (select count(distinct source.id)::integer from public.workspace_dependencies wd
   join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
   where wd.workspace_id=onboarding.workspace_id and wd.monitoring_enabled and wd.created_at<=onboarding.activated_at),
  (select count(distinct source.id)::integer from public.workspace_dependencies wd
   join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
   join public.source_snapshots snapshot on snapshot.source_id=source.id and snapshot.created_at<=onboarding.activated_at
   where wd.workspace_id=onboarding.workspace_id and wd.monitoring_enabled and wd.created_at<=onboarding.activated_at),
  (select count(*)::integer from public.impact_assessments assessment
   join public.workspace_dependencies wd on wd.id=assessment.workspace_dependency_id
   where assessment.workspace_id=onboarding.workspace_id and wd.monitoring_enabled
     and assessment.status='assessed' and assessment.assessed_at>=onboarding.activated_at and assessment.assessed_at<=now()),
  (select count(*)::integer from public.impact_assessments assessment
   join public.workspace_dependencies wd on wd.id=assessment.workspace_dependency_id
   where assessment.workspace_id=onboarding.workspace_id and wd.monitoring_enabled and assessment.relevant
     and assessment.status='assessed' and assessment.assessed_at>=onboarding.activated_at and assessment.assessed_at<=now()),
  (select count(*)::integer from public.preflight_runs run
   where run.workspace_id=onboarding.workspace_id and run.created_at>=onboarding.activated_at
     and run.completed_at<=now() and run.status in ('completed','partial') and run.verified_impact='verified'),
  (select count(*)::integer from public.remediation_proposals proposal
   where proposal.workspace_id=onboarding.workspace_id and proposal.created_at>=onboarding.activated_at and proposal.created_at<=now())
from public.workspace_onboarding onboarding
where onboarding.state='active' and onboarding.activated_at is not null
on conflict (workspace_id) do nothing;

create function public.attach_workspace_dodo_customer(p_workspace_id uuid, p_customer_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null or not exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = v_user_id and role in ('owner','admin')
  ) then
    raise exception 'Owner or admin permission is required' using errcode = '42501';
  end if;
  if p_customer_id is null or char_length(p_customer_id) not between 1 and 160 then
    raise exception 'Invalid billing customer' using errcode = '22023';
  end if;
  update public.workspace_subscriptions
    set dodo_customer_id = coalesce(dodo_customer_id, p_customer_id)
    where workspace_id = p_workspace_id
      and (dodo_customer_id is null or dodo_customer_id = p_customer_id);
  if not found then
    raise exception 'Billing customer could not be attached' using errcode = '23505';
  end if;
end;
$$;

create function public.get_workspace_billing_snapshot(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_user_id uuid := (select auth.uid()); v_subscription public.workspace_subscriptions%rowtype;
  v_now timestamptz := now(); v_activation timestamptz;
begin
  if v_user_id is null or not exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = v_user_id and role in ('owner','admin','member')
  ) then
    raise exception 'Workspace is not available to this user' using errcode = '42501';
  end if;
  select activated_at into v_activation from public.workspace_onboarding where workspace_id = p_workspace_id;
  select * into v_subscription from public.workspace_subscriptions where workspace_id = p_workspace_id;
  return jsonb_build_object(
    'workspaceId', p_workspace_id,
    'serverNow', v_now,
    'activatedAt', v_activation,
    'subscription', case when found then jsonb_build_object(
      'plan', v_subscription.plan, 'status', v_subscription.status,
      'trialStartedAt', v_subscription.trial_started_at, 'trialEndsAt', v_subscription.trial_ends_at,
      'currentPeriodStart', v_subscription.current_period_start,
      'currentPeriodEnd', v_subscription.current_period_end,
      'cancelAtPeriodEnd', v_subscription.cancel_at_period_end,
      'hasDodoCustomer', v_subscription.dodo_customer_id is not null,
      'updatedAt', v_subscription.updated_at
    ) else null end
  );
end;
$$;

create function public.get_workspace_billing_snapshot_service(p_workspace_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'workspaceId', p_workspace_id,
    'serverNow', now(),
    'activatedAt', (select onboarding.activated_at from public.workspace_onboarding onboarding where onboarding.workspace_id=p_workspace_id),
    'subscription', case when subscription.workspace_id is null then null else jsonb_build_object(
      'plan', subscription.plan, 'status', subscription.status,
      'trialStartedAt', subscription.trial_started_at, 'trialEndsAt', subscription.trial_ends_at,
      'currentPeriodStart', subscription.current_period_start,
      'currentPeriodEnd', subscription.current_period_end,
      'cancelAtPeriodEnd', subscription.cancel_at_period_end,
      'hasDodoCustomer', subscription.dodo_customer_id is not null,
      'updatedAt', subscription.updated_at
    ) end
  )
  from (select 1) singleton
  left join public.workspace_subscriptions subscription on subscription.workspace_id = p_workspace_id
$$;

create function public.process_dodo_subscription_event(
  p_event_id text,
  p_event_type text,
  p_customer_id text,
  p_subscription_id text,
  p_product_id text,
  p_plan text,
  p_status text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_event_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v_workspace_id uuid; v_current public.workspace_subscriptions%rowtype; v_receipt_id uuid;
begin
  if p_event_id is null or char_length(p_event_id) not between 1 and 200
    or p_event_type is null or char_length(p_event_type) not between 1 and 100 then
    raise exception 'Invalid Dodo event envelope' using errcode = '22023';
  end if;
  insert into public.billing_webhook_events (external_event_id,event_type,provider_event_at)
    values (p_event_id,p_event_type,p_event_at)
    on conflict (external_event_id) do nothing returning id into v_receipt_id;
  if v_receipt_id is null then return 'duplicate'; end if;

  if p_plan is null or p_plan not in ('core','pro','business') or p_product_id is null then
    update public.billing_webhook_events set status='ignored',error_category='unknown_product',processed_at=now()
      where id=v_receipt_id;
    return 'ignored';
  end if;
  if p_status is null or p_status not in ('active','past_due','on_hold','cancelled','expired')
    or p_customer_id is null or p_subscription_id is null then
    update public.billing_webhook_events set status='ignored',error_category='unsupported_lifecycle',processed_at=now()
      where id=v_receipt_id;
    return 'ignored';
  end if;
  select workspace_id into v_workspace_id from public.workspace_subscriptions
    where dodo_customer_id=p_customer_id for update;
  if v_workspace_id is null then
    update public.billing_webhook_events set status='ignored',error_category='customer_unmapped',processed_at=now()
      where id=v_receipt_id;
    return 'ignored';
  end if;
  select * into v_current from public.workspace_subscriptions where workspace_id=v_workspace_id for update;
  if v_current.dodo_subscription_id is not null and v_current.dodo_subscription_id <> p_subscription_id
    and v_current.status not in ('trialing','cancelled','expired') then
    update public.billing_webhook_events set status='ignored',error_category='subscription_mismatch',processed_at=now()
      where id=v_receipt_id;
    return 'ignored';
  end if;
  if v_current.provider_event_at is not null and p_event_at is not null
    and p_event_at < v_current.provider_event_at then
    update public.billing_webhook_events set status='stale',processed_at=now()
      where id=v_receipt_id;
    return 'stale';
  end if;

  update public.workspace_subscriptions set
    plan=p_plan, status=p_status, dodo_subscription_id=p_subscription_id, dodo_product_id=p_product_id,
    current_period_start=p_period_start, current_period_end=p_period_end,
    cancel_at_period_end=coalesce(p_cancel_at_period_end,false), provider_event_at=p_event_at
  where workspace_id=v_workspace_id;
  update public.billing_webhook_events set status='processed',processed_at=now()
    where id=v_receipt_id;
  return 'processed';
end;
$$;

revoke all on function public.attach_workspace_dodo_customer(uuid,text) from public, anon;
revoke all on function public.get_workspace_billing_snapshot(uuid) from public, anon;
revoke all on function public.get_workspace_billing_snapshot_service(uuid) from public, anon, authenticated;
revoke all on function public.process_dodo_subscription_event(text,text,text,text,text,text,text,timestamptz,timestamptz,boolean,timestamptz) from public, anon, authenticated;
grant execute on function public.attach_workspace_dodo_customer(uuid,text) to authenticated;
grant execute on function public.get_workspace_billing_snapshot(uuid) to authenticated;
grant execute on function public.get_workspace_billing_snapshot_service(uuid) to service_role;
grant execute on function public.process_dodo_subscription_event(text,text,text,text,text,text,text,timestamptz,timestamptz,boolean,timestamptz) to service_role;

-- Quota plan resolution is kept in the database for atomic write-side enforcement.
create function private.workspace_quota_plan(p_workspace_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when subscription.status='trialing' and subscription.plan='pro'
      and subscription.trial_started_at<=now() and subscription.trial_ends_at>now() then 'pro'
    when subscription.status='active' and subscription.plan in ('core','pro','business')
      and subscription.current_period_end>now() then subscription.plan
    when subscription.status='past_due' and subscription.plan in ('core','pro','business')
      and subscription.current_period_end>now()-interval '7 days' then subscription.plan
    when subscription.workspace_id is null and coalesce(onboarding.state,'')<>'active' then 'pro'
    else null
  end
  from (select 1) singleton
  left join public.workspace_subscriptions subscription on subscription.workspace_id=p_workspace_id
  left join public.workspace_onboarding onboarding on onboarding.workspace_id=p_workspace_id
$$;
revoke all on function private.workspace_quota_plan(uuid) from public, anon, authenticated;
grant execute on function private.workspace_quota_plan(uuid) to service_role;

create function private.workspace_dependency_limit(p_workspace_id uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select case private.workspace_quota_plan(p_workspace_id)
    when 'core' then 20 when 'pro' then 75 when 'business' then 250 else 0 end
$$;
revoke all on function private.workspace_dependency_limit(uuid) from public, anon, authenticated;
grant execute on function private.workspace_dependency_limit(uuid) to service_role;

create function private.workspace_repository_limit(p_workspace_id uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select case private.workspace_quota_plan(p_workspace_id)
    when 'pro' then 25 when 'business' then 100 else 0 end
$$;
revoke all on function private.workspace_repository_limit(uuid) from public, anon, authenticated;
grant execute on function private.workspace_repository_limit(uuid) to service_role;

create function private.enforce_workspace_dependency_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare dependency_limit integer;
begin
  if exists (select 1 from public.workspace_dependencies existing
    where existing.workspace_id=new.workspace_id and existing.dependency_id=new.dependency_id) then
    return new;
  end if;
  dependency_limit := private.workspace_dependency_limit(new.workspace_id);
  if dependency_limit=0 then raise exception 'paid_plan_required' using errcode='42501'; end if;
  if (select count(*) from public.workspace_dependencies existing where existing.workspace_id=new.workspace_id) >= dependency_limit then
    raise exception 'dependency_quota_exceeded' using errcode='22023';
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_workspace_dependency_limit() from public, anon, authenticated;
create trigger workspace_dependencies_enforce_plan_limit before insert on public.workspace_dependencies
  for each row execute function private.enforce_workspace_dependency_limit();

-- Execution entitlement is checked at enqueue, dispatch, claim, and result persistence.
-- This intentionally excludes past-due grace: grace permits read access only.
create function private.workspace_can_run_preflight(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_subscriptions subscription
    where subscription.workspace_id = p_workspace_id
      and (
        (subscription.status = 'trialing' and subscription.plan = 'pro'
          and subscription.trial_started_at <= now() and subscription.trial_ends_at > now())
        or (subscription.status = 'active' and subscription.plan in ('pro','business')
          and subscription.current_period_end > now())
      )
      and (select count(*) from public.preflight_runs run
        where run.workspace_id=subscription.workspace_id
          and run.created_at >= coalesce(subscription.current_period_start,subscription.trial_started_at,date_trunc('month',now())))
        <= case subscription.plan when 'pro' then 500 when 'business' then 5000 else 0 end
  )
$$;
revoke all on function private.workspace_can_run_preflight(uuid) from public, anon, authenticated;
grant execute on function private.workspace_can_run_preflight(uuid) to service_role;

create or replace function private.enqueue_eligible_preflight()
returns trigger language plpgsql security definer set search_path = '' as $$
declare repo_fingerprint text;
begin
  if new.status <> 'assessed' or new.relevant is distinct from true
    or not private.workspace_can_run_preflight(new.workspace_id) then return new; end if;
  if not exists (
    select 1 from public.source_change_classifications classification
    where classification.id=new.source_change_classification_id and classification.status='classified' and classification.material=true
  ) then return new; end if;
  if not exists (
    select 1 from public.workspace_repository_access access
    join public.repositories repo on repo.id=access.repository_id and repo.workspace_id=access.workspace_id
    join public.repository_connections connection on connection.id=repo.connection_id and connection.workspace_id=repo.workspace_id
    where access.workspace_id=new.workspace_id and access.workspace_dependency_id=new.workspace_dependency_id
      and repo.selected_for_protection and repo.status='available' and connection.status='connected'
  ) then return new; end if;
  select md5(coalesce(string_agg(access.repository_id::text,',' order by access.repository_id),'') || 'preflight') || md5('preflight' || coalesce(string_agg(access.repository_id::text,',' order by access.repository_id),'')) into repo_fingerprint
  from public.workspace_repository_access access
  join public.repositories repo on repo.id=access.repository_id and repo.workspace_id=access.workspace_id and repo.selected_for_protection and repo.status='available'
  join public.repository_connections connection on connection.id=repo.connection_id and connection.workspace_id=repo.workspace_id and connection.status='connected'
  where access.workspace_id=new.workspace_id and access.workspace_dependency_id=new.workspace_dependency_id;
  insert into public.preflight_dispatch_queue (workspace_id,impact_assessment_id,repository_set_fingerprint)
  values (new.workspace_id,new.id,repo_fingerprint) on conflict (impact_assessment_id,repository_set_fingerprint) do nothing;
  return new;
end;
$$;

create or replace function private.enqueue_preflight_for_access()
returns trigger language plpgsql security definer set search_path = '' as $$
declare assessment_row record; repo_fingerprint text;
begin
  if not private.workspace_can_run_preflight(new.workspace_id) then return new; end if;
  select md5(coalesce(string_agg(access.repository_id::text,',' order by access.repository_id),'') || 'preflight') || md5('preflight' || coalesce(string_agg(access.repository_id::text,',' order by access.repository_id),'')) into repo_fingerprint
  from public.workspace_repository_access access
  join public.repositories repo on repo.id=access.repository_id and repo.workspace_id=access.workspace_id and repo.selected_for_protection and repo.status='available'
  join public.repository_connections connection on connection.id=repo.connection_id and connection.workspace_id=repo.workspace_id and connection.status='connected'
  where access.workspace_id=new.workspace_id and access.workspace_dependency_id=new.workspace_dependency_id;
  for assessment_row in
    select assessment.id,assessment.workspace_id from public.impact_assessments assessment
    join public.source_change_classifications classification on classification.id=assessment.source_change_classification_id and classification.status='classified' and classification.material
    where assessment.workspace_id=new.workspace_id and assessment.workspace_dependency_id=new.workspace_dependency_id
      and assessment.status='assessed' and assessment.relevant
  loop
    insert into public.preflight_dispatch_queue (workspace_id,impact_assessment_id,repository_set_fingerprint)
    values (assessment_row.workspace_id,assessment_row.id,repo_fingerprint)
    on conflict (impact_assessment_id,repository_set_fingerprint) do nothing;
  end loop;
  return new;
end;
$$;

create or replace function public.list_preflight_dispatch_queue(p_limit integer default 100)
returns table(queue_id uuid,workspace_id uuid,impact_assessment_id uuid)
language sql security invoker set search_path = '' as $$
  select queue.id,queue.workspace_id,queue.impact_assessment_id from public.preflight_dispatch_queue queue
  where queue.attempt_count<6 and private.workspace_can_run_preflight(queue.workspace_id)
    and (queue.status in ('queued','failed') or (queue.status='dispatched' and queue.updated_at<now()-interval '15 minutes'))
  order by queue.created_at,queue.id limit least(greatest(coalesce(p_limit,1),1),100);
$$;

drop function public.claim_preflight_run(uuid);
create function public.claim_preflight_run(p_run_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare claim_token uuid := gen_random_uuid();
begin
  update public.preflight_runs run set status='running',started_at=now(),run_lease_until=now()+interval '15 minutes',run_claim_token=claim_token,error_category=null
  where run.id=p_run_id and private.workspace_can_run_preflight(run.workspace_id)
    and (run.status in ('queued','failed') or (run.status='running' and (run.run_lease_until is null or run.run_lease_until<now())));
  if not found then return null; end if;
  return claim_token;
end;
$$;

drop function public.mark_preflight_dispatch(uuid,text,text);
create function public.mark_preflight_dispatch(p_queue_id uuid,p_status text,p_error_category text default null)
returns integer language plpgsql security invoker set search_path = '' as $$
declare resulting_attempt integer; workspace_id uuid;
begin
  if p_status not in ('dispatched','complete','failed','superseded') then raise exception 'invalid_preflight_queue_status' using errcode='22023'; end if;
  if p_status='dispatched' then
    select queue.workspace_id into workspace_id from public.preflight_dispatch_queue queue where queue.id=p_queue_id;
    if workspace_id is null then raise exception 'preflight_queue_not_found' using errcode='P0002'; end if;
    if not private.workspace_can_run_preflight(workspace_id) then
      update public.preflight_dispatch_queue set status='superseded',error_category=null
        where id=p_queue_id and status in ('queued','failed');
      return -1;
    end if;
  end if;
  update public.preflight_dispatch_queue set status=p_status,
    attempt_count=attempt_count+case when p_status='dispatched' then 1 else 0 end,
    error_category=case when p_status='failed' then left(coalesce(p_error_category,'preflight_failed'),80) else null end
  where id=p_queue_id and (
    (p_status='dispatched' and attempt_count<6 and (status in ('queued','failed') or (status='dispatched' and updated_at<now()-interval '15 minutes')))
    or (p_status<>'dispatched' and status in ('queued','dispatched','failed'))
  ) returning attempt_count into resulting_attempt;
  if not found then raise exception 'preflight queue item is no longer current' using errcode='40001'; end if;
  return resulting_attempt;
end;
$$;

create or replace function public.save_preflight_result(p_run_id uuid,p_claim_token uuid,p_repository_ids uuid[],p_result jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare run_row public.preflight_runs%rowtype; finding jsonb; dependency_id uuid;
begin
  select * into run_row from public.preflight_runs where id=p_run_id and status='running' and run_claim_token=p_claim_token and run_lease_until>now() for update;
  if not found then raise exception 'preflight_run_not_running' using errcode='40001'; end if;
  if not private.workspace_can_run_preflight(run_row.workspace_id) then
    raise exception 'preflight_entitlement_required' using errcode='42501';
  end if;
  select assessment.workspace_dependency_id into dependency_id from public.impact_assessments assessment
    where assessment.id=run_row.impact_assessment_id and assessment.workspace_id=run_row.workspace_id;
  if dependency_id is null or p_repository_ids is null or cardinality(p_repository_ids)>5
    or cardinality(p_repository_ids)<>(select count(distinct id) from unnest(p_repository_ids) id)
    or cardinality(p_repository_ids)<>(
      select count(*) from unnest(p_repository_ids) expected(id)
      join public.workspace_repository_access access on access.repository_id=expected.id and access.workspace_id=run_row.workspace_id and access.workspace_dependency_id=dependency_id
      join public.repositories repo on repo.id=expected.id and repo.workspace_id=run_row.workspace_id and repo.selected_for_protection and repo.status='available'
      join public.repository_connections connection on connection.id=repo.connection_id and connection.workspace_id=run_row.workspace_id and connection.status='connected'
    ) then raise exception 'preflight_repository_access_revoked' using errcode='42501'; end if;
  if jsonb_typeof(p_result)<>'object' or jsonb_typeof(p_result->'findings')<>'array'
    or jsonb_array_length(p_result->'findings')>200
    or p_result->>'status' not in ('completed','partial')
    or p_result->>'verifiedImpact' not in ('verified','likely','not_found','inconclusive') then
    raise exception 'invalid_preflight_result' using errcode='22023';
  end if;
  for finding in select value from jsonb_array_elements(p_result->'findings') loop
    if not ((finding->>'repositoryId')::uuid=any(p_repository_ids)) then raise exception 'preflight_finding_repository_mismatch' using errcode='42501'; end if;
    insert into public.preflight_findings (workspace_id,preflight_run_id,repository_id,commit_sha,file_path,line_start,line_end,finding_type,affected_entity,confidence,verification,explanation,evidence_fingerprint)
    values (run_row.workspace_id,p_run_id,(finding->>'repositoryId')::uuid,finding->>'commitSha',finding->>'path',
      (finding->>'lineStart')::integer,(finding->>'lineEnd')::integer,finding->>'findingType',finding->>'affectedEntity',
      (finding->>'confidence')::numeric,finding->>'verification',finding->>'explanation',finding->>'evidenceFingerprint')
    on conflict (preflight_run_id,repository_id,commit_sha,file_path,evidence_fingerprint) do nothing;
  end loop;
  update public.preflight_runs set status=p_result->>'status',verified_impact=p_result->>'verifiedImpact',
    confidence=(p_result->>'confidence')::numeric,complexity=p_result->>'complexity',
    recommended_remediation=p_result->>'recommendedRemediation',effective_at=nullif(p_result->>'effectiveAt','')::timestamptz,
    announced_at=nullif(p_result->>'announcedAt','')::timestamptz,deadline=nullif(p_result->>'deadline','')::timestamptz,
    days_remaining=nullif(p_result->>'daysRemaining','')::integer,repositories_scanned=(p_result->>'repositoriesScanned')::integer,
    completed_at=now(),run_lease_until=null,run_claim_token=null,error_category=null
  where id=p_run_id;
end;
$$;

revoke all on function public.save_preflight_result(uuid,uuid,uuid[],jsonb) from public,anon,authenticated;
grant execute on function public.save_preflight_result(uuid,uuid,uuid[],jsonb) to service_role;

create function private.enforce_remediation_quota()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_plan text; v_period_start timestamptz; v_limit integer;
begin
  if exists (select 1 from public.remediation_proposals proposal
    where proposal.preflight_run_id=new.preflight_run_id
      and proposal.proposal_fingerprint=new.proposal_fingerprint) then
    return new;
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
  if not found then raise exception 'pro_plan_required' using errcode='42501'; end if;
  v_limit := case v_plan when 'pro' then 30 when 'business' then 500 else 0 end;
  if (select count(*) from public.remediation_proposals proposal
      where proposal.workspace_id=new.workspace_id and proposal.created_at>=v_period_start) >= v_limit then
    raise exception 'remediation_quota_exceeded' using errcode='22023';
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_remediation_quota() from public,anon,authenticated;
create trigger remediation_proposals_enforce_plan_quota before insert on public.remediation_proposals
  for each row execute function private.enforce_remediation_quota();

create or replace function public.set_repository_protection(
  p_repository_id uuid,p_selected boolean,p_dependency_ids uuid[]
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare repository_row public.repositories%rowtype; actor_id uuid := auth.uid(); dependency_count integer;
begin
  if actor_id is null or p_selected is null or p_dependency_ids is null or cardinality(p_dependency_ids)>50
    or (p_selected and cardinality(p_dependency_ids)=0) or (not p_selected and cardinality(p_dependency_ids)>0) then
    raise exception 'invalid_repository_selection' using errcode='22023';
  end if;
  select * into repository_row from public.repositories where id=p_repository_id for update;
  if not found then raise exception 'repository_not_found' using errcode='P0002'; end if;
  if not exists(select 1 from public.workspace_members where workspace_id=repository_row.workspace_id and user_id=actor_id and role in ('owner','admin')) then
    raise exception 'forbidden' using errcode='42501';
  end if;
  if p_selected and not private.workspace_can_run_preflight(repository_row.workspace_id) then
    raise exception 'pro_plan_required' using errcode='42501';
  end if;
  if p_selected and (select count(*) from public.repositories existing
      where existing.workspace_id=repository_row.workspace_id and existing.selected_for_protection and existing.id<>p_repository_id)
      >= private.workspace_repository_limit(repository_row.workspace_id) then
    raise exception 'repository_quota_exceeded' using errcode='22023';
  end if;
  if p_selected and (repository_row.status<>'available' or (select connection.status from public.repository_connections connection where connection.id=repository_row.connection_id)<>'connected') then
    raise exception 'repository_unavailable' using errcode='22023';
  end if;
  select count(distinct dependency_id)::integer into dependency_count from unnest(p_dependency_ids) dependency_id;
  if dependency_count<>cardinality(p_dependency_ids) then raise exception 'duplicate_dependency' using errcode='22023'; end if;
  if dependency_count>0 and dependency_count<>(select count(*) from public.workspace_dependencies dependency where dependency.workspace_id=repository_row.workspace_id and dependency.id=any(p_dependency_ids)) then
    raise exception 'dependency_not_found' using errcode='P0002';
  end if;
  delete from public.workspace_repository_access where repository_id=p_repository_id and workspace_id=repository_row.workspace_id;
  update public.repositories set selected_for_protection=p_selected where id=p_repository_id;
  if p_selected then
    insert into public.workspace_repository_access (workspace_id,workspace_dependency_id,repository_id)
    select repository_row.workspace_id,dependency_id,p_repository_id from unnest(p_dependency_ids) dependency_id;
  end if;
  return jsonb_build_object('repositoryId',p_repository_id,'selectedForProtection',p_selected,'dependencyCount',dependency_count);
end;
$$;

revoke all on function public.claim_preflight_run(uuid) from public, anon, authenticated;
grant execute on function public.claim_preflight_run(uuid) to service_role;
