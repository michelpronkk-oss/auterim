-- Auterim Milestone 6: resumable onboarding and idempotent activation.

alter table public.companies
  add column website_url text,
  add column website_domain text check (
    website_domain is null or website_domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  );

create unique index companies_workspace_website_domain_key
  on public.companies (workspace_id, website_domain)
  where website_domain is not null;

alter table public.workspace_dependencies
  add column origin text not null default 'manual' check (origin in ('manual', 'discovered')),
  add column monitoring_enabled boolean not null default true,
  add column protection_started_at timestamptz;

update public.workspace_dependencies
set protection_started_at = created_at
where protection_started_at is null;

create table public.workspace_onboarding (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  company_id uuid not null,
  state text not null default 'company_created' check (state in (
    'company_created', 'discovery_running', 'dependencies_review', 'context_setup',
    'notifications_setup', 'activating', 'active'
  )),
  discovery_task_id text check (discovery_task_id is null or char_length(discovery_task_id) <= 255),
  discovery_dispatch_attempt integer not null default 0 check (discovery_dispatch_attempt between 0 and 100),
  discovery_dispatch_lease_until timestamptz,
  dependency_review_completed_at timestamptz,
  context_completed_at timestamptz,
  notifications_completed_at timestamptz,
  activated_at timestamptz,
  activated_by uuid references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_onboarding_company_workspace_fkey
    foreign key (company_id, workspace_id)
    references public.companies (id, workspace_id) on delete cascade,
  constraint workspace_onboarding_activation_check check (
    (state = 'active' and activated_at is not null and activated_by is not null)
    or (state <> 'active' and activated_at is null and activated_by is null)
  )
);

create trigger workspace_onboarding_set_updated_at
  before update on public.workspace_onboarding
  for each row execute function private.set_updated_at();

create table public.onboarding_requests (
  user_id uuid not null references auth.users (id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 128),
  input_fingerprint text not null check (input_fingerprint ~ '^[a-f0-9]{32}$'),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  company_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, idempotency_key),
  constraint onboarding_requests_company_workspace_fkey
    foreign key (company_id, workspace_id)
    references public.companies (id, workspace_id) on delete cascade
);

