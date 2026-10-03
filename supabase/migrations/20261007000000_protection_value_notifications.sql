-- Auterim Milestone 9: evidence-backed protection read models and durable notifications.

alter table public.workspace_notification_preferences
  add column in_app_enabled boolean not null default true,
  add column email_enabled boolean not null default false;

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  notification_type text not null check (notification_type in (
    'customer_relevant_change','verified_preflight_risk','deadline_approaching',
    'remediation_ready','draft_pr_prepared','repository_access_broken','coverage_problem'
  )),
  priority text not null check (priority in ('critical','high','normal')),
  title text not null check (octet_length(title) between 1 and 180),
  summary text not null check (octet_length(summary) between 1 and 600),
  related_dependency_id uuid,
  related_impact_assessment_id uuid,
  related_preflight_run_id uuid,
  related_event_id uuid references public.protection_value_events(id) on delete set null,
  dedupe_key text not null check (octet_length(dedupe_key) between 1 and 200),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  resolved_at timestamptz,
  constraint notifications_workspace_dedupe_key unique (workspace_id,dedupe_key),
  constraint notifications_dependency_workspace_fkey foreign key (related_dependency_id,workspace_id)
    references public.workspace_dependencies(id,workspace_id) on delete cascade,
  constraint notifications_impact_workspace_fkey foreign key (related_impact_assessment_id,workspace_id)
    references public.impact_assessments(id,workspace_id) on delete cascade,
  constraint notifications_preflight_workspace_fkey foreign key (related_preflight_run_id,workspace_id)
    references public.preflight_runs(id,workspace_id) on delete cascade
);
create index notifications_workspace_timeline_idx on public.notifications(workspace_id,created_at desc,id desc);
create index notifications_workspace_unread_idx on public.notifications(workspace_id,created_at desc,id desc) where read_at is null;
alter table public.notifications enable row level security;
revoke all on public.notifications from public,anon,authenticated;
grant select,update on public.notifications to authenticated;
grant all on public.notifications to service_role;
create policy notifications_member_read on public.notifications for select to authenticated
  using (exists(select 1 from public.workspace_members m where m.workspace_id=notifications.workspace_id and m.user_id=(select auth.uid())));
create policy notifications_member_mark_read on public.notifications for update to authenticated
  using (exists(select 1 from public.workspace_members m where m.workspace_id=notifications.workspace_id and m.user_id=(select auth.uid())))
  with check (exists(select 1 from public.workspace_members m where m.workspace_id=notifications.workspace_id and m.user_id=(select auth.uid())));
alter table public.notifications add constraint notifications_id_workspace_key unique(id,workspace_id);
-- Members can only change read_at; all other notification fields remain service-owned.
create function private.guard_notification_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.workspace_id,new.notification_type,new.priority,new.title,new.summary,new.related_dependency_id,
      new.related_impact_assessment_id,new.related_preflight_run_id,new.related_event_id,new.dedupe_key,new.created_at,new.resolved_at)
     is distinct from
     (old.workspace_id,old.notification_type,old.priority,old.title,old.summary,old.related_dependency_id,
      old.related_impact_assessment_id,old.related_preflight_run_id,old.related_event_id,old.dedupe_key,old.created_at,old.resolved_at) then
    raise exception 'notification fields are service managed' using errcode='42501';
  end if;
  return new;
end;
$$;
create trigger notifications_guard_update before update on public.notifications
  for each row execute function private.guard_notification_update();
revoke all on function private.guard_notification_update() from public,anon,authenticated;

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_email text not null check (octet_length(recipient_email)<=320),
  channel text not null check (channel in ('email')),
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','suppressed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  provider_message_id text check (provider_message_id is null or octet_length(provider_message_id)<=200),
  error_category text check (error_category is null or error_category ~ '^[a-z_]{1,80}$'),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint notification_delivery_recipient_key unique(notification_id,recipient_user_id,channel),
  constraint notification_delivery_workspace_fkey foreign key(notification_id,workspace_id)
    references public.notifications(id,workspace_id) on delete cascade,
  constraint notification_delivery_lease_check check ((status='sending')=(lease_until is not null))
);
create index notification_deliveries_pending_idx on public.notification_deliveries(next_attempt_at,created_at,id)
  where status in ('pending','sending') and attempt_count<5;
