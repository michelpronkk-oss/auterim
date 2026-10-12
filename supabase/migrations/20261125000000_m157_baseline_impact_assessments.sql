-- M15.7: explicit, bounded historical baseline assessment for newly protected dependencies.
-- Live monitoring eligibility remains anchored at protection_started_at.

alter table public.impact_assessments
  add column evaluation_mode text not null default 'live'
    check (evaluation_mode in ('live', 'baseline'));

alter table public.customer_impact_dispatch_queue
  add column evaluation_mode text not null default 'live'
    check (evaluation_mode in ('live', 'baseline'));

create index customer_impact_queue_mode_pending_idx
  on public.customer_impact_dispatch_queue (evaluation_mode, created_at, id)
  where status in ('queued', 'failed');

create function private.customer_impact_input_is_eligible(
  p_workspace_dependency_id uuid,
  p_source_change_classification_id uuid,
  p_evaluation_mode text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from public.workspace_dependencies wd
    join public.workspace_products product
      on product.id = wd.protected_product_id and product.workspace_id = wd.workspace_id
    join public.source_change_classifications classification
      on classification.id = p_source_change_classification_id
    join public.source_changes change on change.id = classification.change_id
    join public.source_catalog source
      on source.id = change.source_id and source.dependency_id = wd.dependency_id
    where wd.id = p_workspace_dependency_id
      and wd.monitoring_enabled
      and wd.protection_started_at is not null
      and source.enabled
      and (p_evaluation_mode = 'live' or product.status = 'protected')
      and classification.status = 'classified'
      and classification.material
      and classification.decision_status = 'classified'
      and not exists (
        select 1
        from public.source_change_classifications newer
        where newer.change_id = classification.change_id
          and newer.status = 'classified'
          and (newer.created_at > classification.created_at
            or (newer.created_at = classification.created_at and newer.id > classification.id))
      )
      and case p_evaluation_mode
        when 'live' then change.created_at >= wd.protection_started_at
        when 'baseline' then change.created_at >= wd.protection_started_at - interval '30 days'
          and change.created_at < wd.protection_started_at
        else false
      end
  ), false);
$$;

