-- M15: product-scoped dependency operations, retry-safe product creation, and
-- serialize Preflight claim/result commits against product archival.

create table private.workspace_product_requests (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 128),
  request_payload jsonb not null,
  response_payload jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now()+interval '30 days'),
  primary key (workspace_id,user_id,idempotency_key)
);
revoke all on table private.workspace_product_requests from public,anon,authenticated;

create function private.prune_workspace_product_requests()
returns integer language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
  with expired as (
    select ctid from private.workspace_product_requests
    where expires_at<=now() order by expires_at limit 500
  )
  delete from private.workspace_product_requests request using expired
  where request.ctid=expired.ctid;
  get diagnostics removed=row_count;
  return removed;
end;
$$;
revoke all on function private.prune_workspace_product_requests() from public,anon,authenticated;
grant execute on function private.prune_workspace_product_requests() to service_role;

create function public.create_workspace_product_idempotent(
  p_workspace_id uuid,
  p_name text,
  p_surfaces jsonb,
  p_replace_product_id uuid,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
  v_payload jsonb;
  v_existing private.workspace_product_requests%rowtype;
  v_response jsonb;
begin
  if v_user_id is null or p_idempotency_key is null
    or char_length(p_idempotency_key) not between 8 and 128 then
    raise exception 'invalid_product_idempotency_key' using errcode='22023';
  end if;
  if not exists(select 1 from public.workspace_members member
    where member.workspace_id=p_workspace_id and member.user_id=v_user_id
      and member.role in ('owner','admin')) then
    raise exception 'owner_or_admin_required' using errcode='42501';
  end if;
  v_payload:=jsonb_build_object(
    'name',btrim(coalesce(p_name,'')),
    'surfaces',coalesce(p_surfaces,'[]'::jsonb),
    'replaceProductId',p_replace_product_id
  );
  perform private.prune_workspace_product_requests();
  perform pg_advisory_xact_lock(hashtextextended(
    p_workspace_id::text || ':' || v_user_id::text || ':' || p_idempotency_key,0));
  select * into v_existing from private.workspace_product_requests request
  where request.workspace_id=p_workspace_id and request.user_id=v_user_id
    and request.idempotency_key=p_idempotency_key and request.expires_at>now();
  if found then
    if v_existing.request_payload is distinct from v_payload then
      raise exception 'product_idempotency_key_reused' using errcode='22023';
    end if;
    return v_existing.response_payload;
  end if;

  v_response:=public.create_workspace_product(p_workspace_id,p_name,p_surfaces,p_replace_product_id);
  insert into private.workspace_product_requests
    (workspace_id,user_id,idempotency_key,request_payload,response_payload,expires_at)
  values(p_workspace_id,v_user_id,p_idempotency_key,v_payload,v_response,now()+interval '30 days')
  on conflict(workspace_id,user_id,idempotency_key) do update set
    request_payload=excluded.request_payload,response_payload=excluded.response_payload,
    created_at=now(),expires_at=excluded.expires_at;
  return v_response;
end;
$$;
revoke all on function public.create_workspace_product_idempotent(uuid,text,jsonb,uuid,text)
  from public,anon;
grant execute on function public.create_workspace_product_idempotent(uuid,text,jsonb,uuid,text)
  to authenticated;

create function public.add_product_dependency_manually(
  p_workspace_id uuid,p_product_id uuid,p_dependency_slug text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
  v_dependency_id uuid;
  v_dependency public.workspace_dependencies%rowtype;
  v_product_status text;
begin
  if v_user_id is null or not exists(select 1 from public.workspace_members member
    where member.workspace_id=p_workspace_id and member.user_id=v_user_id
      and member.role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode='42501';
  end if;
  perform 1 from public.workspaces workspace where workspace.id=p_workspace_id for update;
  select product.status into v_product_status from public.workspace_products product
  where product.id=p_product_id and product.workspace_id=p_workspace_id for update;
  if v_product_status is null then raise exception 'product_not_found' using errcode='P0002'; end if;
  if v_product_status='archived' then raise exception 'product_archived' using errcode='22023'; end if;
  select catalog.id into v_dependency_id from public.dependency_catalog catalog
  where catalog.slug=lower(btrim(p_dependency_slug)) and catalog.enabled;
  if v_dependency_id is null then raise exception 'unsupported_dependency' using errcode='P0002'; end if;
  insert into public.workspace_dependencies
    (workspace_id,protected_product_id,dependency_id,selected_by,origin,monitoring_enabled,protection_started_at)
  values(p_workspace_id,p_product_id,v_dependency_id,v_user_id,'manual',v_product_status='protected',
    case when v_product_status='protected' then now() else null end)
  on conflict(protected_product_id,dependency_id) do update set origin='manual'
  returning * into v_dependency;
  return jsonb_build_object('workspaceDependencyId',v_dependency.id,
    'workspaceId',p_workspace_id,'productId',p_product_id,
    'dependencyId',v_dependency_id,'origin','manual');
end;
$$;
revoke all on function public.add_product_dependency_manually(uuid,uuid,text) from public,anon;
grant execute on function public.add_product_dependency_manually(uuid,uuid,text) to authenticated;

create function public.get_product_dependencies(p_workspace_id uuid,p_product_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := (select auth.uid()); v_result jsonb;
begin
  if v_user_id is null or not exists(select 1 from public.workspace_members member
    where member.workspace_id=p_workspace_id and member.user_id=v_user_id
      and member.role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode='42501';
  end if;
  if not exists(select 1 from public.workspace_products product
    where product.id=p_product_id and product.workspace_id=p_workspace_id) then
    raise exception 'product_not_found' using errcode='P0002';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',dependency.id,
    'workspaceId',dependency.workspace_id,
    'productId',dependency.protected_product_id,
    'dependencyId',dependency.dependency_id,
    'providerName',catalog.name,
    'providerSlug',catalog.slug,
    'category',catalog.category,
    'origin',dependency.origin,
    'monitoringEnabled',dependency.monitoring_enabled,
    'protectionStartedAt',dependency.protection_started_at,
    'context',case when context.workspace_dependency_id is null then null else jsonb_build_object(
      'usedFor',context.used_for,'criticality',context.criticality,
      'productionCritical',context.production_critical,'contextNote',context.context_note) end
  ) order by catalog.name), '[]'::jsonb) into v_result
  from public.workspace_dependencies dependency
  join public.dependency_catalog catalog on catalog.id=dependency.dependency_id
  left join public.dependency_context context on context.workspace_dependency_id=dependency.id
    and context.workspace_id=dependency.workspace_id
  where dependency.workspace_id=p_workspace_id and dependency.protected_product_id=p_product_id;
  return v_result;
end;
$$;
revoke all on function public.get_product_dependencies(uuid,uuid) from public,anon;
grant execute on function public.get_product_dependencies(uuid,uuid) to authenticated;

create function public.decide_product_dependency_candidate(
  p_workspace_id uuid,p_product_id uuid,p_candidate_id uuid,p_decision text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
  v_candidate public.discovered_dependencies%rowtype;
  v_dependency public.workspace_dependencies%rowtype;
  v_product_status text;
begin
  if v_user_id is null or not exists(select 1 from public.workspace_members member
    where member.workspace_id=p_workspace_id and member.user_id=v_user_id
      and member.role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode='42501';
  end if;
  if p_decision not in ('confirmed','rejected') then
    raise exception 'Decision is invalid' using errcode='22023';
  end if;
  perform 1 from public.workspaces workspace where workspace.id=p_workspace_id for update;
  select product.status into v_product_status from public.workspace_products product
  where product.id=p_product_id and product.workspace_id=p_workspace_id for update;
  if v_product_status is null then raise exception 'product_not_found' using errcode='P0002'; end if;
  if v_product_status='archived' then raise exception 'product_archived' using errcode='22023'; end if;
  select * into v_candidate from public.discovered_dependencies candidate
  where candidate.id=p_candidate_id and candidate.workspace_id=p_workspace_id for update;
  if not found then raise exception 'Discovery candidate was not found' using errcode='P0002'; end if;
  if p_decision='rejected' then
    if v_candidate.status='confirmed' then
      raise exception 'Candidate decision is already recorded' using errcode='22023';
    end if;
    update public.discovered_dependencies set status='rejected'
    where id=p_candidate_id and workspace_id=p_workspace_id;
    return jsonb_build_object('candidateId',p_candidate_id,'decision','rejected',
      'productId',p_product_id,'workspaceDependencyId',null);
  end if;
  if v_candidate.status='rejected' then
    raise exception 'Candidate decision is already recorded' using errcode='22023';
  end if;
  if not exists(select 1 from public.dependency_catalog catalog
    where catalog.id=v_candidate.dependency_id and catalog.enabled) then
    raise exception 'unsupported_dependency' using errcode='P0002';
  end if;
  insert into public.workspace_dependencies
    (workspace_id,protected_product_id,dependency_id,selected_by,origin,monitoring_enabled,protection_started_at)
  values(p_workspace_id,p_product_id,v_candidate.dependency_id,v_user_id,'discovered',
    v_product_status='protected',case when v_product_status='protected' then now() else null end)
  on conflict(protected_product_id,dependency_id) do nothing;
  select * into v_dependency from public.workspace_dependencies dependency
  where dependency.workspace_id=p_workspace_id and dependency.protected_product_id=p_product_id
    and dependency.dependency_id=v_candidate.dependency_id;
  insert into public.workspace_dependency_discovery_links
    (workspace_id,workspace_dependency_id,discovered_dependency_id,linked_by)
  values(p_workspace_id,v_dependency.id,p_candidate_id,v_user_id) on conflict do nothing;
  update public.discovered_dependencies set status='confirmed'
  where id=p_candidate_id and workspace_id=p_workspace_id;
  return jsonb_build_object('candidateId',p_candidate_id,'decision','confirmed',
    'productId',p_product_id,'workspaceDependencyId',v_dependency.id,'origin',v_dependency.origin);
end;
$$;
revoke all on function public.decide_product_dependency_candidate(uuid,uuid,uuid,text) from public,anon;
grant execute on function public.decide_product_dependency_candidate(uuid,uuid,uuid,text) to authenticated;

-- Keep the legacy onboarding RPC's lock order aligned with product operations
-- (workspace → product → candidate) to avoid deadlocks during confirmation.
create or replace function public.decide_onboarding_dependency_candidate(
  p_workspace_id uuid,p_candidate_id uuid,p_decision text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
  v_candidate public.discovered_dependencies%rowtype;
  v_product_id uuid;
  v_workspace_dependency_id uuid;
  v_origin text;
begin
  if v_user_id is null or not exists(select 1 from public.workspace_members member
    where member.workspace_id=p_workspace_id and member.user_id=v_user_id
      and member.role in ('owner','admin','member')) then
    raise exception 'Workspace is not available to this user' using errcode='42501';
  end if;
  if p_decision not in ('confirmed','rejected') then
    raise exception 'Decision is invalid' using errcode='22023';
  end if;
  perform 1 from public.workspaces workspace where workspace.id=p_workspace_id for update;
  select product.id into v_product_id from public.workspace_products product
  where product.workspace_id=p_workspace_id and product.is_default and product.status<>'archived' for update;
  if v_product_id is null then raise exception 'Default product is unavailable' using errcode='23514'; end if;
  select * into v_candidate from public.discovered_dependencies candidate
  where candidate.id=p_candidate_id and candidate.workspace_id=p_workspace_id for update;
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
  insert into public.workspace_dependencies
    (workspace_id,protected_product_id,dependency_id,selected_by,origin,monitoring_enabled,protection_started_at)
  values(p_workspace_id,v_product_id,v_candidate.dependency_id,v_user_id,'discovered',false,null)
  on conflict(protected_product_id,dependency_id) do nothing;
  select id,origin into v_workspace_dependency_id,v_origin from public.workspace_dependencies dependency
  where dependency.workspace_id=p_workspace_id and dependency.protected_product_id=v_product_id
    and dependency.dependency_id=v_candidate.dependency_id;
  insert into public.workspace_dependency_discovery_links
    (workspace_id,workspace_dependency_id,discovered_dependency_id,linked_by)
  values(p_workspace_id,v_workspace_dependency_id,p_candidate_id,v_user_id) on conflict do nothing;
  update public.discovered_dependencies set status='confirmed'
  where id=p_candidate_id and workspace_id=p_workspace_id;
  return jsonb_build_object('candidateId',p_candidate_id,'decision','confirmed',
    'workspaceDependencyId',v_workspace_dependency_id,'origin',v_origin);
end;
$$;
revoke all on function public.decide_onboarding_dependency_candidate(uuid,uuid,text) from public,anon;
grant execute on function public.decide_onboarding_dependency_candidate(uuid,uuid,text) to authenticated;

-- Serialize claims and result commits against archive/replace. Product lifecycle
-- mutations lock the workspace first; use that same lock order here.
create or replace function public.claim_preflight_run(p_run_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  claim_token uuid := gen_random_uuid();
  target_workspace_id uuid;
begin
  select run.workspace_id into target_workspace_id from public.preflight_runs run where run.id=p_run_id;
  if target_workspace_id is null then return null; end if;
  perform 1 from public.workspaces workspace where workspace.id=target_workspace_id for update;
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
declare
  target_workspace_id uuid;
  run_row public.preflight_runs%rowtype;
  finding jsonb;
  dependency_id uuid;
begin
  select run.workspace_id into target_workspace_id from public.preflight_runs run where run.id=p_run_id;
  if target_workspace_id is null then raise exception 'preflight_run_not_running' using errcode='40001'; end if;
  perform 1 from public.workspaces workspace where workspace.id=target_workspace_id for update;
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
