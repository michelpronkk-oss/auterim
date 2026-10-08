-- A legacy selected flag may be attributed only when all persisted dependency
-- evidence for the repository resolves to exactly one Product in the workspace.
create or replace function private.m15_product_repository_is_current(
  p_workspace_id uuid,
  p_product_id uuid,
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
    where mapping.workspace_id=p_workspace_id
      and mapping.protected_product_id=p_product_id
      and mapping.repository_id=p_repository_id
      and mapping.status='active'
  ) or (
    not exists (
      select 1 from public.workspace_product_repositories history
      where history.workspace_id=p_workspace_id and history.repository_id=p_repository_id
    )
    and exists (
      select 1 from public.repositories repository
      where repository.workspace_id=p_workspace_id and repository.id=p_repository_id
        and repository.selected_for_protection
    )
    and exists (
      select 1
      from public.workspace_repository_access access
      join public.workspace_dependencies dependency
        on dependency.id=access.workspace_dependency_id
        and dependency.workspace_id=access.workspace_id
      where access.workspace_id=p_workspace_id
        and access.repository_id=p_repository_id
        and dependency.protected_product_id=p_product_id
    )
    and not exists (
      select 1
      from public.workspace_repository_access access
      join public.workspace_dependencies dependency
        on dependency.id=access.workspace_dependency_id
        and dependency.workspace_id=access.workspace_id
      where access.workspace_id=p_workspace_id
        and access.repository_id=p_repository_id
        and dependency.protected_product_id<>p_product_id
    )
  )
$$;
revoke all on function private.m15_product_repository_is_current(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function private.m15_product_repository_is_current(uuid,uuid,uuid)
  to service_role;

-- Keep workspace repository quota aligned with the same deterministic legacy rule.
create or replace function private.workspace_protected_repository_usage(p_workspace_id uuid)
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
    join public.workspace_repository_access access
      on access.workspace_id=repository.workspace_id and access.repository_id=repository.id
    join public.workspace_dependencies dependency
      on dependency.workspace_id=access.workspace_id
      and dependency.id=access.workspace_dependency_id
    join public.workspace_products product
      on product.workspace_id=dependency.workspace_id
      and product.id=dependency.protected_product_id
    where repository.workspace_id=p_workspace_id and repository.selected_for_protection
      and not exists (
        select 1 from public.workspace_product_repositories mapping
        where mapping.workspace_id=repository.workspace_id and mapping.repository_id=repository.id
      )
    group by repository.id
    having count(distinct dependency.protected_product_id)=1
      and bool_or(product.status='protected')
  ) protected_repositories
$$;
revoke all on function private.workspace_protected_repository_usage(uuid)
  from public,anon,authenticated;
grant execute on function private.workspace_protected_repository_usage(uuid)
  to service_role;

-- The compatibility mutation accepts dependency IDs, not an explicit Product ID.
-- It may only translate those IDs when they belong to one Product.
alter function public.set_repository_protection(uuid,boolean,uuid[])
  rename to set_repository_protection_legacy_attribution;
revoke all on function public.set_repository_protection_legacy_attribution(uuid,boolean,uuid[])
  from public,anon,authenticated,service_role;
