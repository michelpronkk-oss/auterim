-- M15 Wave 3: make protected products an explicit workspace quota entity.
-- A product owns many first-party surfaces; surfaces never consume product slots.

create table public.workspace_products (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  slug text not null check (slug ~ '^[a-z0-9]+([a-z0-9-]*[a-z0-9])?$'),
  status text not null default 'draft' check (status in ('draft','protected','archived')),
  is_default boolean not null default false,
  protected_at timestamptz,
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_products_workspace_slug_key unique (workspace_id,slug),
  constraint workspace_products_id_workspace_key unique (id,workspace_id),
  constraint workspace_products_default_archive_check check (not is_default or status <> 'archived'),
  constraint workspace_products_status_timestamps_check check (
    (status = 'protected' and protected_at is not null and archived_at is null)
    or (status = 'draft' and protected_at is null and archived_at is null)
    or (status = 'archived' and archived_at is not null)
  )
);

create unique index workspace_products_one_default_per_workspace_idx
  on public.workspace_products (workspace_id) where is_default;
create index workspace_products_workspace_status_idx
  on public.workspace_products (workspace_id,status,created_at);
create trigger workspace_products_set_updated_at
  before update on public.workspace_products
  for each row execute function private.set_updated_at();

create table public.workspace_product_surfaces (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  product_id uuid not null,
  surface_type text not null check (surface_type in ('website','app','docs','api','status','other')),
  url text not null check (
    char_length(btrim(url)) between 9 and 2048
    and url ~ '^https?://'
    and url !~ '^https?://[^/@]+@'
  ),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint workspace_product_surfaces_product_workspace_fkey
    foreign key (product_id,workspace_id)
    references public.workspace_products (id,workspace_id) on delete cascade,
  constraint workspace_product_surfaces_product_url_key unique (product_id,url)
);
create index workspace_product_surfaces_workspace_product_idx
  on public.workspace_product_surfaces (workspace_id,product_id);

-- Preserve all existing dependency IDs and their downstream impact/preflight history.
-- A workspace gets exactly one compatibility/default product during migration.
insert into public.workspace_products (
  workspace_id,name,slug,status,is_default,protected_at,created_by,created_at
)
select workspace.id,
  coalesce(nullif(btrim(company.name),''),workspace.name),
  coalesce(nullif(trim(both '-' from regexp_replace(lower(coalesce(nullif(btrim(company.name),''),workspace.name)), '[^a-z0-9]+', '-', 'g')),''),
    'workspace-' || left(workspace.id::text,8)),
  case when onboarding.state='active' then 'protected' else 'draft' end,
  true,
  case when onboarding.state='active' then onboarding.activated_at else null end,
  workspace.created_by,
  workspace.created_at
from public.workspaces workspace
left join public.workspace_onboarding onboarding on onboarding.workspace_id=workspace.id
left join public.companies company on company.id=onboarding.company_id and company.workspace_id=workspace.id;

insert into public.workspace_product_surfaces (workspace_id,product_id,surface_type,url,created_at)
select product.workspace_id,product.id,'website',company.website_url,company.created_at
from public.workspace_products product
join public.workspace_onboarding onboarding on onboarding.workspace_id=product.workspace_id
join public.companies company on company.id=onboarding.company_id and company.workspace_id=product.workspace_id
where product.is_default and company.website_url is not null
  and char_length(btrim(company.website_url)) between 9 and 2048
  and company.website_url ~ '^https?://'
  and company.website_url !~ '^https?://[^/@]+@'
on conflict (product_id,url) do nothing;

alter table public.workspace_dependencies add column protected_product_id uuid;
update public.workspace_dependencies dependency
set protected_product_id=product.id
from public.workspace_products product
where product.workspace_id=dependency.workspace_id and product.is_default;
alter table public.workspace_dependencies alter column protected_product_id set not null;
alter table public.workspace_dependencies
  add constraint workspace_dependencies_product_workspace_fkey
    foreign key (protected_product_id,workspace_id)
    references public.workspace_products (id,workspace_id) on delete restrict,
  add constraint workspace_dependencies_id_workspace_product_key
    unique (id,workspace_id,protected_product_id);