alter table public.notification_deliveries enable row level security;
revoke all on public.notification_deliveries from public,anon,authenticated;
grant all on public.notification_deliveries to service_role;

create function private.enqueue_notification_delivery()
returns trigger language plpgsql security definer set search_path = '' as $$
declare preference public.workspace_notification_preferences%rowtype;
begin
  select * into preference from public.workspace_notification_preferences where workspace_id=new.workspace_id;
  if not coalesce(preference.email_enabled,false) then return new; end if;
  if new.priority in ('critical','high') and preference.critical_changes='instant' then
    insert into public.notification_deliveries(notification_id,workspace_id,recipient_user_id,recipient_email,channel)
    select new.id,new.workspace_id,m.user_id,u.email,'email'
    from public.workspace_members m join auth.users u on u.id=m.user_id and u.email is not null
      and u.email_confirmed_at is not null
    where m.workspace_id=new.workspace_id and m.role in ('owner','admin')
    on conflict(notification_id,recipient_user_id,channel) do nothing;
  elsif new.priority='normal' and preference.important_changes='instant' then
    insert into public.notification_deliveries(notification_id,workspace_id,recipient_user_id,recipient_email,channel)
    select new.id,new.workspace_id,m.user_id,u.email,'email'
    from public.workspace_members m join auth.users u on u.id=m.user_id and u.email is not null
      and u.email_confirmed_at is not null
    where m.workspace_id=new.workspace_id and m.role in ('owner','admin')
    on conflict(notification_id,recipient_user_id,channel) do nothing;
  end if;
  return new;
end;
$$;
create trigger notifications_enqueue_email after insert on public.notifications
  for each row execute function private.enqueue_notification_delivery();
revoke all on function private.enqueue_notification_delivery() from public,anon,authenticated;

create function private.notify_relevant_customer_impact()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_name text; v_priority text; v_activated_at timestamptz; v_change_created_at timestamptz;
begin
  if new.status<>'assessed' or new.relevant is distinct from true
    or (tg_op='UPDATE' and (old.status='assessed' and old.relevant is true)) then return new; end if;
  select onboarding.activated_at into v_activated_at from public.workspace_onboarding onboarding
    where onboarding.workspace_id=new.workspace_id and onboarding.state='active';
  select dependency.name,change.created_at,
    case when assessment.severity in ('critical','high') and coalesce(context.criticality,'normal') in ('critical','important')
      then 'high' else 'normal' end
    into v_name,v_change_created_at,v_priority
  from public.workspace_dependencies wd
  join public.dependency_catalog dependency on dependency.id=wd.dependency_id
  left join public.dependency_context context on context.workspace_dependency_id=wd.id and context.workspace_id=wd.workspace_id
  join public.source_change_classifications classification on classification.id=new.source_change_classification_id
  join public.source_changes change on change.id=classification.change_id
  join public.source_catalog source on source.id=change.source_id and source.dependency_id=wd.dependency_id
  join public.impact_assessments assessment on assessment.id=new.id and assessment.workspace_id=wd.workspace_id
  where wd.id=new.workspace_dependency_id and wd.workspace_id=new.workspace_id
    and classification.status='classified' and classification.material=true
    and not exists(select 1 from public.source_change_classifications newer where newer.change_id=classification.change_id
      and newer.status='classified' and (newer.created_at>classification.created_at or (newer.created_at=classification.created_at and newer.id>classification.id)));
  if v_name is null or v_activated_at is null or v_change_created_at<v_activated_at then return new; end if;
  insert into public.notifications(workspace_id,notification_type,priority,title,summary,related_dependency_id,related_impact_assessment_id,dedupe_key)
  values(new.workspace_id,'customer_relevant_change',coalesce(v_priority,'normal'),left(v_name||' change may affect your stack',180),
    'A material software change was assessed as relevant to this protected dependency. Review its impact in Auterim.',
    new.workspace_dependency_id,new.id,'impact:'||new.source_change_classification_id::text)
  on conflict(workspace_id,dedupe_key) do nothing;
  return new;
end;
$$;
create trigger impact_assessments_notify_customer after insert or update of status,relevant on public.impact_assessments
  for each row execute function private.notify_relevant_customer_impact();
revoke all on function private.notify_relevant_customer_impact() from public,anon,authenticated;

