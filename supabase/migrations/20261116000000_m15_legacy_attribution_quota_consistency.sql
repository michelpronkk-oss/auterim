-- Keep legacy compatibility decisions aligned with the canonical Product graph.
-- A legacy selected repository counts only when its access evidence attributes it
-- to exactly one protected Product. Explicit active mappings remain authoritative.
create or replace function private.m15_repository_counts_toward_protection(
  p_workspace_id uuid,
  p_repository_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_product_repositories mapping
    join public.workspace_products product
      on product.id=mapping.protected_product_id and product.workspace_id=mapping.workspace_id
    where mapping.workspace_id=p_workspace_id
      and mapping.repository_id=p_repository_id
      and mapping.status='active'
      and product.status='protected'
  ) or exists (
    select 1
    from public.repositories repository
    join public.workspace_repository_access access
      on access.workspace_id=repository.workspace_id and access.repository_id=repository.id
    join public.workspace_dependencies dependency
      on dependency.workspace_id=access.workspace_id
      and dependency.id=access.workspace_dependency_id
    join public.workspace_products product
      on product.workspace_id=dependency.workspace_id
      and product.id=dependency.protected_product_id
    where repository.workspace_id=p_workspace_id
      and repository.id=p_repository_id
      and repository.selected_for_protection
      and not exists (
        select 1 from public.workspace_product_repositories history
        where history.workspace_id=repository.workspace_id
          and history.repository_id=repository.id
      )
    group by repository.id
    having count(distinct dependency.protected_product_id)=1
      and bool_or(product.status='protected')
  )
$$;
revoke all on function private.m15_repository_counts_toward_protection(uuid,uuid)
  from public,anon,authenticated;
grant execute on function private.m15_repository_counts_toward_protection(uuid,uuid)
  to service_role;

create or replace function private.workspace_protected_repository_usage(p_workspace_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.repositories repository
  where repository.workspace_id=p_workspace_id
    and private.m15_repository_counts_toward_protection(p_workspace_id,repository.id)
$$;
revoke all on function private.workspace_protected_repository_usage(uuid)
  from public,anon,authenticated;
grant execute on function private.workspace_protected_repository_usage(uuid)
  to service_role;

-- Replace the legacy implementation's raw selected-row quota check. The public
-- wrapper below still validates dependency attribution before calling this body.
create or replace function public.set_repository_protection_legacy_attribution(
  p_repository_id uuid,
  p_selected boolean,
  p_dependency_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
    private.workspace_protected_repository_usage(repository_row.workspace_id)
      - case when private.m15_repository_counts_toward_protection(
          repository_row.workspace_id,p_repository_id
        ) then 1 else 0 end
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
revoke all on function public.set_repository_protection_legacy_attribution(uuid,boolean,uuid[])
  from public,anon,authenticated,service_role;

-- The older validator enforces the compatibility mirror internally. Repair that
-- mirror only after the canonical Product predicate passes and the repository
-- is available; this keeps the delegated claim safe without making the mirror an
-- independent authorization source.
create or replace function public.claim_remediation_validation(p_queue_id uuid,p_attempt integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_queue public.remediation_validation_queue%rowtype;
  v_proposal public.remediation_proposals%rowtype;
  v_repository_id uuid;
  v_claim uuid;
begin
  select * into v_queue from public.remediation_validation_queue where id=p_queue_id;
  if not found or v_queue.attempt_count<>p_attempt then return null; end if;
  select * into v_proposal from public.remediation_proposals
    where id=v_queue.remediation_proposal_id and workspace_id=v_queue.workspace_id;
  if not found then return null; end if;
  begin
    v_repository_id := (v_proposal.generation_metadata->'repository'->>'id')::uuid;
  exception when others then
    v_repository_id := null;
  end;
  perform 1 from public.workspaces where id=v_queue.workspace_id for update;
  if v_repository_id is null or not private.m15_product_repository_is_current(
    v_queue.workspace_id,v_proposal.product_id,v_repository_id
  ) then
    update public.remediation_validation_queue
    set status='denied',claim_token=null,lease_until=null,error_category='product_repository_unavailable'
    where id=p_queue_id and workspace_id=v_queue.workspace_id and attempt_count=p_attempt
      and status='dispatched';
    update public.remediation_proposals
      set patch_validation_status='validation_failed'
      where id=v_proposal.id and workspace_id=v_queue.workspace_id and status='prepared';
    return null;
  end if;
  update public.repositories repository
  set selected_for_protection=true,updated_at=now()
  where repository.workspace_id=v_queue.workspace_id
    and repository.id=v_repository_id
    and not repository.selected_for_protection
    and repository.status='available'
    and exists (
      select 1 from public.workspace_product_repositories mapping
      where mapping.workspace_id=v_queue.workspace_id
        and mapping.protected_product_id=v_proposal.product_id
        and mapping.repository_id=v_repository_id
        and mapping.status='active'
    )
    and exists (
      select 1 from public.repository_connections connection
      where connection.id=repository.connection_id
        and connection.workspace_id=v_queue.workspace_id
        and connection.status='connected'
    );
  v_claim := public.claim_remediation_validation_legacy(p_queue_id,p_attempt);
  return v_claim;
end;
$$;
revoke all on function public.claim_remediation_validation(uuid,integer)
  from public,anon,authenticated;
grant execute on function public.claim_remediation_validation(uuid,integer)
  to service_role;
