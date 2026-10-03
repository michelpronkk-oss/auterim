create function public.get_upcoming_protection_deadlines(
  p_workspace_id uuid,
  p_limit integer default 25
)
returns table(
  id uuid,
  impact_assessment_id uuid,
  deadline timestamptz,
  days_remaining integer,
  status text
)
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists(
    select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=auth.uid()
  ) then
    raise exception 'Workspace is unavailable' using errcode='42501';
  end if;
  if p_limit is null or p_limit<1 or p_limit>25 then
    raise exception 'Invalid deadline limit' using errcode='22023';
  end if;
  return query
  with latest as (
    select distinct on (run.impact_assessment_id)
      run.id,run.impact_assessment_id,run.deadline,run.days_remaining,run.status
    from public.preflight_runs run
    where run.workspace_id=p_workspace_id
    order by run.impact_assessment_id,run.created_at desc,run.id desc
  )
  select latest.id,latest.impact_assessment_id,latest.deadline,latest.days_remaining,latest.status
  from latest
  join public.impact_assessments impact on impact.id=latest.impact_assessment_id
    and impact.workspace_id=p_workspace_id and impact.status='assessed' and impact.relevant
  join public.workspace_dependencies dependency on dependency.id=impact.workspace_dependency_id
    and dependency.workspace_id=p_workspace_id and dependency.monitoring_enabled
  where latest.status in ('completed','partial')
    and latest.deadline >= date_trunc('day',now() at time zone 'utc') at time zone 'utc'
  order by latest.deadline asc,latest.id asc
  limit p_limit;
end;
$$;

revoke all on function public.get_upcoming_protection_deadlines(uuid,integer) from public,anon;
grant execute on function public.get_upcoming_protection_deadlines(uuid,integer) to authenticated;