create function public.set_repository_protection(
  p_repository_id uuid,p_selected boolean,p_dependency_ids uuid[]
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_workspace_id uuid;
  v_product_count integer;
begin
  if p_selected and p_repository_id is not null and p_dependency_ids is not null then
    select repository.workspace_id into v_workspace_id
    from public.repositories repository where repository.id=p_repository_id;
    if v_workspace_id is not null then
      select count(distinct dependency.protected_product_id)::integer into v_product_count
      from public.workspace_dependencies dependency
      where dependency.workspace_id=v_workspace_id
        and dependency.id=any(p_dependency_ids);
      if v_product_count>1 then
        raise exception 'product_scoped_repository_mapping_required' using errcode='22023';
      end if;
    end if;
  end if;
  return public.set_repository_protection_legacy_attribution(
    p_repository_id,p_selected,p_dependency_ids
  );
end;
$$;
revoke all on function public.set_repository_protection(uuid,boolean,uuid[]) from public,anon;
grant execute on function public.set_repository_protection(uuid,boolean,uuid[]) to authenticated;

-- The legacy workspace repository selection API must not turn ambiguous
-- dependency evidence into Product-level protection. Product-scoped mapping
-- APIs remain the path for explicit multi-Product intent.
alter function public.request_business_handoff(uuid,uuid,uuid,text)
  rename to request_business_handoff_legacy_attribution;
revoke all on function public.request_business_handoff_legacy_attribution(uuid,uuid,uuid,text)
  from public,anon,authenticated,service_role;
create function public.request_business_handoff(
  p_workspace_id uuid,
  p_preflight_run_id uuid,
  p_repository_id uuid,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_product_id uuid;
begin
  select proposal.product_id into v_product_id
  from public.remediation_proposals proposal
  where proposal.workspace_id=p_workspace_id
    and proposal.preflight_run_id=p_preflight_run_id
    and proposal.generation_metadata->'repository'->>'id'=p_repository_id::text
  order by proposal.created_at desc,proposal.id desc
  limit 1;
  if v_product_id is not null and not private.m15_product_repository_is_current(
    p_workspace_id,v_product_id,p_repository_id
  ) then
    raise exception 'business_handoff_not_eligible' using errcode='42501';
  end if;
  return public.request_business_handoff_legacy_attribution(
    p_workspace_id,p_preflight_run_id,p_repository_id,p_idempotency_key
  );
end;
$$;
revoke all on function public.request_business_handoff(uuid,uuid,uuid,text) from public,anon;
grant execute on function public.request_business_handoff(uuid,uuid,uuid,text) to authenticated;

alter function public.claim_business_handoff_execution(uuid,integer)
  rename to claim_business_handoff_execution_legacy_attribution;
revoke all on function public.claim_business_handoff_execution_legacy_attribution(uuid,integer)
  from public,anon,authenticated,service_role;
create function public.claim_business_handoff_execution(p_request_id uuid,p_attempt integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_request public.business_handoff_requests%rowtype;
  v_product_id uuid;
  v_repository_id uuid;
begin
  select * into v_request from public.business_handoff_requests where id=p_request_id;
  if not found or v_request.attempt_count<>p_attempt then return null; end if;
  perform 1 from public.workspaces where id=v_request.workspace_id for update;
  select proposal.product_id, nullif(proposal.generation_metadata->'repository'->>'id','')::uuid
    into v_product_id,v_repository_id
  from public.remediation_proposals proposal
  where proposal.id=v_request.remediation_proposal_id
    and proposal.workspace_id=v_request.workspace_id;
  if v_product_id is null or v_product_id<>v_request.product_id
    or v_repository_id is distinct from v_request.repository_id
    or not private.m15_product_repository_is_current(
      v_request.workspace_id,v_request.product_id,v_request.repository_id
    ) then
    update public.business_handoff_requests
    set status='denied',claim_token=null,lease_until=null,dispatch_lease_until=null,
        error_category='product_repository_unavailable',completed_at=now()
    where id=p_request_id and workspace_id=v_request.workspace_id
      and status='dispatched' and attempt_count=p_attempt;
    return null;
  end if;
  return public.claim_business_handoff_execution_legacy_attribution(p_request_id,p_attempt);
end;
$$;
revoke all on function public.claim_business_handoff_execution(uuid,integer)
  from public,anon,authenticated;
grant execute on function public.claim_business_handoff_execution(uuid,integer)
  to service_role;

alter function public.complete_business_handoff_preparation(uuid,uuid,text,text,boolean,text)
  rename to complete_business_handoff_preparation_legacy_attribution;
revoke all on function public.complete_business_handoff_preparation_legacy_attribution(
  uuid,uuid,text,text,boolean,text
) from public,anon,authenticated,service_role;
create function public.complete_business_handoff_preparation(
  p_request_id uuid,p_claim_token uuid,p_outcome text,p_prepared_branch text default null,
  p_approval_required boolean default null,p_error_category text default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_request public.business_handoff_requests%rowtype;
  v_outcome text := p_outcome;
  v_error_category text := p_error_category;
begin
  if p_outcome='prepared' then
    select * into v_request from public.business_handoff_requests
    where id=p_request_id for update;
    if found then
      perform 1 from public.workspaces where id=v_request.workspace_id for update;
      if not private.m15_product_repository_is_current(
        v_request.workspace_id,v_request.product_id,v_request.repository_id
      ) then
        v_outcome := 'denied';
        v_error_category := 'product_repository_unavailable';
      end if;
    end if;
  end if;
  return public.complete_business_handoff_preparation_legacy_attribution(
    p_request_id,p_claim_token,v_outcome,
    case when v_outcome='prepared' then p_prepared_branch else null end,
    case when v_outcome='prepared' then p_approval_required else null end,
    v_error_category
  );
end;
$$;
revoke all on function public.complete_business_handoff_preparation(uuid,uuid,text,text,boolean,text)
  from public,anon,authenticated;
grant execute on function public.complete_business_handoff_preparation(
  uuid,uuid,text,text,boolean,text
) to service_role;
