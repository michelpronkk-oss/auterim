-- selected_for_protection is a compatibility mirror once a repository has any
-- product-mapping history. Worker authority must be tied to the exact product.
create function private.m15_product_repository_is_current(
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
  )
$$;
revoke all on function private.m15_product_repository_is_current(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function private.m15_product_repository_is_current(uuid,uuid,uuid) to service_role;

create function public.get_product_source_observation_states(p_workspace_id uuid,p_source_ids uuid[])
returns table(source_id uuid,snapshot_id uuid,observed_at timestamptz,scan_status text,scan_finished_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.workspace_members member
    where member.workspace_id=p_workspace_id and member.user_id=auth.uid()
  ) then
    raise exception 'Workspace is unavailable' using errcode='42501';
  end if;
  if coalesce(cardinality(p_source_ids),0)>500 then
    raise exception 'Too many sources' using errcode='22023';
  end if;
  return query
    select requested.id,snapshot.id,snapshot.created_at,scan.status,scan.finished_at
    from unnest(coalesce(p_source_ids,'{}'::uuid[])) requested(id)
    join public.source_catalog source on source.id=requested.id and source.enabled
    left join lateral (
      select item.id,item.created_at from public.source_snapshots item
      where item.source_id=source.id order by item.created_at desc,item.id desc limit 1
    ) snapshot on true
    left join lateral (
      select item.status,item.finished_at from public.scan_runs item
      where item.source_id=source.id and item.finished_at is not null
      order by item.finished_at desc,item.id desc limit 1
    ) scan on true
    where exists (
      select 1 from public.workspace_dependencies dependency
      where dependency.workspace_id=p_workspace_id and dependency.dependency_id=source.dependency_id
    );
end;
$$;
revoke all on function public.get_product_source_observation_states(uuid,uuid[]) from public,anon;
grant execute on function public.get_product_source_observation_states(uuid,uuid[]) to authenticated;

-- Check product/repository identity before the existing claim and persistence
-- rules run. The legacy functions retain their entitlement, lease, dependency,
-- evidence, and transaction semantics.
alter function public.claim_preflight_run(uuid) rename to claim_preflight_run_legacy;
revoke all on function public.claim_preflight_run_legacy(uuid) from public,anon,authenticated,service_role;
create function public.claim_preflight_run(p_run_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_workspace_id uuid;
  v_dependency_id uuid;
  v_product_id uuid;
  v_claim uuid;
begin
  select run.workspace_id,assessment.workspace_dependency_id,dependency.protected_product_id
    into v_workspace_id,v_dependency_id,v_product_id
  from public.preflight_runs run
  join public.impact_assessments assessment
    on assessment.id=run.impact_assessment_id and assessment.workspace_id=run.workspace_id
  join public.workspace_dependencies dependency
    on dependency.id=assessment.workspace_dependency_id and dependency.workspace_id=assessment.workspace_id
  join public.workspace_products product
    on product.id=dependency.protected_product_id and product.workspace_id=dependency.workspace_id
  where run.id=p_run_id and product.status='protected' and dependency.monitoring_enabled;
  if v_workspace_id is null then return null; end if;
  perform 1 from public.workspaces where id=v_workspace_id for update;
  if not exists (
    select 1
    from public.workspace_repository_access access
    join public.repositories repository
      on repository.id=access.repository_id and repository.workspace_id=access.workspace_id
    join public.repository_connections connection
      on connection.id=repository.connection_id and connection.workspace_id=repository.workspace_id
    where access.workspace_id=v_workspace_id and access.workspace_dependency_id=v_dependency_id
      and repository.status='available' and connection.status='connected'
      and private.m15_product_repository_is_current(v_workspace_id,v_product_id,repository.id)
  ) then return null; end if;
  v_claim := public.claim_preflight_run_legacy(p_run_id);
  return v_claim;
end;
$$;
revoke all on function public.claim_preflight_run(uuid) from public,anon,authenticated;
grant execute on function public.claim_preflight_run(uuid) to service_role;

alter function public.save_preflight_result(uuid,uuid,uuid[],jsonb) rename to save_preflight_result_legacy;
revoke all on function public.save_preflight_result_legacy(uuid,uuid,uuid[],jsonb) from public,anon,authenticated,service_role;
create function public.save_preflight_result(
  p_run_id uuid,p_claim_token uuid,p_repository_ids uuid[],p_result jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_workspace_id uuid;
  v_dependency_id uuid;
  v_product_id uuid;
begin
  select run.workspace_id,assessment.workspace_dependency_id,dependency.protected_product_id
    into v_workspace_id,v_dependency_id,v_product_id
  from public.preflight_runs run
  join public.impact_assessments assessment
    on assessment.id=run.impact_assessment_id and assessment.workspace_id=run.workspace_id
  join public.workspace_dependencies dependency
    on dependency.id=assessment.workspace_dependency_id and dependency.workspace_id=assessment.workspace_id
  where run.id=p_run_id;
  if v_workspace_id is null then
    raise exception 'preflight_run_not_running' using errcode='40001';
  end if;
  perform 1 from public.workspaces where id=v_workspace_id for update;
  if p_repository_ids is null or cardinality(p_repository_ids)=0 or exists (
    select 1 from unnest(p_repository_ids) repository_id
    where not private.m15_product_repository_is_current(v_workspace_id,v_product_id,repository_id)
  ) then
    raise exception 'preflight_repository_product_access_revoked' using errcode='42501';
  end if;
  perform public.save_preflight_result_legacy(p_run_id,p_claim_token,p_repository_ids,p_result);
end;
$$;
revoke all on function public.save_preflight_result(uuid,uuid,uuid[],jsonb) from public,anon,authenticated;
grant execute on function public.save_preflight_result(uuid,uuid,uuid[],jsonb) to service_role;

alter function public.claim_remediation_preparation(uuid,integer) rename to claim_remediation_preparation_legacy;
revoke all on function public.claim_remediation_preparation_legacy(uuid,integer) from public,anon,authenticated,service_role;
create function public.claim_remediation_preparation(p_queue_id uuid,p_attempt integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_queue public.remediation_preparation_queue%rowtype;
  v_dependency_id uuid;
  v_product_id uuid;
  v_claim uuid;
begin
  select * into v_queue from public.remediation_preparation_queue where id=p_queue_id;
  if not found or v_queue.attempt_count<>p_attempt then return null; end if;
  select dependency.id,dependency.protected_product_id into v_dependency_id,v_product_id
  from public.impact_assessments assessment
  join public.workspace_dependencies dependency
    on dependency.id=assessment.workspace_dependency_id and dependency.workspace_id=assessment.workspace_id
  where assessment.id=v_queue.impact_assessment_id and assessment.workspace_id=v_queue.workspace_id;
  if v_dependency_id is null then return null; end if;
  perform 1 from public.workspaces where id=v_queue.workspace_id for update;
  if not exists (
    select 1 from public.preflight_findings finding
    join public.repositories repository
      on repository.id=finding.repository_id and repository.workspace_id=finding.workspace_id
    join public.repository_connections connection
      on connection.id=repository.connection_id and connection.workspace_id=repository.workspace_id
    join public.workspace_repository_access access
      on access.workspace_id=finding.workspace_id and access.repository_id=finding.repository_id
    where finding.workspace_id=v_queue.workspace_id and finding.preflight_run_id=v_queue.preflight_run_id
      and finding.verification='verified' and access.workspace_dependency_id=v_dependency_id
      and repository.status='available' and connection.status='connected'
      and private.m15_product_repository_is_current(v_queue.workspace_id,v_product_id,repository.id)
  ) then
    update public.remediation_preparation_queue
    set status='denied',claim_token=null,lease_until=null,error_category='product_repository_unavailable'
    where id=p_queue_id and workspace_id=v_queue.workspace_id and status='dispatched'
      and attempt_count=p_attempt;
    return null;
  end if;
  v_claim := public.claim_remediation_preparation_legacy(p_queue_id,p_attempt);
  return v_claim;
end;
$$;
revoke all on function public.claim_remediation_preparation(uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_remediation_preparation(uuid,integer) to service_role;

alter function public.claim_remediation_validation(uuid,integer) rename to claim_remediation_validation_legacy;
revoke all on function public.claim_remediation_validation_legacy(uuid,integer) from public,anon,authenticated,service_role;
create function public.claim_remediation_validation(p_queue_id uuid,p_attempt integer)
returns uuid language plpgsql security definer set search_path = '' as $$
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
  v_claim := public.claim_remediation_validation_legacy(p_queue_id,p_attempt);
  return v_claim;
end;
$$;
revoke all on function public.claim_remediation_validation(uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_remediation_validation(uuid,integer) to service_role;

alter function public.complete_remediation_preparation(uuid,uuid,text,jsonb,text)
  rename to complete_remediation_preparation_legacy;
revoke all on function public.complete_remediation_preparation_legacy(uuid,uuid,text,jsonb,text)
  from public,anon,authenticated,service_role;
create function public.complete_remediation_preparation(
  p_queue_id uuid,p_claim_token uuid,p_outcome text,p_proposal jsonb default null,p_error_category text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_queue public.remediation_preparation_queue%rowtype;
  v_candidate public.remediation_proposals%rowtype;
  v_repository_id uuid;
  v_outcome text := p_outcome;
  v_error_category text := p_error_category;
begin
  if v_outcome='completed' then
    select * into v_queue from public.remediation_preparation_queue where id=p_queue_id;
    if v_queue.id is not null then
      perform 1 from public.workspaces where id=v_queue.workspace_id for update;
    end if;
    if jsonb_typeof(p_proposal)='object' then
      select * into v_candidate from jsonb_populate_record(null::public.remediation_proposals,p_proposal);
      begin
        v_repository_id := (v_candidate.generation_metadata->'repository'->>'id')::uuid;
      exception when others then
        v_repository_id := null;
      end;
    end if;
    if v_queue.id is null or v_repository_id is null or not private.m15_product_repository_is_current(
      v_queue.workspace_id,v_candidate.product_id,v_repository_id
    ) then
      v_outcome := 'denied';
      v_error_category := 'product_repository_unavailable';
    end if;
  end if;
  return public.complete_remediation_preparation_legacy(
    p_queue_id,p_claim_token,v_outcome,
    case when v_outcome='completed' then p_proposal else null end,v_error_category
  );
end;
$$;
revoke all on function public.complete_remediation_preparation(uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.complete_remediation_preparation(uuid,uuid,text,jsonb,text) to service_role;

alter function public.complete_remediation_validation(uuid,uuid,text,text,jsonb,text,integer)
  rename to complete_remediation_validation_legacy;
revoke all on function public.complete_remediation_validation_legacy(uuid,uuid,text,text,jsonb,text,integer)
  from public,anon,authenticated,service_role;
create function public.complete_remediation_validation(
  p_queue_id uuid,p_claim_token uuid,p_outcome text,p_error_category text,
  p_commands jsonb,p_diagnostics text,p_duration_ms integer
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_queue public.remediation_validation_queue%rowtype;
  v_proposal public.remediation_proposals%rowtype;
  v_repository_id uuid;
  v_outcome text := p_outcome;
  v_error_category text := p_error_category;
  v_diagnostics text := p_diagnostics;
begin
  select * into v_queue from public.remediation_validation_queue where id=p_queue_id;
  select * into v_proposal from public.remediation_proposals
    where id=v_queue.remediation_proposal_id and workspace_id=v_queue.workspace_id;
  if v_outcome in ('validated','validation_failed') then
    if v_queue.id is not null then
      perform 1 from public.workspaces where id=v_queue.workspace_id for update;
    end if;
    begin
      v_repository_id := (v_proposal.generation_metadata->'repository'->>'id')::uuid;
    exception when others then
      v_repository_id := null;
    end;
    if v_queue.id is null or v_proposal.id is null or v_repository_id is null
      or not private.m15_product_repository_is_current(
        v_queue.workspace_id,v_proposal.product_id,v_repository_id
      ) then
      v_outcome := 'denied';
      v_error_category := 'product_repository_unavailable';
      v_diagnostics := left(coalesce(v_diagnostics,'') || E'\nValidation was denied because the product repository mapping is no longer active.',4000);
    end if;
  end if;
  perform public.complete_remediation_validation_legacy(
    p_queue_id,p_claim_token,v_outcome,v_error_category,p_commands,v_diagnostics,p_duration_ms
  );
end;
$$;
revoke all on function public.complete_remediation_validation(uuid,uuid,text,text,jsonb,text,integer) from public,anon,authenticated;
grant execute on function public.complete_remediation_validation(uuid,uuid,text,text,jsonb,text,integer) to service_role;