create function private.notify_verified_preflight_risk()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_priority text;
begin
  if new.event_kind<>'verified_risk_found' then return new; end if;
  if not exists(select 1 from public.workspace_subscriptions s where s.workspace_id=new.workspace_id
    and s.plan in ('pro','business') and s.status in ('trialing','active')) then return new; end if;
  select case when coalesce(context.production_critical,false) and context.criticality='critical' then 'critical' else 'high' end
    into v_priority from public.preflight_runs run
    join public.impact_assessments assessment on assessment.id=run.impact_assessment_id and assessment.workspace_id=run.workspace_id
    left join public.dependency_context context on context.workspace_dependency_id=assessment.workspace_dependency_id and context.workspace_id=assessment.workspace_id
    where run.id=new.preflight_run_id and run.workspace_id=new.workspace_id;
  insert into public.notifications(workspace_id,notification_type,priority,title,summary,related_impact_assessment_id,related_preflight_run_id,related_event_id,dedupe_key)
  values(new.workspace_id,'verified_preflight_risk',coalesce(v_priority,'high'),'Verified repository exposure found',
    'Preflight verified a repository exposure for a protected dependency. Review the findings in Auterim.',
    new.impact_assessment_id,new.preflight_run_id,new.id,'verified-risk:'||new.preflight_run_id::text)
  on conflict(workspace_id,dedupe_key) do nothing;
  return new;
end;
$$;
create trigger protection_value_events_notify_verified after insert on public.protection_value_events
  for each row execute function private.notify_verified_preflight_risk();
revoke all on function private.notify_verified_preflight_risk() from public,anon,authenticated;

create function public.create_due_deadline_notifications(p_limit integer default 100)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  insert into public.notifications(workspace_id,notification_type,priority,title,summary,related_impact_assessment_id,related_preflight_run_id,dedupe_key)
  select candidate.workspace_id,'deadline_approaching',
    case when candidate.criticality='critical' and candidate.production_critical then 'high' else 'normal' end,
    'Important software deadline approaching',
    'A relevant software change has an upcoming effective date. Review the deadline and impact in Auterim.',
    candidate.impact_assessment_id,candidate.id,
    'deadline:'||candidate.id::text||':'||candidate.reminder_day::text
  from (
    select run.id,run.workspace_id,run.impact_assessment_id,
      case when run.deadline::date-current_date<=1 then 1 else 3 end reminder_day,
      coalesce(context.criticality,'normal') criticality,coalesce(context.production_critical,false) production_critical
    from public.preflight_runs run
    join public.impact_assessments assessment on assessment.id=run.impact_assessment_id and assessment.workspace_id=run.workspace_id
      and assessment.status='assessed' and assessment.relevant=true
    left join public.dependency_context context on context.workspace_dependency_id=assessment.workspace_dependency_id and context.workspace_id=assessment.workspace_id
    join public.workspace_notification_preferences preference on preference.workspace_id=run.workspace_id
    join public.workspace_onboarding onboarding on onboarding.workspace_id=run.workspace_id and onboarding.state='active'
    where run.status in ('queued','running','completed','partial') and run.deadline::date>=current_date
      and run.deadline::date-current_date between 0 and 3
      and (run.deadline::date-current_date<=1 or run.deadline::date-current_date=3)
      and not exists(select 1 from public.notifications existing where existing.workspace_id=run.workspace_id
        and existing.dedupe_key='deadline:'||run.id::text||':'||case when run.deadline::date-current_date<=1 then '1' else '3' end)
    order by run.deadline,run.id limit least(greatest(coalesce(p_limit,1),1),100)
  ) candidate
  on conflict(workspace_id,dedupe_key) do nothing;
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;
revoke all on function public.create_due_deadline_notifications(integer) from public,anon,authenticated;
grant execute on function public.create_due_deadline_notifications(integer) to service_role;

create function public.mark_notification_read(p_workspace_id uuid,p_notification_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=auth.uid()) then
    raise exception 'Workspace is unavailable' using errcode='42501';
  end if;
  update public.notifications set read_at=coalesce(read_at,now())
    where id=p_notification_id and workspace_id=p_workspace_id;
  if not found then raise exception 'Notification was not found' using errcode='P0002'; end if;
end;
$$;