create table public.workspace_notification_preferences (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  critical_changes text not null default 'instant' check (critical_changes = 'instant'),
  important_changes text not null default 'daily_digest' check (
    important_changes in ('daily_digest', 'instant', 'off')
  ),
  informational text not null default 'off' check (informational in ('off', 'digest')),
  monthly_protection_report boolean not null default false,
  is_default boolean not null default true,
  completed_at timestamptz,
  updated_by uuid references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger workspace_notification_preferences_set_updated_at
  before update on public.workspace_notification_preferences
  for each row execute function private.set_updated_at();

-- One shared queue row per global source. Tenant activation never creates tenant snapshots.
create table public.baseline_scan_queue (
  source_id uuid primary key references public.source_catalog (id) on delete cascade,
  status text not null default 'queued' check (
    status in ('queued', 'dispatching', 'dispatched', 'complete', 'failed')
  ),
  dispatch_attempt integer not null default 0 check (dispatch_attempt between 0 and 100),
  dispatch_lease_until timestamptz,
  trigger_run_id text check (trigger_run_id is null or char_length(trigger_run_id) <= 255),
  error_category text check (error_category is null or error_category ~ '^[a-z_]{1,80}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint baseline_scan_queue_lease_check check (
    (status = 'dispatching' and dispatch_lease_until is not null)
    or (status <> 'dispatching' and dispatch_lease_until is null)
  )
);

create index baseline_scan_queue_dispatch_idx
  on public.baseline_scan_queue (status, created_at, source_id)
  where status in ('queued', 'failed', 'dispatching');

create trigger baseline_scan_queue_set_updated_at
  before update on public.baseline_scan_queue
  for each row execute function private.set_updated_at();

-- Candidate decisions retain the original public evidence row and add an explicit provenance link.
alter table public.discovered_dependencies
  add constraint discovered_dependencies_id_workspace_key unique (id, workspace_id);

create table public.workspace_dependency_discovery_links (
  workspace_id uuid not null,
  workspace_dependency_id uuid not null,
  discovered_dependency_id uuid not null,
  linked_by uuid not null references auth.users (id) on delete restrict,
  linked_at timestamptz not null default now(),
  primary key (workspace_dependency_id, discovered_dependency_id),
  constraint dependency_discovery_link_workspace_dependency_fkey
    foreign key (workspace_dependency_id, workspace_id)
    references public.workspace_dependencies (id, workspace_id) on delete cascade,
  constraint dependency_discovery_link_candidate_fkey
    foreign key (discovered_dependency_id, workspace_id)
    references public.discovered_dependencies (id, workspace_id) on delete restrict
);

create index workspace_dependency_discovery_links_candidate_idx
  on public.workspace_dependency_discovery_links (discovered_dependency_id, workspace_id);

alter table public.workspace_onboarding enable row level security;
alter table public.onboarding_requests enable row level security;
alter table public.workspace_notification_preferences enable row level security;
alter table public.baseline_scan_queue enable row level security;
alter table public.workspace_dependency_discovery_links enable row level security;

revoke all on public.workspace_onboarding, public.onboarding_requests,
  public.workspace_notification_preferences, public.baseline_scan_queue,
  public.workspace_dependency_discovery_links from public, anon, authenticated;
grant select on public.workspace_onboarding, public.workspace_notification_preferences,
  public.workspace_dependency_discovery_links to authenticated;
grant all on public.workspace_onboarding, public.onboarding_requests,
  public.workspace_notification_preferences, public.baseline_scan_queue,
  public.workspace_dependency_discovery_links to service_role;

create policy workspace_onboarding_select_member on public.workspace_onboarding
  for select to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member'])));
create policy workspace_notification_preferences_select_member on public.workspace_notification_preferences
  for select to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member'])));
create policy workspace_dependency_discovery_links_select_member on public.workspace_dependency_discovery_links
  for select to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member'])));

-- Existing member RLS allowed impact context reads, but only admins could write it. Onboarding
-- lets any workspace member manage context, while each row remains bound to that workspace.
drop policy dependency_context_insert_admin on public.dependency_context;
drop policy dependency_context_update_admin on public.dependency_context;
create policy dependency_context_insert_member on public.dependency_context
  for insert to authenticated
  with check ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member'])));
create policy dependency_context_update_member on public.dependency_context
  for update to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member'])))
  with check ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member'])));

-- Selections made during onboarding are not protected until activation. Preserve legacy selections.
create or replace function private.enqueue_customer_impact_for_dependency(
  p_workspace_dependency_id uuid,
  p_context_revision bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.customer_impact_dispatch_queue (
    workspace_id, workspace_dependency_id, source_change_classification_id, context_revision
  )
  select wd.workspace_id, wd.id, classification.id, p_context_revision
  from public.workspace_dependencies wd
  join public.source_catalog source on source.dependency_id = wd.dependency_id
  join public.source_changes change on change.source_id = source.id
  join public.source_change_classifications classification on classification.change_id = change.id
  where wd.id = p_workspace_dependency_id
    and wd.monitoring_enabled
    and change.created_at >= coalesce(wd.protection_started_at, wd.created_at)
    and classification.status = 'classified'
    and classification.material = true
    and classification.decision_status = 'classified'
    and not exists (
      select 1 from public.source_change_classifications newer
      where newer.change_id = classification.change_id
        and newer.status = 'classified'
        and (newer.created_at > classification.created_at
          or (newer.created_at = classification.created_at and newer.id > classification.id))
    )
  on conflict (workspace_dependency_id, source_change_classification_id, context_revision) do nothing;
end;
$$;

create or replace function private.enqueue_customer_impacts_on_classification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  context_revision_value bigint;
begin
  if new.status <> 'classified' or not new.material or new.decision_status <> 'classified' then
    return new;
  end if;

  insert into public.customer_impact_dispatch_queue (
    workspace_id, workspace_dependency_id, source_change_classification_id, context_revision
  )
  select wd.workspace_id, wd.id, new.id, coalesce(dc.context_revision, 0)
  from public.source_changes change
  join public.source_catalog source on source.id = change.source_id
  join public.workspace_dependencies wd on wd.dependency_id = source.dependency_id
  left join public.dependency_context dc on dc.workspace_dependency_id = wd.id
  where change.id = new.change_id
    and wd.monitoring_enabled
    and change.created_at >= coalesce(wd.protection_started_at, wd.created_at)
    and not exists (
      select 1 from public.source_change_classifications newer
      where newer.change_id = new.change_id
        and newer.status = 'classified'
        and (newer.created_at > new.created_at
          or (newer.created_at = new.created_at and newer.id > new.id))
    )
  on conflict (workspace_dependency_id, source_change_classification_id, context_revision) do nothing;
  return new;
end;
$$;

create function public.start_workspace_onboarding(
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

create function public.mark_onboarding_discovery_started(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_company_id uuid,
  p_trigger_task_id text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v_state text; v_run_status text;
begin
  if p_actor_user_id is null or not exists (select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = p_actor_user_id and role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode = '42501';
  end if;
  if p_trigger_task_id is null or char_length(p_trigger_task_id) not between 1 and 255 then
    raise exception 'Discovery task identity is invalid' using errcode = '22023';
  end if;
  select run.status into v_run_status from public.dependency_discovery_runs run
  where run.workspace_id = p_workspace_id and run.company_id = p_company_id
  order by run.started_at desc, run.id desc limit 1;
  update public.workspace_onboarding
  set state = case when v_run_status = 'completed' then 'dependencies_review'
      when v_run_status = 'failed' then 'company_created' else 'discovery_running' end,
      discovery_task_id = case when v_run_status in ('completed','failed') then null else p_trigger_task_id end,
      discovery_dispatch_lease_until = null
  where workspace_id = p_workspace_id and company_id = p_company_id and state in ('company_created','discovery_running')
  returning state into v_state;
  if v_state is null then
    select state into v_state from public.workspace_onboarding
    where workspace_id = p_workspace_id and company_id = p_company_id;
  end if;
  if v_state is null then raise exception 'Onboarding record was not found' using errcode = 'P0002'; end if;
  return v_state;
end;
$$;

create function public.claim_onboarding_discovery_dispatch(p_actor_user_id uuid,p_workspace_id uuid,p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_onboarding public.workspace_onboarding%rowtype;
begin
  if p_actor_user_id is null or not exists (select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=p_actor_user_id and role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode = '42501';
  end if;
  select * into v_onboarding from public.workspace_onboarding
  where workspace_id=p_workspace_id and company_id=p_company_id for update;
  if not found then raise exception 'Workspace onboarding was not found' using errcode = 'P0002'; end if;
  if v_onboarding.state='active' or v_onboarding.state in ('dependencies_review','context_setup','notifications_setup') then
    return jsonb_build_object('dispatch',false,'attempt',v_onboarding.discovery_dispatch_attempt);
  end if;
  if v_onboarding.state='discovery_running' and v_onboarding.discovery_task_id is not null then
    return jsonb_build_object('dispatch',false,'attempt',v_onboarding.discovery_dispatch_attempt);
  end if;
  if v_onboarding.state='discovery_running' and v_onboarding.discovery_dispatch_lease_until>now() then
    return jsonb_build_object('dispatch',false,'attempt',v_onboarding.discovery_dispatch_attempt);
  end if;
  if v_onboarding.discovery_dispatch_attempt >= 100 then
    raise exception 'Discovery dispatch retry limit reached' using errcode = '54000';
  end if;
  update public.workspace_onboarding
  set state='discovery_running', discovery_dispatch_attempt=discovery_dispatch_attempt+1,
      discovery_dispatch_lease_until=now()+interval '2 minutes', discovery_task_id=null
  where workspace_id=p_workspace_id
  returning discovery_dispatch_attempt into v_onboarding.discovery_dispatch_attempt;
  return jsonb_build_object('dispatch',true,'attempt',v_onboarding.discovery_dispatch_attempt);
end;
$$;

create function public.release_onboarding_discovery_dispatch(p_actor_user_id uuid,p_workspace_id uuid,p_company_id uuid,p_attempt integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_actor_user_id is null or not exists (select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=p_actor_user_id and role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode = '42501';
  end if;
  update public.workspace_onboarding set state='company_created',discovery_dispatch_lease_until=null,discovery_task_id=null
  where workspace_id=p_workspace_id and company_id=p_company_id and state='discovery_running'
    and discovery_dispatch_attempt=p_attempt and discovery_task_id is null;
end;
$$;

create function private.advance_onboarding_after_discovery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status is distinct from new.status then
    update public.workspace_onboarding
    set state = case when new.status = 'completed' then 'dependencies_review' else 'company_created' end,
        discovery_task_id = null, discovery_dispatch_lease_until = null
    where workspace_id = new.workspace_id and company_id = new.company_id
      and state = 'discovery_running';
  end if;
  return new;
end;
$$;

create trigger dependency_discovery_advance_onboarding
  after update of status on public.dependency_discovery_runs
  for each row execute function private.advance_onboarding_after_discovery();

create function public.decide_onboarding_dependency_candidate(
  p_workspace_id uuid,
  p_candidate_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_user_id uuid := (select auth.uid()); v_candidate public.discovered_dependencies%rowtype;
  v_dependency_id uuid; v_workspace_dependency_id uuid; v_origin text;
begin
  if v_user_id is null or not exists (select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = v_user_id and role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode = '42501';
  end if;
  if p_decision not in ('confirmed','rejected') then raise exception 'Decision is invalid' using errcode = '22023'; end if;
  select * into v_candidate from public.discovered_dependencies
  where id = p_candidate_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'Discovery candidate was not found' using errcode = 'P0002'; end if;
  if v_candidate.status <> 'candidate' and v_candidate.status <> p_decision then
    raise exception 'Candidate decision is already recorded' using errcode = '22023';
  end if;
  if not exists (select 1 from public.workspace_onboarding onboarding
    where onboarding.workspace_id = p_workspace_id and onboarding.company_id = v_candidate.company_id
      and onboarding.state <> 'active') then
    raise exception 'Candidate is outside active onboarding' using errcode = '42501';
  end if;
  v_dependency_id := v_candidate.dependency_id;
  if p_decision = 'rejected' then
    update public.discovered_dependencies set status='rejected'
    where id=p_candidate_id and workspace_id=p_workspace_id;
    return jsonb_build_object('candidateId',p_candidate_id,'decision','rejected','workspaceDependencyId',null);
  end if;
  insert into public.workspace_dependencies (workspace_id,dependency_id,selected_by,origin,monitoring_enabled,protection_started_at)
  values (p_workspace_id,v_dependency_id,v_user_id,'discovered',false,null)
  on conflict (workspace_id,dependency_id) do nothing;
  select id, origin into v_workspace_dependency_id, v_origin from public.workspace_dependencies
  where workspace_id=p_workspace_id and dependency_id=v_dependency_id;
  insert into public.workspace_dependency_discovery_links
    (workspace_id,workspace_dependency_id,discovered_dependency_id,linked_by)
  values (p_workspace_id,v_workspace_dependency_id,p_candidate_id,v_user_id)
  on conflict do nothing;
  update public.discovered_dependencies set status='confirmed'
  where id=p_candidate_id and workspace_id=p_workspace_id;
  return jsonb_build_object('candidateId',p_candidate_id,'decision','confirmed',
    'workspaceDependencyId',v_workspace_dependency_id,'origin',v_origin);
end;
$$;

create function public.add_onboarding_dependency_manually(p_workspace_id uuid,p_dependency_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_user_id uuid := (select auth.uid()); v_dependency_id uuid; v_workspace_dependency_id uuid;
  v_candidate record;
begin
  if v_user_id is null or not exists (select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=v_user_id and role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode = '42501';
  end if;
  if not exists (select 1 from public.workspace_onboarding
    where workspace_id=p_workspace_id and state <> 'active') then
    raise exception 'Onboarding is not available' using errcode = '42501';
  end if;
  select id into v_dependency_id from public.dependency_catalog
  where slug=lower(btrim(p_dependency_slug)) and enabled;
  if v_dependency_id is null then raise exception 'unsupported_dependency' using errcode = 'P0002'; end if;
  insert into public.workspace_dependencies (workspace_id,dependency_id,selected_by,origin,monitoring_enabled,protection_started_at)
  values (p_workspace_id,v_dependency_id,v_user_id,'manual',false,null)
  on conflict (workspace_id,dependency_id) do update set origin='manual'
  returning id into v_workspace_dependency_id;
  if v_workspace_dependency_id is null then
    select id into v_workspace_dependency_id from public.workspace_dependencies
    where workspace_id=p_workspace_id and dependency_id=v_dependency_id;
  end if;
  for v_candidate in
    select candidate.id from public.discovered_dependencies candidate
    join public.workspace_onboarding onboarding on onboarding.company_id=candidate.company_id
      and onboarding.workspace_id=candidate.workspace_id
    where candidate.workspace_id=p_workspace_id and candidate.dependency_id=v_dependency_id
      and candidate.status='candidate'
  loop
    update public.discovered_dependencies set status='confirmed'
    where id=v_candidate.id and workspace_id=p_workspace_id;
    insert into public.workspace_dependency_discovery_links
      (workspace_id,workspace_dependency_id,discovered_dependency_id,linked_by)
    values (p_workspace_id,v_workspace_dependency_id,v_candidate.id,v_user_id)
    on conflict do nothing;
  end loop;
  return jsonb_build_object('workspaceDependencyId',v_workspace_dependency_id,
    'dependencyId',v_dependency_id,'origin','manual');
end;
$$;

create function public.set_onboarding_dependency_context(
  p_workspace_id uuid,
  p_workspace_dependency_id uuid,
  p_criticality text default null,
  p_production_critical boolean default null,
  p_used_for jsonb default null,
  p_context_note text default null,
  p_usage_metadata jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_user_id uuid := (select auth.uid()); v_context public.dependency_context%rowtype;
begin
  if v_user_id is null or not exists (select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=v_user_id and role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode = '42501';
  end if;
  if not exists (select 1 from public.workspace_dependencies
    where id=p_workspace_dependency_id and workspace_id=p_workspace_id) then
    raise exception 'Workspace dependency was not found' using errcode = 'P0002';
  end if;
  if p_criticality is not null and p_criticality not in ('critical','important','normal')
    or p_used_for is not null and (jsonb_typeof(p_used_for)<>'array' or jsonb_array_length(p_used_for)>12 or octet_length(p_used_for::text)>2048)
    or p_context_note is not null and octet_length(p_context_note)>2000
    or p_usage_metadata is not null and (jsonb_typeof(p_usage_metadata)<>'object' or octet_length(p_usage_metadata::text)>4000) then
    raise exception 'Dependency context is invalid' using errcode = '22023';
  end if;
  insert into public.dependency_context (workspace_id,workspace_dependency_id,criticality,production_critical,used_for,context_note,usage_metadata)
  values (p_workspace_id,p_workspace_dependency_id,coalesce(p_criticality,'normal'),coalesce(p_production_critical,false),
    coalesce(p_used_for,'[]'::jsonb),coalesce(p_context_note,''),coalesce(p_usage_metadata,'{}'::jsonb))
  on conflict (workspace_dependency_id) do update set
    criticality=coalesce(p_criticality,dependency_context.criticality),
    production_critical=coalesce(p_production_critical,dependency_context.production_critical),
    used_for=coalesce(p_used_for,dependency_context.used_for),
    context_note=coalesce(p_context_note,dependency_context.context_note),
    usage_metadata=coalesce(p_usage_metadata,dependency_context.usage_metadata)
  returning * into v_context;
  return jsonb_build_object('workspaceId',v_context.workspace_id,'workspaceDependencyId',v_context.workspace_dependency_id,
    'criticality',v_context.criticality,'productionCritical',v_context.production_critical,'usedFor',v_context.used_for,
    'contextNote',v_context.context_note,'usageMetadata',v_context.usage_metadata,'updatedAt',v_context.updated_at);
end;
$$;

create function public.save_onboarding_notification_preferences(
  p_workspace_id uuid,
  p_important_changes text,
  p_informational text,
  p_monthly_protection_report boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_user_id uuid := (select auth.uid()); v_preferences public.workspace_notification_preferences%rowtype;
begin
  if v_user_id is null or not exists (select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=v_user_id and role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode = '42501';
  end if;
  if p_important_changes not in ('daily_digest','instant','off') or p_informational not in ('off','digest')
    or p_monthly_protection_report is null then
    raise exception 'Notification preferences are invalid' using errcode = '22023';
  end if;
  update public.workspace_notification_preferences set
    important_changes=p_important_changes, informational=p_informational,
    monthly_protection_report=p_monthly_protection_report, is_default=false,
    completed_at=coalesce(completed_at,now()), updated_by=v_user_id
  where workspace_id=p_workspace_id
  returning * into v_preferences;
  if not found then raise exception 'Workspace onboarding was not found' using errcode = 'P0002'; end if;
  update public.workspace_onboarding set notifications_completed_at=coalesce(notifications_completed_at,now())
  where workspace_id=p_workspace_id and state <> 'active';
  return jsonb_build_object('criticalChanges',v_preferences.critical_changes,
    'importantChanges',v_preferences.important_changes,'informational',v_preferences.informational,
    'monthlyProtectionReport',v_preferences.monthly_protection_report,
    'isDefault',v_preferences.is_default,'completedAt',v_preferences.completed_at);
end;
$$;

create function public.complete_onboarding_step(p_workspace_id uuid,p_step text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v_user_id uuid := (select auth.uid()); v_state text;
begin
  if v_user_id is null or not exists (select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=v_user_id and role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode = '42501';
  end if;
  select state into v_state from public.workspace_onboarding where workspace_id=p_workspace_id for update;
  if not found then raise exception 'Workspace onboarding was not found' using errcode = 'P0002'; end if;
  if v_state='active' then return v_state; end if;
  if (p_step='dependencies_review' and exists (select 1 from public.workspace_onboarding
      where workspace_id=p_workspace_id and dependency_review_completed_at is not null))
    or (p_step='context_setup' and exists (select 1 from public.workspace_onboarding
      where workspace_id=p_workspace_id and context_completed_at is not null))
    or (p_step='notifications_setup' and exists (select 1 from public.workspace_onboarding
      where workspace_id=p_workspace_id and notifications_completed_at is not null)) then
    return v_state;
  end if;
  if p_step <> v_state and not (p_step='dependencies_review' and v_state in ('company_created','discovery_running')) then
    raise exception 'Onboarding step is out of order' using errcode = '22023';
  end if;
  if p_step='dependencies_review' then
    if not exists (select 1 from public.workspace_dependencies where workspace_id=p_workspace_id) then
      raise exception 'Add or confirm at least one dependency before continuing' using errcode = '23514';
    end if;
    update public.workspace_onboarding set dependency_review_completed_at=coalesce(dependency_review_completed_at,now()), state='context_setup'
    where workspace_id=p_workspace_id returning state into v_state;
  elsif p_step='context_setup' then
    update public.workspace_onboarding set context_completed_at=coalesce(context_completed_at,now()), state='notifications_setup'
    where workspace_id=p_workspace_id returning state into v_state;
  elsif p_step='notifications_setup' then
    update public.workspace_notification_preferences set completed_at=coalesce(completed_at,now())
    where workspace_id=p_workspace_id;
    update public.workspace_onboarding set notifications_completed_at=coalesce(notifications_completed_at,now())
    where workspace_id=p_workspace_id returning state into v_state;
  else
    raise exception 'Onboarding step is invalid' using errcode = '22023';
  end if;
  return v_state;
end;
$$;

create function public.search_onboarding_dependency_catalog(p_workspace_id uuid,p_query text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_user_id uuid := (select auth.uid()); v_result jsonb;
begin
  if v_user_id is null or not exists (select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=v_user_id and role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'slug',d.slug,'name',d.name,'category',d.category,'websiteUrl',d.website_url)
    order by d.name),'[]'::jsonb) into v_result
  from (select id,slug,name,category,website_url from public.dependency_catalog
    where enabled and (coalesce(btrim(p_query),'')='' or name ilike '%'||left(btrim(p_query),80)||'%' or slug ilike '%'||left(btrim(p_query),80)||'%')
    order by name limit 25) d;
  return v_result;
end;
$$;

create table public.baseline_scan_dispatch_claims (
  id uuid primary key,
  source_id uuid not null references public.baseline_scan_queue (source_id) on delete cascade,
  dispatch_attempt integer not null check (dispatch_attempt between 1 and 100),
  created_at timestamptz not null default now(),
  unique (source_id,dispatch_attempt)
);

create function public.claim_onboarding_baseline_sources(p_actor_user_id uuid,p_workspace_id uuid,p_limit integer default 50)
returns table(queue_id uuid,source_id uuid,dispatch_attempt integer)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_actor_user_id is null or not exists (select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=p_actor_user_id and role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode = '42501';
  end if;
  if not exists (select 1 from public.workspace_onboarding where workspace_id=p_workspace_id and state='active') then
    raise exception 'Workspace protection is not active' using errcode = '42501';
  end if;
  insert into public.baseline_scan_queue (source_id)
  select distinct source.id from public.workspace_dependencies wd
  join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
  where wd.workspace_id=p_workspace_id and wd.monitoring_enabled
    and not exists (select 1 from public.source_snapshots snapshot where snapshot.source_id=source.id)
    and not exists (select 1 from public.scan_runs run where run.source_id=source.id and run.status='pending'
      and run.started_at > now()-interval '15 minutes')
  on conflict (source_id) do nothing;
  return query
  with claimable as (
    select queue.source_id from public.baseline_scan_queue queue
    join public.source_catalog source on source.id=queue.source_id and source.enabled
    join public.workspace_dependencies wd on wd.dependency_id=source.dependency_id
    where wd.workspace_id=p_workspace_id and wd.monitoring_enabled
      and (queue.status in ('queued','failed') or (queue.status='dispatching' and queue.dispatch_lease_until<now()))
    order by queue.created_at,queue.source_id
    for update of queue skip locked limit least(greatest(coalesce(p_limit,1),1),100)
  ), claimed as (
    update public.baseline_scan_queue queue set status='dispatching',dispatch_attempt=queue.dispatch_attempt+1,
      dispatch_lease_until=now()+interval '2 minutes',error_category=null
    from claimable where queue.source_id=claimable.source_id returning queue.source_id,queue.dispatch_attempt
  ), saved as (
    insert into public.baseline_scan_dispatch_claims(id,source_id,dispatch_attempt)
    select gen_random_uuid(),claimed.source_id,claimed.dispatch_attempt from claimed returning id,source_id,dispatch_attempt
  )
  select saved.id,saved.source_id,saved.dispatch_attempt from saved;
end;
$$;

alter table public.baseline_scan_dispatch_claims enable row level security;
revoke all on public.baseline_scan_dispatch_claims from public,anon,authenticated;
grant all on public.baseline_scan_dispatch_claims to service_role;

create function public.mark_onboarding_baseline_dispatched(p_actor_user_id uuid,p_workspace_id uuid,p_queue_id uuid,p_dispatch_attempt integer,p_trigger_run_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_actor_user_id is null or not exists (select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=p_actor_user_id and role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode = '42501';
  end if;
  update public.baseline_scan_queue queue
  set status='dispatched',dispatch_lease_until=null,trigger_run_id=p_trigger_run_id
  where queue.source_id=(select source_id from public.baseline_scan_dispatch_claims claim where claim.id=p_queue_id
      and claim.dispatch_attempt=p_dispatch_attempt)
    and queue.status='dispatching' and queue.dispatch_attempt=p_dispatch_attempt;
  if not found then raise exception 'Baseline claim is no longer current' using errcode = '40001'; end if;
end;
$$;

create function public.release_onboarding_baseline_claim(p_actor_user_id uuid,p_workspace_id uuid,p_queue_id uuid,p_dispatch_attempt integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_actor_user_id is null or not exists (select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=p_actor_user_id and role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode = '42501';
  end if;
  update public.baseline_scan_queue queue set status='queued',dispatch_lease_until=null,error_category='trigger_dispatch_failed'
  where queue.source_id=(select source_id from public.baseline_scan_dispatch_claims claim where claim.id=p_queue_id
      and claim.dispatch_attempt=p_dispatch_attempt)
    and queue.status='dispatching' and queue.dispatch_attempt=p_dispatch_attempt;
end;
$$;

create function private.mark_baseline_queue_from_scan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('success','unchanged','changed','not_modified') then
    update public.baseline_scan_queue set status='complete',dispatch_lease_until=null,error_category=null
    where source_id=new.source_id;
  elsif new.status='failed' then
    update public.baseline_scan_queue set status='failed',dispatch_lease_until=null,error_category=coalesce(new.error_category,'scan_failed')
    where source_id=new.source_id and status <> 'complete';
  end if;
  return new;
end;
$$;

create trigger scan_runs_update_baseline_queue
  after update of status on public.scan_runs
  for each row execute function private.mark_baseline_queue_from_scan();

create function private.mark_baseline_queue_from_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.baseline_scan_queue set status='complete',dispatch_lease_until=null,error_category=null
  where source_id=new.source_id;
  return new;
end;
$$;

create trigger source_snapshot_complete_baseline_queue
  after insert on public.source_snapshots
  for each row execute function private.mark_baseline_queue_from_snapshot();

create function public.activate_workspace_protection(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_user_id uuid := (select auth.uid()); v_onboarding public.workspace_onboarding%rowtype;
  v_activated_at timestamptz; v_dependencies integer; v_sources integer; v_critical integer; v_snapshots integer;
  v_failed integer; v_baseline_status text;
begin
  if v_user_id is null or not exists (select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=v_user_id and role in ('owner','admin')) then
    raise exception 'Owner or admin permission is required to activate protection' using errcode = '42501';
  end if;
  select * into v_onboarding from public.workspace_onboarding where workspace_id=p_workspace_id for update;
  if not found then raise exception 'Workspace onboarding was not found' using errcode = 'P0002'; end if;
  if v_onboarding.state='active' then
    v_activated_at := v_onboarding.activated_at;
  else
    if v_onboarding.state <> 'notifications_setup' or v_onboarding.dependency_review_completed_at is null
      or v_onboarding.context_completed_at is null or v_onboarding.notifications_completed_at is null then
      raise exception 'Complete onboarding steps before activating protection' using errcode = '23514';
    end if;
    if not exists (select 1 from public.workspace_dependencies where workspace_id=p_workspace_id) then
      raise exception 'Confirm or add at least one dependency before activating protection' using errcode = '23514';
    end if;
    update public.workspace_onboarding set state='activating' where workspace_id=p_workspace_id;
    v_activated_at := now();
    update public.workspace_dependencies set monitoring_enabled=true,
      protection_started_at=coalesce(protection_started_at,v_activated_at)
    where workspace_id=p_workspace_id;
    insert into public.baseline_scan_queue (source_id)
    select distinct source.id
    from public.workspace_dependencies wd
    join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
    where wd.workspace_id=p_workspace_id and wd.monitoring_enabled
      and not exists (select 1 from public.source_snapshots snapshot where snapshot.source_id=source.id)
      and not exists (select 1 from public.scan_runs run where run.source_id=source.id and run.status='pending'
        and run.started_at > now()-interval '15 minutes')
    on conflict (source_id) do nothing;
    update public.workspace_onboarding set state='active',activated_at=v_activated_at,activated_by=v_user_id
    where workspace_id=p_workspace_id;
  end if;

  select count(*)::integer into v_dependencies from public.workspace_dependencies
  where workspace_id=p_workspace_id and monitoring_enabled;
  select count(distinct source.id)::integer into v_sources
  from public.workspace_dependencies wd join public.source_catalog source on source.dependency_id=wd.dependency_id
  where wd.workspace_id=p_workspace_id and wd.monitoring_enabled and source.enabled;
  select count(*)::integer into v_critical from public.workspace_dependencies wd
  left join public.dependency_context context on context.workspace_dependency_id=wd.id
  where wd.workspace_id=p_workspace_id and wd.monitoring_enabled and coalesce(context.criticality,'normal')='critical';
  select count(distinct source.id)::integer into v_snapshots
  from public.workspace_dependencies wd join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
  join public.source_snapshots snapshot on snapshot.source_id=source.id
  where wd.workspace_id=p_workspace_id and wd.monitoring_enabled;
  select count(distinct source.id)::integer into v_failed
  from public.workspace_dependencies wd join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
  join public.baseline_scan_queue queue on queue.source_id=source.id and queue.status='failed'
  where wd.workspace_id=p_workspace_id and wd.monitoring_enabled;
  v_baseline_status := case
    when v_sources=0 then 'partial'
    when v_snapshots=v_sources then 'ready'
    when v_failed>0 then 'partial'
    else 'in_progress'
  end;
  return jsonb_build_object('workspaceId',p_workspace_id,'activatedAt',v_activated_at,
    'protection',jsonb_build_object('dependencies',v_dependencies,'authoritativeSources',v_sources,
      'criticalDependencies',v_critical,'baselineStatus',v_baseline_status));
end;
$$;

create function public.get_onboarding_status(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_user_id uuid := (select auth.uid()); v_result jsonb;
begin
  if v_user_id is null or not exists (select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=v_user_id and role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'workspaceId',onboarding.workspace_id,
    'currentStep',onboarding.state,
    'company',jsonb_build_object('id',company.id,'name',company.name,'websiteUrl',company.website_url,'websiteDomain',company.website_domain),
    'discovery',jsonb_build_object('status',latest.status,'startedAt',latest.started_at,'finishedAt',latest.finished_at,
      'candidates',coalesce((select jsonb_agg(jsonb_build_object('candidateId',candidate.id,
        'dependencyId',dependency.id,'providerName',dependency.name,'category',dependency.category,
        'confidence',candidate.confidence,'confidenceLabel',candidate.confidence_label,
        'evidenceSummary',candidate.evidence_summary,'suggestedStatus',candidate.status)
        order by dependency.name) from public.discovered_dependencies candidate
        join public.dependency_catalog dependency on dependency.id=candidate.dependency_id
        where candidate.workspace_id=onboarding.workspace_id and candidate.company_id=company.id),'[]'::jsonb)),
    'confirmedDependencies',coalesce((select jsonb_agg(jsonb_build_object('workspaceDependencyId',wd.id,
      'dependencyId',dependency.id,'providerName',dependency.name,'category',dependency.category,'origin',wd.origin,
      'criticality',coalesce(context.criticality,'normal'),'productionCritical',coalesce(context.production_critical,false),
      'usedFor',coalesce(context.used_for,'[]'::jsonb),'contextNote',coalesce(context.context_note,''),
      'usageMetadata',coalesce(context.usage_metadata,'{}'::jsonb)) order by dependency.name)
      from public.workspace_dependencies wd join public.dependency_catalog dependency on dependency.id=wd.dependency_id
      left join public.dependency_context context on context.workspace_dependency_id=wd.id
      where wd.workspace_id=onboarding.workspace_id),'[]'::jsonb),
    'completion',jsonb_build_object('dependencyReview',onboarding.dependency_review_completed_at is not null,
      'context',onboarding.context_completed_at is not null,'notifications',onboarding.notifications_completed_at is not null),
    'notificationPreferences',(select jsonb_build_object('criticalChanges',preferences.critical_changes,
      'importantChanges',preferences.important_changes,'informational',preferences.informational,
      'monthlyProtectionReport',preferences.monthly_protection_report,'isDefault',preferences.is_default,
      'completedAt',preferences.completed_at) from public.workspace_notification_preferences preferences
      where preferences.workspace_id=onboarding.workspace_id),
    'coveragePreview',jsonb_build_object('dependenciesConfirmed',dep_counts.total,
      'authoritativeSourcesAvailable',source_counts.total,'criticalDependencies',dep_counts.critical,
      'sourcesByType',source_counts.by_type),
    'activation',case when onboarding.activated_at is null then null else jsonb_build_object(
      'activatedAt',onboarding.activated_at,'baselineStatus',case
        when source_counts.total=0 then 'partial'
        when source_counts.snapshots=source_counts.total then 'ready'
        when source_counts.failed>0 then 'partial'
        else 'in_progress' end) end
  ) into v_result
  from public.workspace_onboarding onboarding
  join public.companies company on company.id=onboarding.company_id and company.workspace_id=onboarding.workspace_id
  left join lateral (select run.status,run.started_at,run.finished_at
    from public.dependency_discovery_runs run where run.workspace_id=onboarding.workspace_id and run.company_id=company.id
    order by run.started_at desc,run.id desc limit 1) latest on true
  cross join lateral (select count(*)::integer total,
      count(*) filter (where coalesce(context.criticality,'normal')='critical')::integer critical
    from public.workspace_dependencies wd left join public.dependency_context context on context.workspace_dependency_id=wd.id
    where wd.workspace_id=onboarding.workspace_id) dep_counts
  cross join lateral (select count(distinct source.id)::integer total,
      count(distinct source.id) filter (where snapshot.source_id is not null)::integer snapshots,
      count(distinct source.id) filter (where queue.status='failed')::integer failed,
      coalesce((select jsonb_object_agg(type_counts.display_type,type_counts.source_count)
        from (select case source_type.source_type when 'documentation' then 'api_docs'
          when 'api' then 'api_docs' when 'deprecation' then 'deprecations'
          when 'announcement' then 'announcements' else source_type.source_type end display_type,
          count(distinct source_type.id)::integer source_count
          from public.workspace_dependencies wd2
          join public.source_catalog source_type on source_type.dependency_id=wd2.dependency_id and source_type.enabled
          where wd2.workspace_id=onboarding.workspace_id
          group by 1) type_counts),'{}'::jsonb) by_type
    from public.workspace_dependencies wd join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
    left join lateral (select s.source_id from public.source_snapshots s where s.source_id=source.id limit 1) snapshot on true
    left join public.baseline_scan_queue queue on queue.source_id=source.id
    where wd.workspace_id=onboarding.workspace_id) source_counts
  where onboarding.workspace_id=p_workspace_id;
  if v_result is null then raise exception 'Workspace onboarding was not found' using errcode = 'P0002'; end if;
  return v_result;
end;
$$;

create function public.request_onboarding_dependency(p_workspace_id uuid,p_dependency_name text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null or not exists (select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=v_user_id and role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode = '42501';
  end if;
  if p_dependency_name is null or char_length(btrim(p_dependency_name)) not between 1 and 120 then
    raise exception 'Dependency name is invalid' using errcode = '22023';
  end if;
  -- Unknown providers are returned as unsupported; no global catalog row or arbitrary monitor is created.
  raise exception 'unsupported_dependency' using errcode = 'P0002';
end;
$$;

revoke all on function private.enqueue_customer_impact_for_dependency(uuid,bigint)
  from public,anon,authenticated;
revoke all on function private.enqueue_customer_impacts_on_classification()
  from public,anon,authenticated;
revoke all on function private.advance_onboarding_after_discovery()
  from public,anon,authenticated;
revoke all on function private.mark_baseline_queue_from_scan()
  from public,anon,authenticated;
revoke all on function private.mark_baseline_queue_from_snapshot()
  from public,anon,authenticated;

-- Seed curated catalog entries that customers can explicitly add. They have no source coverage until
-- authoritative global sources are curated separately.
insert into public.dependency_catalog (slug,name,category,website_url,metadata)
values
  ('anthropic','Anthropic','ai','https://anthropic.com','{"kind":"service"}'::jsonb),
  ('resend','Resend','communications','https://resend.com','{"kind":"service"}'::jsonb)
on conflict (slug) do nothing;

-- All onboarding RPCs are explicit authenticated entry points. SECURITY DEFINER functions perform
-- their own auth.uid()/membership checks and are not executable by anon or PUBLIC.
revoke all on function public.start_workspace_onboarding(uuid,text,text,text,text,text,uuid) from public,anon,authenticated;
revoke all on function public.mark_onboarding_discovery_started(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.claim_onboarding_discovery_dispatch(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.release_onboarding_discovery_dispatch(uuid,uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.decide_onboarding_dependency_candidate(uuid,uuid,text) from public,anon;
revoke all on function public.add_onboarding_dependency_manually(uuid,text) from public,anon;
revoke all on function public.set_onboarding_dependency_context(uuid,uuid,text,boolean,jsonb,text,jsonb) from public,anon;
revoke all on function public.save_onboarding_notification_preferences(uuid,text,text,boolean) from public,anon;
revoke all on function public.complete_onboarding_step(uuid,text) from public,anon;
revoke all on function public.search_onboarding_dependency_catalog(uuid,text) from public,anon;
revoke all on function public.claim_onboarding_baseline_sources(uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.mark_onboarding_baseline_dispatched(uuid,uuid,uuid,integer,text) from public,anon,authenticated;
revoke all on function public.release_onboarding_baseline_claim(uuid,uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.activate_workspace_protection(uuid) from public,anon;
revoke all on function public.get_onboarding_status(uuid) from public,anon;
revoke all on function public.request_onboarding_dependency(uuid,text) from public,anon;
grant execute on function public.start_workspace_onboarding(uuid,text,text,text,text,text,uuid) to service_role;
grant execute on function public.mark_onboarding_discovery_started(uuid,uuid,uuid,text) to service_role;
grant execute on function public.claim_onboarding_discovery_dispatch(uuid,uuid,uuid) to service_role;
grant execute on function public.release_onboarding_discovery_dispatch(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.decide_onboarding_dependency_candidate(uuid,uuid,text) to authenticated;
grant execute on function public.add_onboarding_dependency_manually(uuid,text) to authenticated;
grant execute on function public.set_onboarding_dependency_context(uuid,uuid,text,boolean,jsonb,text,jsonb) to authenticated;
grant execute on function public.save_onboarding_notification_preferences(uuid,text,text,boolean) to authenticated;
grant execute on function public.complete_onboarding_step(uuid,text) to authenticated;
grant execute on function public.search_onboarding_dependency_catalog(uuid,text) to authenticated;
grant execute on function public.claim_onboarding_baseline_sources(uuid,uuid,integer) to service_role;
grant execute on function public.mark_onboarding_baseline_dispatched(uuid,uuid,uuid,integer,text) to service_role;
grant execute on function public.release_onboarding_baseline_claim(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.activate_workspace_protection(uuid) to authenticated;
grant execute on function public.get_onboarding_status(uuid) to authenticated;
grant execute on function public.request_onboarding_dependency(uuid,text) to authenticated;
