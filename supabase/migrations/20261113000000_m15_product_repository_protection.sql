-- Product-level repository protection is distinct from the workspace GitHub catalog.
-- Existing dependency/repository links remain the evidence and eligibility relation.

create table public.workspace_product_repositories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  protected_product_id uuid not null,
  repository_id uuid not null,
  status text not null default 'active' check (status in ('active','inactive')),
  provenance text not null check (provenance in ('user_selected','legacy_deterministic')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_product_repositories_product_workspace_fkey
    foreign key (protected_product_id,workspace_id)
    references public.workspace_products(id,workspace_id) on delete cascade,
  constraint workspace_product_repositories_repository_workspace_fkey
    foreign key (repository_id,workspace_id)
    references public.repositories(id,workspace_id) on delete cascade,
  constraint workspace_product_repositories_product_repository_key
    unique (protected_product_id,repository_id),
  constraint workspace_product_repositories_id_workspace_key
    unique (id,workspace_id)
);

create index workspace_product_repositories_workspace_active_idx
  on public.workspace_product_repositories(workspace_id,repository_id)
  where status='active';
create index workspace_product_repositories_product_status_idx
  on public.workspace_product_repositories(workspace_id,protected_product_id,status,repository_id);

create function private.sync_repository_protection_compatibility_flag()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.workspace_product_repositories mapping
    where mapping.workspace_id=new.workspace_id and mapping.repository_id=new.id
  ) then
    new.selected_for_protection := exists (
      select 1 from public.workspace_product_repositories mapping
      join public.workspace_products product
        on product.id=mapping.protected_product_id and product.workspace_id=mapping.workspace_id
      where mapping.workspace_id=new.workspace_id and mapping.repository_id=new.id
        and mapping.status='active' and product.status='protected'
    );
  end if;
  return new;
end;
$$;
revoke all on function private.sync_repository_protection_compatibility_flag() from public,anon,authenticated;
create trigger repositories_sync_protection_compatibility_flag
  before update of selected_for_protection on public.repositories
  for each row execute function private.sync_repository_protection_compatibility_flag();

-- Only a selected repository with an available connection and exactly one evidenced
-- product assignment can be migrated. Ambiguous/unlinked legacy rows remain untouched.
with deterministic as (
  select repository.id as repository_id, repository.workspace_id,
    min(dependency.protected_product_id::text)::uuid as protected_product_id,
    min(product.status) as product_status
  from public.repositories repository
  join public.repository_connections connection
    on connection.id=repository.connection_id and connection.workspace_id=repository.workspace_id
  join public.workspace_repository_access access
    on access.repository_id=repository.id and access.workspace_id=repository.workspace_id
  join public.workspace_dependencies dependency
    on dependency.id=access.workspace_dependency_id and dependency.workspace_id=access.workspace_id
  join public.workspace_products product
    on product.id=dependency.protected_product_id and product.workspace_id=dependency.workspace_id
  where repository.selected_for_protection
    and repository.status='available'
    and connection.status='connected'
  group by repository.id,repository.workspace_id
  having count(distinct dependency.protected_product_id)=1
)
insert into public.workspace_product_repositories
  (workspace_id,protected_product_id,repository_id,status,provenance)
select workspace_id,protected_product_id,repository_id,
  case when product_status='protected' then 'active' else 'inactive' end,
  'legacy_deterministic'
from deterministic
on conflict (protected_product_id,repository_id) do nothing;

-- Preserve only currently protected intent in the compatibility flag. Inactive/draft/archived
-- products retain mapping history but must not remain selected through the legacy signal.
update public.repositories repository set selected_for_protection=exists (
  select 1 from public.workspace_product_repositories mapping
  join public.workspace_products product
    on product.id=mapping.protected_product_id and product.workspace_id=mapping.workspace_id
  where mapping.workspace_id=repository.workspace_id and mapping.repository_id=repository.id
    and mapping.status='active' and product.status='protected'
)
where exists (
  select 1 from public.workspace_product_repositories mapping
  where mapping.workspace_id=repository.workspace_id and mapping.repository_id=repository.id
);

alter table public.workspace_product_repositories enable row level security;
create policy workspace_product_repositories_select_member
  on public.workspace_product_repositories for select to authenticated
  using (exists (
    select 1 from public.workspace_members member
    where member.workspace_id=workspace_product_repositories.workspace_id
      and member.user_id=(select auth.uid())
  ));
revoke all on public.workspace_product_repositories from public,anon,authenticated;
grant select on public.workspace_product_repositories to authenticated;
grant all on public.workspace_product_repositories to service_role;

