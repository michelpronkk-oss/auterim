-- Keep saved partial discovery outcomes consistent across persistence and signup resume.


update public.dependency_discovery_runs
set coverage = jsonb_build_object('outcome', case
  when status = 'completed' and candidate_count = 0 then 'empty'
  when status = 'completed' then 'complete'
  when status = 'partial' then 'partial'
  else 'failed'
end)
where status in ('completed','partial','failed') and not (coverage ? 'outcome');

alter table public.dependency_discovery_runs
  add constraint dependency_discovery_runs_status_outcome_check check (
    (status = 'running' and coverage->>'outcome' is null)
    or (status = 'completed' and (
      (coverage->>'outcome' = 'complete' and candidate_count > 0)
      or (coverage->>'outcome' = 'empty' and candidate_count = 0)
    ))
    or (status = 'partial' and coverage->>'outcome' = 'partial')
    or (status = 'failed' and coverage->>'outcome' = 'failed')
  );

create or replace function public.fail_url_dependency_discovery_run(
  p_run_id uuid,
  p_workspace_id uuid,
  p_error_category text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_error_category is null or p_error_category !~ '^[a-z_]{1,80}$' then
    raise exception 'Discovery failure category is invalid' using errcode = '22023';
  end if;
  update public.dependency_discovery_runs
  set status = 'failed', error_category = p_error_category,
      coverage = jsonb_build_object('outcome','failed'), finished_at = now()
  where id = p_run_id and workspace_id = p_workspace_id and status = 'running';
end;
$$;
create or replace function public.start_workspace_onboarding(
  p_actor_user_id uuid,
  p_workspace_name text,
  p_company_name text,
  p_website_url text,
  p_website_domain text,
  p_idempotency_key text,
  p_workspace_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := p_actor_user_id;
  v_workspace_id uuid := p_workspace_id;
  v_company_id uuid;
  v_state text;
  v_fingerprint text;
  v_existing public.onboarding_requests%rowtype;
  v_slug text;
  v_discovery_status text;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_workspace_name is null or char_length(btrim(p_workspace_name)) not between 1 and 120
    or p_company_name is null or char_length(btrim(p_company_name)) not between 1 and 160
    or p_website_url is null or p_website_url !~ '^https?://[^/?#]+/$'
    or p_website_domain is null or p_website_domain !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
    or p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 128 then
    raise exception 'Onboarding company input is invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':' || p_idempotency_key, 0));
  v_fingerprint := md5(concat_ws('|', coalesce(p_workspace_id::text, ''), lower(btrim(p_workspace_name)),
    lower(btrim(p_company_name)), lower(btrim(p_website_url)), lower(btrim(p_website_domain))));
  select * into v_existing from public.onboarding_requests
  where user_id = v_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.input_fingerprint <> v_fingerprint then
      raise exception 'Idempotency key was used with different onboarding input' using errcode = '22023';
    end if;
    select state into v_state from public.workspace_onboarding where workspace_id = v_existing.workspace_id;
    return jsonb_build_object('workspaceId', v_existing.workspace_id, 'companyId', v_existing.company_id,
      'state', v_state, 'replayed', true);
  end if;

  if v_workspace_id is null then
    insert into public.workspaces (name,created_by) values (btrim(p_workspace_name),v_user_id)
    returning id into v_workspace_id;
    insert into public.workspace_members (workspace_id,user_id,role)
    values (v_workspace_id,v_user_id,'owner');
  elsif not exists (
    select 1 from public.workspace_members where workspace_id = v_workspace_id
      and user_id = v_user_id and role in ('owner', 'admin')
  ) then
    raise exception 'Owner or admin permission is required to start onboarding in an existing workspace'
      using errcode = '42501';
  end if;

  v_slug := left(regexp_replace(lower(p_website_domain), '[^a-z0-9]+', '-', 'g'), 70)
    || '-' || substr(md5(lower(p_website_domain)), 1, 8);
  insert into public.companies (workspace_id, name, slug, website_url, website_domain)
  values (v_workspace_id, btrim(p_company_name), v_slug, p_website_url, lower(p_website_domain))
  on conflict (workspace_id, website_domain) where website_domain is not null
  do nothing
  returning id into v_company_id;
  if v_company_id is null then
    select id into v_company_id from public.companies
    where workspace_id=v_workspace_id and website_domain=lower(p_website_domain);
  end if;

  select run.status into v_discovery_status
  from public.dependency_discovery_runs run
  where run.workspace_id = v_workspace_id and run.company_id = v_company_id
  order by run.started_at desc, run.id desc limit 1;
  v_state := case v_discovery_status
    when 'completed' then 'dependencies_review'
    when 'partial' then 'dependencies_review'
    when 'running' then 'discovery_running'
    else 'company_created'
  end;

  insert into public.workspace_onboarding (workspace_id, company_id, state)
  values (v_workspace_id, v_company_id, v_state)
  on conflict (workspace_id) do nothing;
  if not exists (select 1 from public.workspace_onboarding
    where workspace_id = v_workspace_id and company_id = v_company_id) then
    raise exception 'Workspace already has a different onboarding company' using errcode = '23505';
  end if;
  select state into v_state from public.workspace_onboarding where workspace_id=v_workspace_id;
  insert into public.workspace_notification_preferences (workspace_id)
  values (v_workspace_id) on conflict (workspace_id) do nothing;
  insert into public.onboarding_requests (user_id, idempotency_key, input_fingerprint, workspace_id, company_id)
  values (v_user_id, p_idempotency_key, v_fingerprint, v_workspace_id, v_company_id);

  return jsonb_build_object('workspaceId', v_workspace_id, 'companyId', v_company_id,
    'state', v_state, 'replayed', false);
end;
$$;