create function public.set_notification_channel_preferences(p_workspace_id uuid,p_in_app_enabled boolean,p_email_enabled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_preferences public.workspace_notification_preferences%rowtype;
begin
  if auth.uid() is null or not exists(select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=auth.uid()) then
    raise exception 'Workspace is unavailable' using errcode='42501';
  end if;
  if p_in_app_enabled is null or p_email_enabled is null then raise exception 'Invalid notification preference' using errcode='22023'; end if;
  update public.workspace_notification_preferences set in_app_enabled=p_in_app_enabled,email_enabled=p_email_enabled
    where workspace_id=p_workspace_id returning * into v_preferences;
  if not found then raise exception 'Notification preferences were not found' using errcode='P0002'; end if;
  return jsonb_build_object('inAppEnabled',v_preferences.in_app_enabled,'emailEnabled',v_preferences.email_enabled,
    'importantChanges',v_preferences.important_changes,'criticalChanges',v_preferences.critical_changes);
end;
$$;
create function public.mark_all_notifications_read(p_workspace_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare changed integer;
begin
  if auth.uid() is null or not exists(select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=auth.uid()) then
    raise exception 'Workspace is unavailable' using errcode='42501';
  end if;
  update public.notifications set read_at=now() where workspace_id=p_workspace_id and read_at is null;
  get diagnostics changed=row_count;
  return changed;
end;
$$;

create function public.get_protection_summary(p_workspace_id uuid,p_period_start timestamptz,p_period_end timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb; v_activation timestamptz; v_start timestamptz;
begin
  if auth.uid() is null or not exists(select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=auth.uid()) then
    raise exception 'Workspace is unavailable' using errcode='42501';
  end if;
  if p_period_start is null or p_period_end is null or p_period_start>=p_period_end
     or p_period_end>now()+interval '1 minute' or p_period_end-p_period_start>interval '366 days' then
    raise exception 'Invalid protection period' using errcode='22023';
  end if;
  select activated_at into v_activation from public.workspace_onboarding where workspace_id=p_workspace_id and state='active';
  v_start:=greatest(p_period_start,coalesce(v_activation,p_period_start));
  with protected_sources as (
    select distinct s.id from public.workspace_dependencies wd
    join public.source_catalog s on s.dependency_id=wd.dependency_id and s.enabled
    where wd.workspace_id=p_workspace_id and wd.monitoring_enabled
  ), metrics as (
    select
      (select count(distinct (r.source_id,r.trigger_run_id))::integer from public.scan_runs r join protected_sources ps on ps.id=r.source_id
       where r.status in ('success','unchanged','changed','not_modified') and r.finished_at>=v_start and r.finished_at<p_period_end) checks_completed,
      (select count(distinct c.id)::integer from public.source_changes c join protected_sources ps on ps.id=c.source_id
       where c.created_at>=v_start and c.created_at<p_period_end) changes_detected,
      (select count(distinct cl.id)::integer from public.source_change_classifications cl
       join public.source_changes c on c.id=cl.change_id join protected_sources ps on ps.id=c.source_id
       where cl.status='classified' and cl.created_at>=v_start and cl.created_at<p_period_end
         and cl.material=false
         and not exists(select 1 from public.source_change_classifications newer where newer.change_id=cl.change_id
           and newer.status='classified' and (newer.created_at>cl.created_at or (newer.created_at=cl.created_at and newer.id>cl.id))))
       + (select count(distinct a.source_change_classification_id)::integer from public.impact_assessments a
          where a.workspace_id=p_workspace_id and a.status='assessed' and a.relevant=false
          and a.assessed_at>=v_start and a.assessed_at<p_period_end) noise_filtered,
      (select count(distinct c.id)::integer from public.source_changes c join protected_sources ps on ps.id=c.source_id
       join public.source_change_classifications cl on cl.change_id=c.id and cl.status='classified' and cl.material=true
       where c.created_at>=v_start and c.created_at<p_period_end
         and not exists(select 1 from public.source_change_classifications newer where newer.change_id=cl.change_id
           and newer.status='classified' and (newer.created_at>cl.created_at or (newer.created_at=cl.created_at and newer.id>cl.id)))) customer_assessed,
      (select count(distinct a.source_change_classification_id)::integer from public.impact_assessments a
       join public.workspace_dependencies wd on wd.id=a.workspace_dependency_id and wd.workspace_id=a.workspace_id and wd.monitoring_enabled
       join public.source_change_classifications cl on cl.id=a.source_change_classification_id
       join public.source_changes c on c.id=cl.change_id
       where a.workspace_id=p_workspace_id and a.status='assessed' and a.relevant
       and c.created_at>=v_start and c.created_at<p_period_end
       and not exists(select 1 from public.source_change_classifications newer where newer.change_id=cl.change_id and newer.status='classified'
         and (newer.created_at>cl.created_at or (newer.created_at=cl.created_at and newer.id>cl.id)))) customer_relevant,
      (select count(*)::integer from public.protection_value_events e where e.workspace_id=p_workspace_id
       and e.event_kind='automatic_preflight_started' and e.occurred_at>=v_start and e.occurred_at<p_period_end) automatic_preflights,
      (select count(*)::integer from public.protection_value_events e where e.workspace_id=p_workspace_id
       and e.event_kind='verified_risk_found' and e.occurred_at>=v_start and e.occurred_at<p_period_end) verified_risks,
      (select count(*)::integer from public.protection_value_events e where e.workspace_id=p_workspace_id
       and e.event_kind='verified_risk_not_found' and e.occurred_at>=v_start and e.occurred_at<p_period_end) risks_not_found,
      (select count(*)::integer from public.protection_value_events e where e.workspace_id=p_workspace_id
       and e.event_kind='remediation_generated' and e.occurred_at>=v_start and e.occurred_at<p_period_end) remediations_generated,
      (select count(*)::integer from public.protection_value_events e where e.workspace_id=p_workspace_id
       and e.event_kind='draft_pr_prepared' and e.occurred_at>=v_start and e.occurred_at<p_period_end) draft_prs_prepared,
      (select count(*)::integer from public.preflight_runs r where r.workspace_id=p_workspace_id and r.status in ('completed','partial')
        and r.verified_impact='likely' and r.completed_at>=v_start and r.completed_at<p_period_end) likely_risks,
      (select count(*)::integer from public.preflight_runs r where r.workspace_id=p_workspace_id and r.status in ('completed','partial')
        and r.verified_impact='inconclusive' and r.completed_at>=v_start and r.completed_at<p_period_end) inconclusive_preflights,
      (select count(*)::integer from public.preflight_runs r where r.workspace_id=p_workspace_id and r.status in ('completed','partial')
        and r.verified_impact='verified' and r.completed_at>=v_start and r.completed_at<p_period_end) verified_preflights
  )
  select jsonb_build_object(
    'periodStart',v_start,'periodEnd',p_period_end,
    'checksCompleted',checks_completed,'changesDetected',changes_detected,
    'noiseFiltered',noise_filtered,'materialChanges',customer_assessed,
    'customerRelevantChanges',customer_relevant,'automaticPreflights',automatic_preflights,
    'verifiedRisks',verified_risks,'verifiedRiskNotFound',risks_not_found,'likelyRisks',likely_risks,
    'inconclusivePreflights',inconclusive_preflights,'remediationsGenerated',remediations_generated,
    'draftPrsPrepared',draft_prs_prepared,
    'unresolvedRisks',(select count(*)::integer from public.preflight_runs r where r.workspace_id=p_workspace_id
      and r.status in ('completed','partial') and r.verified_impact in ('verified','likely')
      and not exists(select 1 from public.preflight_runs newer where newer.impact_assessment_id=r.impact_assessment_id
        and newer.workspace_id=r.workspace_id and newer.status in ('completed','partial')
        and (newer.created_at>r.created_at or (newer.created_at=r.created_at and newer.id>r.id)))),
    'unresolvedCriticalRisks',(select count(*)::integer from public.preflight_runs r
      join public.impact_assessments a on a.id=r.impact_assessment_id and a.workspace_id=r.workspace_id
      join public.dependency_context dc on dc.workspace_dependency_id=a.workspace_dependency_id and dc.workspace_id=a.workspace_id
      where r.workspace_id=p_workspace_id and r.status in ('completed','partial') and r.verified_impact='verified'
        and dc.criticality='critical' and dc.production_critical
        and not exists(select 1 from public.preflight_runs newer where newer.impact_assessment_id=r.impact_assessment_id
          and newer.workspace_id=r.workspace_id and newer.status in ('completed','partial')
          and (newer.created_at>r.created_at or (newer.created_at=r.created_at and newer.id>r.id))))
  ) into result from metrics;
  return result;
end;
$$;

create function public.get_protection_coverage(p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or not exists(select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=auth.uid()) then
    raise exception 'Workspace is unavailable' using errcode='42501';
  end if;
  with coverage as (
    select wd.id workspace_dependency_id,wd.dependency_id,coalesce(dc.criticality,'normal') criticality,
      count(distinct source.id)::integer sources,
      count(distinct source.id) filter(where snapshot.source_id is not null)::integer with_snapshot,
      count(distinct source.id) filter(where queue.status='failed')::integer failed,
      count(distinct source.id) filter(where queue.status in ('queued','dispatching','dispatched'))::integer pending
    from public.workspace_dependencies wd
    left join public.dependency_context dc on dc.workspace_dependency_id=wd.id and dc.workspace_id=wd.workspace_id
    left join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
    left join lateral(select s.source_id from public.source_snapshots s where s.source_id=source.id order by s.created_at desc limit 1) snapshot on true
    left join public.baseline_scan_queue queue on queue.source_id=source.id
    where wd.workspace_id=p_workspace_id and wd.monitoring_enabled
    group by wd.id,wd.dependency_id,dc.criticality
  )
  select jsonb_build_object(
    'dependenciesProtected',count(*)::integer,
    'authoritativeSourcesCovered',coalesce(sum(sources),0)::integer,
    'sourcesWithBaseline',coalesce(sum(with_snapshot),0)::integer,
    'criticalDependencies',count(*) filter(where criticality='critical')::integer,
    'failedBaselineSources',coalesce(sum(failed),0)::integer,
    'pendingBaselineSources',coalesce(sum(pending),0)::integer,
    'baselineStatus',case when coalesce(sum(sources),0)=0 then 'partial'
      when sum(with_snapshot)=sum(sources) then 'ready'
      when sum(failed)>0 then 'partial' else 'in_progress' end
  ) into result from coverage;
  return result;
end;
$$;

create function public.get_dependency_source_scan_states(p_workspace_id uuid,p_source_ids uuid[])
returns table(source_id uuid,status text,finished_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=auth.uid()) then
    raise exception 'Workspace is unavailable' using errcode='42501';
  end if;
  if cardinality(p_source_ids)>500 then raise exception 'Too many sources' using errcode='22023'; end if;
  return query select requested.id,latest.status,latest.finished_at
  from unnest(coalesce(p_source_ids,'{}'::uuid[])) requested(id)
  join public.source_catalog source on source.id=requested.id and source.enabled
  join public.workspace_dependencies wd on wd.dependency_id=source.dependency_id and wd.workspace_id=p_workspace_id and wd.monitoring_enabled
  left join lateral(select run.status,run.finished_at from public.scan_runs run
    where run.source_id=source.id and run.finished_at is not null order by run.finished_at desc,run.id desc limit 1) latest on true;
end;
$$;

create function public.claim_notification_deliveries(p_limit integer default 50)
returns table(delivery_id uuid,notification_id uuid,workspace_id uuid,recipient_email text,title text,summary text,priority text,notification_type text,lease_until timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  update public.notification_deliveries d set status='suppressed',lease_until=null,error_category='recipient_or_preference_changed'
  where (d.status='pending' or (d.status='sending' and d.lease_until<now())) and not exists(
    select 1 from public.workspace_members m join auth.users u on u.id=m.user_id
    join public.workspace_notification_preferences p on p.workspace_id=m.workspace_id
    where m.workspace_id=d.workspace_id and m.user_id=d.recipient_user_id and m.role in ('owner','admin')
      and u.email=d.recipient_email and u.email_confirmed_at is not null and p.email_enabled
      and (((select n.priority from public.notifications n where n.id=d.notification_id and n.workspace_id=d.workspace_id) in ('critical','high')
        and p.critical_changes='instant')
        or ((select n.priority from public.notifications n where n.id=d.notification_id and n.workspace_id=d.workspace_id)='normal'
          and p.important_changes='instant'))
      and ((select n.notification_type from public.notifications n where n.id=d.notification_id and n.workspace_id=d.workspace_id)<>'verified_preflight_risk'
        or exists(select 1 from public.workspace_subscriptions s where s.workspace_id=d.workspace_id
          and s.plan in ('pro','business') and s.status in ('trialing','active')))
  );
  return query with picked as (
    select d.id from public.notification_deliveries d
    join public.notifications n on n.id=d.notification_id and n.workspace_id=d.workspace_id
    join public.workspace_members m on m.workspace_id=d.workspace_id and m.user_id=d.recipient_user_id and m.role in ('owner','admin')
    join auth.users u on u.id=m.user_id and u.email=d.recipient_email and u.email_confirmed_at is not null
    join public.workspace_notification_preferences p on p.workspace_id=d.workspace_id and p.email_enabled
    where d.attempt_count<5 and d.next_attempt_at<=now()
      and (d.status='pending' or (d.status='sending' and d.lease_until<now()))
      and ((n.priority in ('critical','high') and p.critical_changes='instant')
        or (n.priority='normal' and p.important_changes='instant'))
      and (n.notification_type<>'verified_preflight_risk' or exists(
        select 1 from public.workspace_subscriptions s where s.workspace_id=d.workspace_id
          and s.plan in ('pro','business') and s.status in ('trialing','active')))
    order by d.next_attempt_at,d.created_at,d.id
    for update of d skip locked limit least(greatest(coalesce(p_limit,1),1),50)
  ), claimed as (
    update public.notification_deliveries d set status='sending',attempt_count=d.attempt_count+1,lease_until=now()+interval '5 minutes',error_category=null
    from picked where d.id=picked.id returning d.*
  )
  select c.id,c.notification_id,c.workspace_id,c.recipient_email,n.title,n.summary,n.priority,n.notification_type,c.lease_until
  from claimed c join public.notifications n on n.id=c.notification_id and n.workspace_id=c.workspace_id
  join auth.users u on u.id=c.recipient_user_id;
end;
$$;

create function public.complete_notification_delivery(p_delivery_id uuid,p_lease_until timestamptz,p_provider_message_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.notification_deliveries set status='sent',sent_at=now(),lease_until=null,
    provider_message_id=left(p_provider_message_id,200),error_category=null
  where id=p_delivery_id and status='sending' and lease_until=p_lease_until;
  if not found then raise exception 'Notification delivery lease is no longer current' using errcode='40001'; end if;
end;
$$;

create function public.fail_notification_delivery(p_delivery_id uuid,p_lease_until timestamptz,p_error_category text,p_transient boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  update public.notification_deliveries set
    status=case when p_transient and attempt_count<5 then 'pending' else 'failed' end,
    next_attempt_at=case when p_transient and attempt_count<5 then now()+make_interval(mins=>least(60,5*attempt_count)) else next_attempt_at end,
    lease_until=null,error_category=left(coalesce(p_error_category,'provider_error'),80)
  where id=p_delivery_id and status='sending' and lease_until=p_lease_until returning status into v_status;
  if not found then raise exception 'Notification delivery lease is no longer current' using errcode='40001'; end if;
  return v_status;
end;
$$;

revoke all on function public.mark_notification_read(uuid,uuid) from public,anon;
revoke all on function public.mark_all_notifications_read(uuid) from public,anon;
revoke all on function public.get_protection_summary(uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.mark_notification_read(uuid,uuid) to authenticated;
revoke all on function public.set_notification_channel_preferences(uuid,boolean,boolean) from public,anon;
grant execute on function public.set_notification_channel_preferences(uuid,boolean,boolean) to authenticated;
grant execute on function public.mark_all_notifications_read(uuid) to authenticated;
grant execute on function public.get_protection_summary(uuid,timestamptz,timestamptz) to authenticated;
revoke all on function public.get_protection_coverage(uuid) from public,anon;
grant execute on function public.get_protection_coverage(uuid) to authenticated;
revoke all on function public.get_dependency_source_scan_states(uuid,uuid[]) from public,anon;
grant execute on function public.get_dependency_source_scan_states(uuid,uuid[]) to authenticated;
revoke all on function public.claim_notification_deliveries(integer) from public,anon,authenticated;
revoke all on function public.complete_notification_delivery(uuid,timestamptz,text) from public,anon,authenticated;
revoke all on function public.fail_notification_delivery(uuid,timestamptz,text,boolean) from public,anon,authenticated;
grant execute on function public.claim_notification_deliveries(integer) to service_role;
grant execute on function public.complete_notification_delivery(uuid,timestamptz,text) to service_role;
grant execute on function public.fail_notification_delivery(uuid,timestamptz,text,boolean) to service_role;