alter table public.workspace_dependencies
  drop constraint workspace_dependencies_workspace_dependency_key;
alter table public.workspace_dependencies
  add constraint workspace_dependencies_product_dependency_key
    unique (protected_product_id,dependency_id);
create index workspace_dependencies_product_idx
  on public.workspace_dependencies (workspace_id,protected_product_id,monitoring_enabled);

create function private.workspace_product_limit(p_workspace_id uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select case private.workspace_quota_plan(p_workspace_id)
    when 'core' then 1 when 'pro' then 3 when 'business' then 10 else 0 end
$$;
revoke all on function private.workspace_product_limit(uuid) from public,anon,authenticated;
grant execute on function private.workspace_product_limit(uuid) to service_role;

create function private.enforce_workspace_product_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare product_limit integer; used_slots integer; excluded_product_id uuid;
begin
  if tg_op='UPDATE' then
    if new.workspace_id is distinct from old.workspace_id then
      raise exception 'product_workspace_immutable' using errcode='22023';
    end if;
    excluded_product_id:=old.id;
  end if;
  -- Serialize product creation/activation/archive for this tenant to prevent quota races.
  perform 1 from public.workspaces workspace where workspace.id=new.workspace_id for update;
  if new.status <> 'archived' and (tg_op='INSERT' or old.status='archived') then
    product_limit := private.workspace_product_limit(new.workspace_id);
    if product_limit=0 then raise exception 'paid_plan_required' using errcode='42501'; end if;
    select count(*)::integer into used_slots
      from public.workspace_products product
      where product.workspace_id=new.workspace_id and product.status<>'archived'
        and product.id is distinct from excluded_product_id;
    if used_slots>=product_limit then raise exception 'product_quota_exceeded' using errcode='22023'; end if;
  end if;
  if new.status='protected' and new.protected_at is null then new.protected_at:=now(); end if;
  return new;
end;
$$;
revoke all on function private.enforce_workspace_product_limit() from public,anon,authenticated;
create trigger workspace_products_enforce_plan_limit
  before insert or update of status on public.workspace_products
  for each row execute function private.enforce_workspace_product_limit();

create function private.attach_default_product_to_dependency()
returns trigger language plpgsql security definer set search_path = '' as $$
declare product_status text;
begin
  if new.protected_product_id is null then
    select product.id into new.protected_product_id
    from public.workspace_products product
    where product.workspace_id=new.workspace_id and product.is_default and product.status<>'archived';
  end if;
  select product.status into product_status
  from public.workspace_products product
  where product.id=new.protected_product_id and product.workspace_id=new.workspace_id;
  if product_status is null then raise exception 'product_not_found' using errcode='23503'; end if;
  if new.monitoring_enabled and product_status='archived' then
    raise exception 'product_archived' using errcode='22023';
  end if;
  if tg_op='UPDATE' and new.protected_product_id is distinct from old.protected_product_id then
    raise exception 'dependency_product_immutable' using errcode='22023';
  end if;
  return new;
end;
$$;
revoke all on function private.attach_default_product_to_dependency() from public,anon,authenticated;
create trigger workspace_dependencies_attach_product
  before insert or update of protected_product_id,monitoring_enabled on public.workspace_dependencies
  for each row execute function private.attach_default_product_to_dependency();

-- Keep legacy onboarding signatures operational while making provider identity product-scoped.
create or replace function public.decide_onboarding_dependency_candidate(
  p_workspace_id uuid,p_candidate_id uuid,p_decision text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
  v_candidate public.discovered_dependencies%rowtype;
  v_dependency_id uuid;
  v_product_id uuid;
  v_workspace_dependency_id uuid;
  v_origin text;
begin
  if v_user_id is null or not exists(select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=v_user_id and role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode='42501';
  end if;
  if p_decision not in ('confirmed','rejected') then raise exception 'Decision is invalid' using errcode='22023'; end if;
  select * into v_candidate from public.discovered_dependencies
    where id=p_candidate_id and workspace_id=p_workspace_id for update;
  if not found then raise exception 'Discovery candidate was not found' using errcode='P0002'; end if;
  if v_candidate.status<>'candidate' and v_candidate.status<>p_decision then
    raise exception 'Candidate decision is already recorded' using errcode='22023';
  end if;
  if not exists(select 1 from public.workspace_onboarding onboarding
    where onboarding.workspace_id=p_workspace_id and onboarding.company_id=v_candidate.company_id
      and onboarding.state<>'active') then
    raise exception 'Candidate is outside active onboarding' using errcode='42501';
  end if;
  if p_decision='rejected' then
    update public.discovered_dependencies set status='rejected'
      where id=p_candidate_id and workspace_id=p_workspace_id;
    return jsonb_build_object('candidateId',p_candidate_id,'decision','rejected','workspaceDependencyId',null);
  end if;
  select id into v_product_id from public.workspace_products
    where workspace_id=p_workspace_id and is_default and status<>'archived' for update;
  if v_product_id is null then raise exception 'Default product is unavailable' using errcode='23514'; end if;
  v_dependency_id:=v_candidate.dependency_id;
  insert into public.workspace_dependencies
    (workspace_id,protected_product_id,dependency_id,selected_by,origin,monitoring_enabled,protection_started_at)
  values(p_workspace_id,v_product_id,v_dependency_id,v_user_id,'discovered',false,null)
  on conflict (protected_product_id,dependency_id) do nothing;
  select id,origin into v_workspace_dependency_id,v_origin from public.workspace_dependencies
    where workspace_id=p_workspace_id and protected_product_id=v_product_id and dependency_id=v_dependency_id;
  insert into public.workspace_dependency_discovery_links
    (workspace_id,workspace_dependency_id,discovered_dependency_id,linked_by)
  values(p_workspace_id,v_workspace_dependency_id,p_candidate_id,v_user_id) on conflict do nothing;
  update public.discovered_dependencies set status='confirmed' where id=p_candidate_id and workspace_id=p_workspace_id;
  return jsonb_build_object('candidateId',p_candidate_id,'decision','confirmed',
    'workspaceDependencyId',v_workspace_dependency_id,'origin',v_origin);
end;
$$;

create or replace function public.add_onboarding_dependency_manually(p_workspace_id uuid,p_dependency_slug text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
  v_dependency_id uuid;
  v_product_id uuid;
  v_workspace_dependency_id uuid;
  v_candidate record;
begin
  if v_user_id is null or not exists(select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=v_user_id and role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode='42501';
  end if;
  if not exists(select 1 from public.workspace_onboarding where workspace_id=p_workspace_id and state<>'active') then
    raise exception 'Onboarding is not available' using errcode='42501';
  end if;
  select id into v_dependency_id from public.dependency_catalog where slug=lower(btrim(p_dependency_slug)) and enabled;
  if v_dependency_id is null then raise exception 'unsupported_dependency' using errcode='P0002'; end if;
  select id into v_product_id from public.workspace_products
    where workspace_id=p_workspace_id and is_default and status<>'archived' for update;
  if v_product_id is null then raise exception 'Default product is unavailable' using errcode='23514'; end if;
  insert into public.workspace_dependencies
    (workspace_id,protected_product_id,dependency_id,selected_by,origin,monitoring_enabled,protection_started_at)
  values(p_workspace_id,v_product_id,v_dependency_id,v_user_id,'manual',false,null)
  on conflict (protected_product_id,dependency_id) do update set origin='manual'
  returning id into v_workspace_dependency_id;
  if v_workspace_dependency_id is null then
    select id into v_workspace_dependency_id from public.workspace_dependencies
      where workspace_id=p_workspace_id and protected_product_id=v_product_id and dependency_id=v_dependency_id;
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
    values(p_workspace_id,v_workspace_dependency_id,v_candidate.id,v_user_id) on conflict do nothing;
  end loop;
  return jsonb_build_object('workspaceDependencyId',v_workspace_dependency_id,
    'dependencyId',v_dependency_id,'origin','manual');
end;
$$;

create function private.initialize_workspace_default_product()
returns trigger language plpgsql security definer set search_path = '' as $$
declare product_slug text;
begin
  product_slug:=coalesce(nullif(trim(both '-' from regexp_replace(lower(btrim(new.name)), '[^a-z0-9]+', '-', 'g')),''),
    'workspace-' || left(new.id::text,8));
  insert into public.workspace_products (workspace_id,name,slug,status,is_default,created_by)
  values (new.id,new.name,product_slug,'draft',true,new.created_by);
  return new;
end;
$$;
revoke all on function private.initialize_workspace_default_product() from public,anon,authenticated;
create trigger workspaces_initialize_default_product
  after insert on public.workspaces
  for each row execute function private.initialize_workspace_default_product();

create function private.sync_default_product_from_onboarding()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.workspace_products product set
    name=company.name,
    status=case when new.state='active' then 'protected' else product.status end,
    protected_at=case when new.state='active' then coalesce(product.protected_at,new.activated_at,now()) else product.protected_at end
  from public.companies company
  where product.workspace_id=new.workspace_id and product.is_default
    and company.id=new.company_id and company.workspace_id=new.workspace_id
    and product.status<>'archived';
  insert into public.workspace_product_surfaces (workspace_id,product_id,surface_type,url)
  select product.workspace_id,product.id,'website',company.website_url
  from public.workspace_products product
  join public.companies company on company.workspace_id=product.workspace_id
  where product.workspace_id=new.workspace_id and product.is_default
    and company.id=new.company_id and company.workspace_id=new.workspace_id
    and company.website_url is not null
    and char_length(btrim(company.website_url)) between 9 and 2048
    and company.website_url ~ '^https?://'
    and company.website_url !~ '^https?://[^/@]+@'
  on conflict (product_id,url) do nothing;
  return new;
end;
$$;
revoke all on function private.sync_default_product_from_onboarding() from public,anon,authenticated;
create trigger workspace_onboarding_sync_default_product
  after insert or update of state on public.workspace_onboarding
  for each row execute function private.sync_default_product_from_onboarding();

create function private.retire_product_preflight(p_workspace_id uuid,p_product_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.preflight_dispatch_queue queue set status='superseded',error_category=null
  where queue.workspace_id=p_workspace_id and queue.status in ('queued','failed','dispatched')
    and exists (
      select 1 from public.impact_assessments assessment
      join public.workspace_dependencies dependency on dependency.id=assessment.workspace_dependency_id
        and dependency.workspace_id=assessment.workspace_id
      where assessment.id=queue.impact_assessment_id and assessment.workspace_id=p_workspace_id
        and dependency.protected_product_id=p_product_id
    );
  update public.preflight_runs run set status='canceled',completed_at=null,
    run_lease_until=null,run_claim_token=null,error_category='product_archived',updated_at=now()
  where run.workspace_id=p_workspace_id and run.status in ('queued','running')
    and exists (
      select 1 from public.impact_assessments assessment
      join public.workspace_dependencies dependency on dependency.id=assessment.workspace_dependency_id
        and dependency.workspace_id=assessment.workspace_id
      where assessment.id=run.impact_assessment_id and assessment.workspace_id=p_workspace_id
        and dependency.protected_product_id=p_product_id
    );
end;
$$;
revoke all on function private.retire_product_preflight(uuid,uuid) from public,anon,authenticated;

create function private.preflight_dependency_is_active(p_workspace_id uuid,p_workspace_dependency_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_dependencies dependency
    join public.workspace_products product
      on product.id=dependency.protected_product_id and product.workspace_id=dependency.workspace_id
    where dependency.workspace_id=p_workspace_id and dependency.id=p_workspace_dependency_id
      and dependency.monitoring_enabled and product.status='protected'
  )
$$;
revoke all on function private.preflight_dependency_is_active(uuid,uuid) from public,anon,authenticated;
grant execute on function private.preflight_dependency_is_active(uuid,uuid) to service_role;

-- A dispatched task can start after a product is archived. Recheck product lifecycle
-- at the database claim and commit boundaries, not only when the queue was dispatched.
create or replace function public.claim_preflight_run(p_run_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare claim_token uuid := gen_random_uuid();
begin
  update public.preflight_runs run set status='running',started_at=now(),
    run_lease_until=now()+interval '15 minutes',run_claim_token=claim_token,error_category=null
  where run.id=p_run_id and private.workspace_can_run_preflight(run.workspace_id)
    and exists (
      select 1 from public.impact_assessments assessment
      where assessment.id=run.impact_assessment_id and assessment.workspace_id=run.workspace_id
        and private.preflight_dependency_is_active(run.workspace_id,assessment.workspace_dependency_id)
    )
    and (run.status in ('queued','failed')
      or (run.status='running' and (run.run_lease_until is null or run.run_lease_until<now())));
  if not found then return null; end if;
  return claim_token;
end;
$$;
revoke all on function public.claim_preflight_run(uuid) from public,anon,authenticated;
grant execute on function public.claim_preflight_run(uuid) to service_role;

create or replace function public.save_preflight_result(p_run_id uuid,p_claim_token uuid,p_repository_ids uuid[],p_result jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare run_row public.preflight_runs%rowtype; finding jsonb; dependency_id uuid;
begin
  select * into run_row from public.preflight_runs
    where id=p_run_id and status='running' and run_claim_token=p_claim_token and run_lease_until>now()
    for update;
  if not found then raise exception 'preflight_run_not_running' using errcode='40001'; end if;
  if not private.workspace_can_run_preflight(run_row.workspace_id) then
    raise exception 'preflight_entitlement_required' using errcode='42501';
  end if;
  select assessment.workspace_dependency_id into dependency_id from public.impact_assessments assessment
    where assessment.id=run_row.impact_assessment_id and assessment.workspace_id=run_row.workspace_id;
  if dependency_id is null
    or not private.preflight_dependency_is_active(run_row.workspace_id,dependency_id) then
    raise exception 'preflight_product_inactive' using errcode='42501';
  end if;
  if p_repository_ids is null or cardinality(p_repository_ids)>5
    or cardinality(p_repository_ids)<>(select count(distinct id) from unnest(p_repository_ids) id)
    or cardinality(p_repository_ids)<>
      (select count(*) from unnest(p_repository_ids) expected(id)
        join public.workspace_repository_access access on access.repository_id=expected.id
          and access.workspace_id=run_row.workspace_id and access.workspace_dependency_id=dependency_id
        join public.repositories repo on repo.id=expected.id and repo.workspace_id=run_row.workspace_id
          and repo.selected_for_protection and repo.status='available'
        join public.repository_connections connection on connection.id=repo.connection_id
          and connection.workspace_id=repo.workspace_id and connection.status='connected') then
    raise exception 'preflight_repository_access_revoked' using errcode='42501';
  end if;
  if jsonb_typeof(p_result)<>'object' or jsonb_typeof(p_result->'findings')<>'array'
    or jsonb_array_length(p_result->'findings')>200
    or p_result->>'status' not in ('completed','partial')
    or p_result->>'verifiedImpact' not in ('verified','likely','not_found','inconclusive') then
    raise exception 'invalid_preflight_result' using errcode='22023';
  end if;
  for finding in select value from jsonb_array_elements(p_result->'findings') loop
    if not ((finding->>'repositoryId')::uuid=any(p_repository_ids)) then
      raise exception 'preflight_finding_repository_mismatch' using errcode='42501';
    end if;
    insert into public.preflight_findings
      (workspace_id,preflight_run_id,repository_id,commit_sha,file_path,line_start,line_end,
       finding_type,affected_entity,confidence,verification,explanation,evidence_fingerprint)
    values (run_row.workspace_id,p_run_id,(finding->>'repositoryId')::uuid,
      finding->>'commitSha',finding->>'path',(finding->>'lineStart')::integer,
      (finding->>'lineEnd')::integer,finding->>'findingType',finding->>'affectedEntity',
      (finding->>'confidence')::numeric,finding->>'verification',finding->>'explanation',
      finding->>'evidenceFingerprint')
    on conflict (preflight_run_id,repository_id,commit_sha,file_path,evidence_fingerprint) do nothing;
  end loop;
  update public.preflight_runs set status=p_result->>'status',verified_impact=p_result->>'verifiedImpact',
    confidence=(p_result->>'confidence')::numeric,complexity=p_result->>'complexity',
    recommended_remediation=p_result->>'recommendedRemediation',
    effective_at=nullif(p_result->>'effectiveAt','')::timestamptz,
    announced_at=nullif(p_result->>'announcedAt','')::timestamptz,
    deadline=nullif(p_result->>'deadline','')::timestamptz,
    days_remaining=nullif(p_result->>'daysRemaining','')::integer,
    repositories_scanned=(p_result->>'repositoriesScanned')::integer,completed_at=now(),
    run_lease_until=null,run_claim_token=null,error_category=null
  where id=p_run_id;
end;
$$;
revoke all on function public.save_preflight_result(uuid,uuid,uuid[],jsonb) from public,anon,authenticated;
grant execute on function public.save_preflight_result(uuid,uuid,uuid[],jsonb) to service_role;

create function public.create_workspace_product(
  p_workspace_id uuid,
  p_name text,
  p_surfaces jsonb default '[]'::jsonb,
  p_replace_product_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
  v_product public.workspace_products%rowtype;
  v_old public.workspace_products%rowtype;
  v_slug_base text;
  v_slug text;
  v_suffix integer := 0;
  v_default boolean := false;
  v_surface jsonb;
  v_type text;
  v_url text;
begin
  if v_user_id is null or p_name is null or char_length(btrim(p_name)) not between 1 and 160
    or p_surfaces is null or jsonb_typeof(p_surfaces)<>'array' or jsonb_array_length(p_surfaces)>25 then
    raise exception 'invalid_product_input' using errcode='22023';
  end if;
  if not exists(select 1 from public.workspace_members member where member.workspace_id=p_workspace_id
    and member.user_id=v_user_id and member.role in ('owner','admin')) then
    raise exception 'owner_or_admin_required' using errcode='42501';
  end if;
  perform 1 from public.workspaces workspace where workspace.id=p_workspace_id for update;
  if not found then raise exception 'workspace_not_found' using errcode='P0002'; end if;

  if p_replace_product_id is not null then
    select * into v_old from public.workspace_products product
    where product.id=p_replace_product_id and product.workspace_id=p_workspace_id and product.status<>'archived'
    for update;
    if not found then raise exception 'product_not_found' using errcode='P0002'; end if;
    update public.workspace_products set is_default=false,status='archived',archived_at=now()
    where id=v_old.id and workspace_id=p_workspace_id;
    update public.workspace_dependencies set monitoring_enabled=false
    where protected_product_id=v_old.id and workspace_id=p_workspace_id;
    perform private.retire_product_preflight(p_workspace_id,v_old.id);
    v_default:=v_old.is_default or not exists(select 1 from public.workspace_products product
      where product.workspace_id=p_workspace_id and product.status<>'archived' and product.is_default);
  else
    v_default:=not exists(select 1 from public.workspace_products product
      where product.workspace_id=p_workspace_id and product.status<>'archived' and product.is_default);
  end if;

  v_slug_base:=coalesce(nullif(trim(both '-' from regexp_replace(lower(btrim(p_name)), '[^a-z0-9]+', '-', 'g')),''),'product');
  v_slug:=v_slug_base;
  while exists(select 1 from public.workspace_products product where product.workspace_id=p_workspace_id and product.slug=v_slug) loop
    v_suffix:=v_suffix+1;
    v_slug:=v_slug_base || '-' || v_suffix::text;
  end loop;

  for v_surface in select value from jsonb_array_elements(p_surfaces) loop
    v_type:=v_surface->>'surfaceType';
    v_url:=btrim(v_surface->>'url');
    if jsonb_typeof(v_surface)<>'object' or v_type not in ('website','app','docs','api','status','other')
      or v_url is null or char_length(v_url) not between 9 and 2048 or v_url !~ '^https?://'
      or v_url ~ '^https?://[^/@]+@' then
      raise exception 'invalid_product_surface' using errcode='22023';
    end if;
  end loop;

  insert into public.workspace_products(workspace_id,name,slug,status,is_default,created_by)
  values(p_workspace_id,btrim(p_name),v_slug,'draft',v_default,v_user_id)
  returning * into v_product;

  insert into public.workspace_product_surfaces(workspace_id,product_id,surface_type,url,created_by)
  select p_workspace_id,v_product.id,value->>'surfaceType',btrim(value->>'url'),v_user_id
  from jsonb_array_elements(p_surfaces);

  return jsonb_build_object('product',jsonb_build_object(
    'id',v_product.id,'workspaceId',v_product.workspace_id,'name',v_product.name,'slug',v_product.slug,
    'status',v_product.status,'isDefault',v_product.is_default,'createdAt',v_product.created_at),
    'replacedProductId',v_old.id);
end;
$$;
revoke all on function public.create_workspace_product(uuid,text,jsonb,uuid) from public,anon;
grant execute on function public.create_workspace_product(uuid,text,jsonb,uuid) to authenticated;

create function public.archive_workspace_product(p_workspace_id uuid,p_product_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := (select auth.uid()); v_product public.workspace_products%rowtype; v_next uuid;
begin
  if v_user_id is null or not exists(select 1 from public.workspace_members member where member.workspace_id=p_workspace_id
    and member.user_id=v_user_id and member.role in ('owner','admin')) then
    raise exception 'owner_or_admin_required' using errcode='42501';
  end if;
  perform 1 from public.workspaces workspace where workspace.id=p_workspace_id for update;
  select * into v_product from public.workspace_products product
  where product.id=p_product_id and product.workspace_id=p_workspace_id and product.status<>'archived' for update;
  if not found then raise exception 'product_not_found' using errcode='P0002'; end if;
  if v_product.is_default then
    select id into v_next from public.workspace_products product
    where product.workspace_id=p_workspace_id and product.status<>'archived' and product.id<>p_product_id
    order by product.created_at,product.id limit 1;
    if v_next is null then raise exception 'default_product_replacement_required' using errcode='23514'; end if;
    update public.workspace_products set is_default=false where id=p_product_id and workspace_id=p_workspace_id;
    update public.workspace_products set is_default=true where id=v_next and workspace_id=p_workspace_id;
  end if;
  update public.workspace_products set is_default=false,status='archived',archived_at=now()
    where id=p_product_id and workspace_id=p_workspace_id;
  update public.workspace_dependencies set monitoring_enabled=false
    where protected_product_id=p_product_id and workspace_id=p_workspace_id;
  perform private.retire_product_preflight(p_workspace_id,p_product_id);
  return jsonb_build_object('workspaceId',p_workspace_id,'productId',p_product_id,'status','archived');
end;
$$;
revoke all on function public.archive_workspace_product(uuid,uuid) from public,anon;
grant execute on function public.archive_workspace_product(uuid,uuid) to authenticated;

alter table public.workspace_products enable row level security;
alter table public.workspace_product_surfaces enable row level security;
grant select on public.workspace_products,public.workspace_product_surfaces to authenticated;
grant all on public.workspace_products,public.workspace_product_surfaces to service_role;
create policy workspace_products_select_member on public.workspace_products
  for select to authenticated
  using ((select private.has_workspace_role(workspace_id,array['owner','admin','member'])));
create policy workspace_product_surfaces_select_member on public.workspace_product_surfaces
  for select to authenticated
  using ((select private.has_workspace_role(workspace_id,array['owner','admin','member'])));

comment on table public.workspace_products is
  'Workspace product portfolio and billable protected-product slots. Draft and protected products reserve one slot; archived products preserve history and release it.';
comment on table public.workspace_product_surfaces is
  'First-party website/app/docs/API/status surfaces belonging to a product. Surface rows do not consume product slots.';