revoke all on function private.customer_impact_input_is_eligible(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function private.customer_impact_input_is_eligible(uuid, uuid, text)
  to service_role;

create function private.guard_customer_impact_assessment_currentness()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'assessed'
    and not private.customer_impact_input_is_eligible(
      new.workspace_dependency_id,
      new.source_change_classification_id,
      new.evaluation_mode
    ) then
    raise exception 'Customer impact input is no longer eligible' using errcode = '40001';
  end if;
  return new;
end;
$$;

create trigger impact_assessments_guard_currentness
  before update of status on public.impact_assessments
  for each row execute function private.guard_customer_impact_assessment_currentness();
revoke all on function private.guard_customer_impact_assessment_currentness()
  from public, anon, authenticated;

create function public.load_customer_impact_packet_for_mode(
  p_workspace_dependency_id uuid,
  p_source_change_classification_id uuid,
  p_evaluation_mode text default 'live'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare result jsonb;
begin
  if p_evaluation_mode not in ('live', 'baseline')
    or not private.customer_impact_input_is_eligible(
      p_workspace_dependency_id, p_source_change_classification_id, p_evaluation_mode
    ) then
    raise exception 'Eligible tenant impact input was not found' using errcode = 'P0002';
  end if;
  result := public.load_customer_impact_packet(
    p_workspace_dependency_id, p_source_change_classification_id
  );
  return jsonb_set(result, '{evaluationMode}', to_jsonb(p_evaluation_mode), true);
end;
$$;

create function public.begin_customer_impact_assessment_for_mode(
  p_workspace_dependency_id uuid,
  p_source_change_classification_id uuid,
  p_context_fingerprint text,
  p_impact_engine_version text,
  p_schema_version integer,
  p_prompt_version text,
  p_provider text,
  p_trigger_run_id text,
  p_attempt_number integer,
  p_evaluation_mode text default 'live'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare result jsonb;
begin
  if p_evaluation_mode not in ('live', 'baseline')
    or not private.customer_impact_input_is_eligible(
      p_workspace_dependency_id, p_source_change_classification_id, p_evaluation_mode
    ) then
    raise exception 'Eligible tenant impact input was not found' using errcode = 'P0002';
  end if;
  result := public.begin_customer_impact_assessment(
    p_workspace_dependency_id, p_source_change_classification_id,
    p_context_fingerprint, p_impact_engine_version, p_schema_version,
    p_prompt_version, p_provider, p_trigger_run_id, p_attempt_number
  );
  if result->>'status' = 'processing' then
    update public.impact_assessments
      set evaluation_mode = p_evaluation_mode
      where id = (result->>'id')::uuid and status = 'processing'
        and trigger_run_id = p_trigger_run_id and attempt_number = p_attempt_number;
    if not found then
      raise exception 'Impact assessment attempt is no longer current' using errcode = '40001';
    end if;
  end if;
  return result;
end;
$$;

revoke all on function public.load_customer_impact_packet_for_mode(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.begin_customer_impact_assessment_for_mode(
  uuid, uuid, text, text, integer, text, text, text, integer, text
) from public, anon, authenticated;
grant execute on function public.load_customer_impact_packet_for_mode(uuid, uuid, text)
  to service_role;
grant execute on function public.begin_customer_impact_assessment_for_mode(
  uuid, uuid, text, text, integer, text, text, text, integer, text
) to service_role;

drop function public.list_customer_impact_dispatch_queue(uuid, integer);

create function public.list_customer_impact_dispatch_queue(
  p_source_change_id uuid default null,
  p_limit integer default 100
)
returns table (
  queue_id uuid,
  workspace_dependency_id uuid,
  source_change_classification_id uuid,
  context_revision bigint,
  evaluation_mode text
)
language sql
security invoker
set search_path = ''
as $$
  select queue.id, queue.workspace_dependency_id, queue.source_change_classification_id,
    queue.context_revision, queue.evaluation_mode
  from public.customer_impact_dispatch_queue queue
  join public.source_change_classifications classification
    on classification.id = queue.source_change_classification_id
  where (p_source_change_id is null or classification.change_id = p_source_change_id)
    and private.customer_impact_input_is_eligible(
      queue.workspace_dependency_id, queue.source_change_classification_id, queue.evaluation_mode
    )
    and queue.dispatch_attempt_count < 6
    and (
      queue.status = 'queued'
      or (queue.status = 'failed' and coalesce(queue.error_category, '') <> 'permanent_configuration')
      or (queue.status = 'dispatched' and queue.updated_at < now() - interval '15 minutes')
    )
  order by queue.created_at, queue.id
  limit least(greatest(coalesce(p_limit, 1), 1), 100);
$$;

revoke all on function public.list_customer_impact_dispatch_queue(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.list_customer_impact_dispatch_queue(uuid, integer)
  to service_role;

create function public.request_product_dependency_baseline_assessment(
  p_workspace_id uuid,
  p_product_id uuid,
  p_workspace_dependency_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_protection_started_at timestamptz;
  v_candidates integer := 0;
  v_queued integer := 0;
begin
  if v_actor is null or not exists (
    select 1 from public.workspace_members member
    where member.workspace_id = p_workspace_id and member.user_id = v_actor
      and member.role in ('owner', 'admin')
  ) then
    raise exception 'owner_or_admin_required' using errcode = '42501';
  end if;

  perform 1 from public.workspace_products product
  where product.id = p_product_id and product.workspace_id = p_workspace_id
    and product.status = 'protected'
  for update;
  if not found then raise exception 'protected_product_not_found' using errcode = 'P0002'; end if;

  select dependency.protection_started_at into v_protection_started_at
  from public.workspace_dependencies dependency
  where dependency.id = p_workspace_dependency_id
    and dependency.workspace_id = p_workspace_id
    and dependency.protected_product_id = p_product_id
    and dependency.monitoring_enabled
  for update;
  if not found or v_protection_started_at is null then
    raise exception 'protected_dependency_not_found' using errcode = 'P0002';
  end if;

  select count(*)::integer into v_candidates
  from public.source_change_classifications classification
  join public.source_changes change on change.id = classification.change_id
  join public.source_catalog source on source.id = change.source_id
  join public.workspace_dependencies dependency on dependency.dependency_id = source.dependency_id
  where dependency.id = p_workspace_dependency_id
    and source.enabled
    and classification.status = 'classified'
    and classification.material
    and classification.decision_status = 'classified'
    and change.created_at >= v_protection_started_at - interval '30 days'
    and change.created_at < v_protection_started_at
    and not exists (
      select 1 from public.source_change_classifications newer
      where newer.change_id = classification.change_id and newer.status = 'classified'
        and (newer.created_at > classification.created_at
          or (newer.created_at = classification.created_at and newer.id > classification.id))
    );

  insert into public.customer_impact_dispatch_queue (
    workspace_id, workspace_dependency_id, source_change_classification_id,
    context_revision, evaluation_mode
  )
  select dependency.workspace_id, dependency.id, classification.id,
    coalesce(context.context_revision, 0), 'baseline'
  from public.source_change_classifications classification
  join public.source_changes change on change.id = classification.change_id
  join public.source_catalog source on source.id = change.source_id
  join public.workspace_dependencies dependency on dependency.dependency_id = source.dependency_id
  left join public.dependency_context context
    on context.workspace_dependency_id = dependency.id and context.workspace_id = dependency.workspace_id
  where dependency.id = p_workspace_dependency_id
    and dependency.workspace_id = p_workspace_id
    and dependency.protected_product_id = p_product_id
    and dependency.monitoring_enabled
    and source.enabled
    and classification.status = 'classified'
    and classification.material
    and classification.decision_status = 'classified'
    and change.created_at >= v_protection_started_at - interval '30 days'
    and change.created_at < v_protection_started_at
    and not exists (
      select 1 from public.source_change_classifications newer
      where newer.change_id = classification.change_id and newer.status = 'classified'
        and (newer.created_at > classification.created_at
          or (newer.created_at = classification.created_at and newer.id > classification.id))
    )
  on conflict (workspace_dependency_id, source_change_classification_id, context_revision)
    do nothing;
  get diagnostics v_queued = row_count;

  return jsonb_build_object(
    'workspaceId', p_workspace_id,
    'productId', p_product_id,
    'workspaceDependencyId', p_workspace_dependency_id,
    'evaluationMode', 'baseline',
    'lookbackDays', 30,
    'eligibleClassifications', v_candidates,
    'newlyQueued', v_queued
  );
end;
$$;

revoke all on function public.request_product_dependency_baseline_assessment(uuid, uuid, uuid)
  from public, anon;
grant execute on function public.request_product_dependency_baseline_assessment(uuid, uuid, uuid)
  to authenticated;

create or replace function private.notify_relevant_customer_impact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_priority text;
  v_activated_at timestamptz;
  v_change_created_at timestamptz;
begin
  if new.evaluation_mode <> 'live' or new.status <> 'assessed'
    or new.relevant is distinct from true
    or (tg_op = 'UPDATE' and old.status = 'assessed' and old.relevant is true) then
    return new;
  end if;
  select onboarding.activated_at into v_activated_at
  from public.workspace_onboarding onboarding
  where onboarding.workspace_id = new.workspace_id and onboarding.state = 'active';
  select dependency.name, change.created_at,
    case when assessment.severity in ('critical', 'high')
      and coalesce(context.criticality, 'normal') in ('critical', 'important')
      then 'high' else 'normal' end
  into v_name, v_change_created_at, v_priority
  from public.workspace_dependencies wd
  join public.dependency_catalog dependency on dependency.id = wd.dependency_id
  left join public.dependency_context context
    on context.workspace_dependency_id = wd.id and context.workspace_id = wd.workspace_id
  join public.source_change_classifications classification
    on classification.id = new.source_change_classification_id
  join public.source_changes change on change.id = classification.change_id
  join public.source_catalog source on source.id = change.source_id and source.dependency_id = wd.dependency_id
  join public.impact_assessments assessment on assessment.id = new.id and assessment.workspace_id = wd.workspace_id
  where wd.id = new.workspace_dependency_id and wd.workspace_id = new.workspace_id
    and classification.status = 'classified' and classification.material
    and not exists (
      select 1 from public.source_change_classifications newer
      where newer.change_id = classification.change_id and newer.status = 'classified'
        and (newer.created_at > classification.created_at
          or (newer.created_at = classification.created_at and newer.id > classification.id))
    );
  if v_name is null or v_activated_at is null or v_change_created_at < v_activated_at then return new; end if;
  insert into public.notifications(
    workspace_id, notification_type, priority, title, summary,
    related_dependency_id, related_impact_assessment_id, dedupe_key
  ) values (
    new.workspace_id, 'customer_relevant_change', coalesce(v_priority, 'normal'),
    left(v_name || ' change may affect your stack', 180),
    'A material software change was assessed as relevant to this protected dependency. Review its impact in Auterim.',
    new.workspace_dependency_id, new.id, 'impact:' || new.source_change_classification_id::text
  ) on conflict (workspace_id, dedupe_key) do nothing;
  return new;
end;
$$;

create or replace function private.notify_verified_preflight_risk()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_priority text;
  v_evaluation_mode text;
begin
  if new.event_kind <> 'verified_risk_found' then return new; end if;
  select assessment.evaluation_mode into v_evaluation_mode
  from public.preflight_runs run
  join public.impact_assessments assessment
    on assessment.id = run.impact_assessment_id and assessment.workspace_id = run.workspace_id
  where run.id = new.preflight_run_id and run.workspace_id = new.workspace_id;
  if v_evaluation_mode is distinct from 'live' then return new; end if;
  if not exists (
    select 1 from public.workspace_subscriptions subscription
    where subscription.workspace_id = new.workspace_id
      and subscription.plan in ('pro', 'business')
      and subscription.status in ('trialing', 'active')
  ) then return new; end if;
  select case when coalesce(context.production_critical, false) and context.criticality = 'critical'
    then 'critical' else 'high' end into v_priority
  from public.preflight_runs run
  join public.impact_assessments assessment
    on assessment.id = run.impact_assessment_id and assessment.workspace_id = run.workspace_id
  left join public.dependency_context context
    on context.workspace_dependency_id = assessment.workspace_dependency_id
      and context.workspace_id = assessment.workspace_id
  where run.id = new.preflight_run_id and run.workspace_id = new.workspace_id;
  insert into public.notifications(
    workspace_id, notification_type, priority, title, summary,
    related_impact_assessment_id, related_preflight_run_id, related_event_id, dedupe_key
  ) values (
    new.workspace_id, 'verified_preflight_risk', coalesce(v_priority, 'high'),
    'Verified repository exposure found',
    'Preflight verified a repository exposure for a protected dependency. Review the findings in Auterim.',
    new.impact_assessment_id, new.preflight_run_id, new.id, 'verified-risk:' || new.preflight_run_id::text
  ) on conflict (workspace_id, dedupe_key) do nothing;
  return new;
end;
$$;

create or replace function public.create_due_deadline_notifications(p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  insert into public.notifications(
    workspace_id, notification_type, priority, title, summary,
    related_impact_assessment_id, related_preflight_run_id, dedupe_key
  )
  select candidate.workspace_id, 'deadline_approaching',
    case when candidate.criticality = 'critical' and candidate.production_critical
      then 'high' else 'normal' end,
    'Important software deadline approaching',
    'A relevant software change has an upcoming effective date. Review the deadline and impact in Auterim.',
    candidate.impact_assessment_id, candidate.id,
    'deadline:' || candidate.id::text || ':' || candidate.reminder_day::text
  from (
    select run.id, run.workspace_id, run.impact_assessment_id,
      case when run.deadline::date - current_date <= 1 then 1 else 3 end reminder_day,
      coalesce(context.criticality, 'normal') criticality,
      coalesce(context.production_critical, false) production_critical
    from public.preflight_runs run
    join public.impact_assessments assessment
      on assessment.id = run.impact_assessment_id and assessment.workspace_id = run.workspace_id
      and assessment.status = 'assessed' and assessment.relevant and assessment.evaluation_mode = 'live'
    left join public.dependency_context context
      on context.workspace_dependency_id = assessment.workspace_dependency_id
        and context.workspace_id = assessment.workspace_id
    join public.workspace_notification_preferences preference
      on preference.workspace_id = run.workspace_id
    join public.workspace_onboarding onboarding
      on onboarding.workspace_id = run.workspace_id and onboarding.state = 'active'
    where run.status in ('queued', 'running', 'completed', 'partial')
      and run.deadline::date >= current_date
      and run.deadline::date - current_date between 0 and 3
      and (run.deadline::date - current_date <= 1 or run.deadline::date - current_date = 3)
      and not exists (
        select 1 from public.notifications existing
        where existing.workspace_id = run.workspace_id
          and existing.dedupe_key = 'deadline:' || run.id::text || ':'
            || case when run.deadline::date - current_date <= 1 then '1' else '3' end
      )
    order by run.deadline, run.id
    limit least(greatest(coalesce(p_limit, 1), 1), 100)
  ) candidate
  on conflict (workspace_id, dedupe_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.create_due_deadline_notifications(integer)
  from public, anon, authenticated;
grant execute on function public.create_due_deadline_notifications(integer) to service_role;

revoke all on function private.notify_relevant_customer_impact() from public, anon, authenticated;
revoke all on function private.notify_verified_preflight_risk() from public, anon, authenticated;

comment on column public.impact_assessments.evaluation_mode is
  'live follows protection_started_at; baseline is an explicit owner/admin review of material classified changes in the preceding 30 days.';
comment on column public.customer_impact_dispatch_queue.evaluation_mode is
  'Provenance for live monitoring versus an explicit bounded historical baseline review.';