-- During compatibility, selected_for_protection remains the legacy signal only for
-- repositories with no product-mapping history. It is maintained as a mirror for
-- repositories managed by the new graph RPCs so existing worker gates stay intact.
create function private.workspace_protected_repository_usage(p_workspace_id uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::integer from (
    select mapping.repository_id
    from public.workspace_product_repositories mapping
    join public.workspace_products product
      on product.id=mapping.protected_product_id and product.workspace_id=mapping.workspace_id
    where mapping.workspace_id=p_workspace_id and mapping.status='active'
      and product.status='protected'
    union
    select repository.id
    from public.repositories repository
    where repository.workspace_id=p_workspace_id and repository.selected_for_protection
      and not exists (
        select 1 from public.workspace_product_repositories mapping
        where mapping.workspace_id=repository.workspace_id and mapping.repository_id=repository.id
      )
  ) protected_repositories
$$;
revoke all on function private.workspace_protected_repository_usage(uuid) from public,anon,authenticated;
grant execute on function private.workspace_protected_repository_usage(uuid) to service_role;

create function public.map_repository_to_product(p_product_id uuid,p_repository_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor_id uuid := auth.uid();
  v_workspace_id uuid;
  product_row public.workspace_products%rowtype;
  repository_row public.repositories%rowtype;
  was_active boolean;
begin
  if actor_id is null or p_product_id is null or p_repository_id is null then
    raise exception 'invalid_repository_mapping' using errcode='22023';
  end if;
  select product.workspace_id into v_workspace_id
  from public.workspace_products product where product.id=p_product_id;
  if not found then raise exception 'product_not_found' using errcode='P0002'; end if;

  perform 1 from public.workspaces where id=v_workspace_id for update;
  select * into product_row from public.workspace_products
    where id=p_product_id and workspace_id=v_workspace_id for update;
  if not found or product_row.status<>'protected' then
    raise exception 'product_not_available' using errcode='22023';
  end if;
  select * into repository_row from public.repositories
    where id=p_repository_id and workspace_id=v_workspace_id for update;
  if not found then raise exception 'repository_not_found' using errcode='P0002'; end if;
  if not exists (
    select 1 from public.workspace_members member
    where member.workspace_id=v_workspace_id and member.user_id=actor_id
      and member.role in ('owner','admin')
  ) then raise exception 'forbidden' using errcode='42501'; end if;
  if not private.workspace_can_run_preflight(v_workspace_id) then
    raise exception 'repository_plan_required' using errcode='42501';
  end if;
  if repository_row.status<>'available' or not exists (
    select 1 from public.repository_connections connection
    where connection.id=repository_row.connection_id and connection.workspace_id=v_workspace_id
      and connection.status='connected'
  ) then raise exception 'repository_unavailable' using errcode='22023'; end if;

  select exists (
    select 1 from public.workspace_product_repositories mapping
    where mapping.workspace_id=v_workspace_id and mapping.repository_id=p_repository_id
      and mapping.status='active'
  ) into was_active;
  if not was_active and private.workspace_protected_repository_usage(v_workspace_id)
      >= private.workspace_repository_limit(v_workspace_id) then
    raise exception 'repository_quota_exceeded' using errcode='22023';
  end if;

  insert into public.workspace_product_repositories
    (workspace_id,protected_product_id,repository_id,status,provenance,created_by,updated_at)
  values (v_workspace_id,p_product_id,p_repository_id,'active','user_selected',actor_id,now())
  on conflict (protected_product_id,repository_id) do update
    set status='active',provenance='user_selected',created_by=excluded.created_by,updated_at=now();
  update public.repositories set selected_for_protection=true,updated_at=now()
    where id=p_repository_id and workspace_id=v_workspace_id;

  return jsonb_build_object(
    'productId',p_product_id,'repositoryId',p_repository_id,'status','active',
    'protectedRepositoryUsage',private.workspace_protected_repository_usage(v_workspace_id),
    'limit',private.workspace_repository_limit(v_workspace_id)
  );
end;
$$;
revoke all on function public.map_repository_to_product(uuid,uuid) from public,anon;
grant execute on function public.map_repository_to_product(uuid,uuid) to authenticated;

create function public.unmap_repository_from_product(p_product_id uuid,p_repository_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor_id uuid := auth.uid();
  v_workspace_id uuid;
begin
  if actor_id is null or p_product_id is null or p_repository_id is null then
    raise exception 'invalid_repository_mapping' using errcode='22023';
  end if;
  select product.workspace_id into v_workspace_id
  from public.workspace_products product where product.id=p_product_id;
  if not found then raise exception 'product_not_found' using errcode='P0002'; end if;
  perform 1 from public.workspaces where id=v_workspace_id for update;
  if not exists (select 1 from public.repositories repository
    where repository.id=p_repository_id and repository.workspace_id=v_workspace_id) then
    raise exception 'repository_not_found' using errcode='P0002';
  end if;
  if not exists (
    select 1 from public.workspace_members member
    where member.workspace_id=v_workspace_id and member.user_id=actor_id
      and member.role in ('owner','admin')
  ) then raise exception 'forbidden' using errcode='42501'; end if;

  update public.workspace_product_repositories set status='inactive',updated_at=now()
    where workspace_id=v_workspace_id and protected_product_id=p_product_id
      and repository_id=p_repository_id and status='active';
  update public.repositories repository set selected_for_protection=exists (
      select 1 from public.workspace_product_repositories mapping
      where mapping.workspace_id=v_workspace_id and mapping.repository_id=repository.id
        and mapping.status='active'
    ),updated_at=now()
    where repository.id=p_repository_id and repository.workspace_id=v_workspace_id
      and exists (
        select 1 from public.workspace_product_repositories mapping
        where mapping.workspace_id=v_workspace_id and mapping.repository_id=repository.id
      );

  return jsonb_build_object(
    'productId',p_product_id,'repositoryId',p_repository_id,
    'protectedRepositoryUsage',private.workspace_protected_repository_usage(v_workspace_id),
    'limit',private.workspace_repository_limit(v_workspace_id)
  );
end;
$$;
revoke all on function public.unmap_repository_from_product(uuid,uuid) from public,anon;
grant execute on function public.unmap_repository_from_product(uuid,uuid) to authenticated;

-- Compatibility adapter for the existing repository-selection API. Its dependency list is
-- translated to the product set those dependencies belong to; access rows remain the separate
-- dependency-evidence edge, while selected_for_protection mirrors active graph protection.
create or replace function public.set_repository_protection(
  p_repository_id uuid,p_selected boolean,p_dependency_ids uuid[]
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  repository_row public.repositories%rowtype;
  initial_workspace_id uuid;
  actor_id uuid := auth.uid();
  dependency_count integer;
  protected_product_count integer;
begin
  if actor_id is null or p_selected is null or p_dependency_ids is null or cardinality(p_dependency_ids)>50
    or (p_selected and cardinality(p_dependency_ids)=0) or (not p_selected and cardinality(p_dependency_ids)>0) then
    raise exception 'invalid_repository_selection' using errcode='22023';
  end if;

  select workspace_id into initial_workspace_id
  from public.repositories where id=p_repository_id;
  if not found then raise exception 'repository_not_found' using errcode='P0002'; end if;
  perform 1 from public.workspaces where id=initial_workspace_id for update;
  select * into repository_row from public.repositories where id=p_repository_id for update;
  if not found or repository_row.workspace_id<>initial_workspace_id then
    raise exception 'repository_not_found' using errcode='P0002';
  end if;
  if not exists (
    select 1 from public.workspace_members member
    where member.workspace_id=repository_row.workspace_id and member.user_id=actor_id
      and member.role in ('owner','admin')
  ) then raise exception 'forbidden' using errcode='42501'; end if;
  if p_selected and not private.workspace_can_run_preflight(repository_row.workspace_id) then
    raise exception 'pro_plan_required' using errcode='42501';
  end if;
  if p_selected and (
    select count(*) from public.repositories existing
    where existing.workspace_id=repository_row.workspace_id
      and existing.selected_for_protection and existing.id<>p_repository_id
  ) >= private.workspace_repository_limit(repository_row.workspace_id) then
    raise exception 'repository_quota_exceeded' using errcode='22023';
  end if;
  if p_selected and (
    repository_row.status<>'available' or not exists (
      select 1 from public.repository_connections connection
      where connection.id=repository_row.connection_id
        and connection.workspace_id=repository_row.workspace_id and connection.status='connected'
    )
  ) then raise exception 'repository_unavailable' using errcode='22023'; end if;

  select count(distinct dependency_id)::integer into dependency_count
  from unnest(p_dependency_ids) dependency_id;
  if dependency_count<>cardinality(p_dependency_ids) then
    raise exception 'duplicate_dependency' using errcode='22023';
  end if;
  if dependency_count>0 and dependency_count<>(
    select count(*) from public.workspace_dependencies dependency
    where dependency.workspace_id=repository_row.workspace_id
      and dependency.id=any(p_dependency_ids)
  ) then raise exception 'dependency_not_found' using errcode='P0002'; end if;
  if p_selected and exists (
    select 1 from public.workspace_dependencies dependency
    join public.workspace_products product
      on product.id=dependency.protected_product_id and product.workspace_id=dependency.workspace_id
    where dependency.workspace_id=repository_row.workspace_id
      and dependency.id=any(p_dependency_ids) and product.status<>'protected'
  ) then raise exception 'product_not_available' using errcode='22023'; end if;

  delete from public.workspace_repository_access
  where repository_id=p_repository_id and workspace_id=repository_row.workspace_id;
  if p_selected then
    insert into public.workspace_repository_access (workspace_id,workspace_dependency_id,repository_id)
    select repository_row.workspace_id,dependency_id,p_repository_id
    from unnest(p_dependency_ids) dependency_id;
    select count(distinct dependency.protected_product_id)::integer into protected_product_count
    from public.workspace_dependencies dependency
    where dependency.workspace_id=repository_row.workspace_id and dependency.id=any(p_dependency_ids);
    update public.workspace_product_repositories mapping set status='inactive',updated_at=now()
      where mapping.workspace_id=repository_row.workspace_id and mapping.repository_id=p_repository_id
        and mapping.status='active'
        and mapping.protected_product_id not in (
          select distinct dependency.protected_product_id
          from public.workspace_dependencies dependency
          where dependency.workspace_id=repository_row.workspace_id and dependency.id=any(p_dependency_ids)
        );
    insert into public.workspace_product_repositories
      (workspace_id,protected_product_id,repository_id,status,provenance,created_by,updated_at)
    select repository_row.workspace_id,dependency.protected_product_id,p_repository_id,
      'active','user_selected',actor_id,now()
    from public.workspace_dependencies dependency
    where dependency.workspace_id=repository_row.workspace_id and dependency.id=any(p_dependency_ids)
    group by dependency.protected_product_id
    on conflict (protected_product_id,repository_id) do update
      set status='active',provenance='user_selected',created_by=excluded.created_by,updated_at=now();
    update public.repositories set selected_for_protection=true,updated_at=now()
      where id=p_repository_id and workspace_id=repository_row.workspace_id;
  else
    update public.workspace_product_repositories set status='inactive',updated_at=now()
      where workspace_id=repository_row.workspace_id and repository_id=p_repository_id and status='active';
    update public.repositories set selected_for_protection=false,updated_at=now()
      where id=p_repository_id and workspace_id=repository_row.workspace_id;
  end if;
  return jsonb_build_object(
    'repositoryId',p_repository_id,
    'selectedForProtection',p_selected,
    'dependencyCount',dependency_count,
    'productCount',case when p_selected then protected_product_count else 0 end
  );
end;
$$;
revoke all on function public.set_repository_protection(uuid,boolean,uuid[]) from public,anon;
grant execute on function public.set_repository_protection(uuid,boolean,uuid[]) to authenticated;

-- Archival releases repository quota and the compatibility flag without deleting history.
create or replace function public.archive_workspace_product(p_workspace_id uuid,p_product_id uuid)
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
  update public.workspace_product_repositories set status='inactive',updated_at=now()
    where workspace_id=p_workspace_id and protected_product_id=p_product_id and status='active';
  update public.repositories repository set selected_for_protection=exists (
      select 1 from public.workspace_product_repositories mapping
      join public.workspace_products product
        on product.id=mapping.protected_product_id and product.workspace_id=mapping.workspace_id
      where mapping.workspace_id=p_workspace_id and mapping.repository_id=repository.id
        and mapping.status='active' and product.status='protected'
    ),updated_at=now()
    where repository.workspace_id=p_workspace_id and exists (
      select 1 from public.workspace_product_repositories mapping
      where mapping.workspace_id=p_workspace_id and mapping.repository_id=repository.id
        and mapping.protected_product_id=p_product_id
    );
  update public.workspace_dependencies set monitoring_enabled=false
    where protected_product_id=p_product_id and workspace_id=p_workspace_id;
  perform private.retire_product_preflight(p_workspace_id,p_product_id);
  return jsonb_build_object('workspaceId',p_workspace_id,'productId',p_product_id,'status','archived');
end;
$$;
revoke all on function public.archive_workspace_product(uuid,uuid) from public,anon;
grant execute on function public.archive_workspace_product(uuid,uuid) to authenticated;
