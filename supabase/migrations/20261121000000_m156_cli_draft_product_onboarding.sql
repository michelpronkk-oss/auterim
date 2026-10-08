-- M15.6: permit the explicitly approved CLI workflow while a Product is still in onboarding.
-- Local discovery remains Product-scoped metadata and never activates protection.

create or replace function public.approve_cli_connect_session(p_user_code_hash text,p_actor_user_id uuid,
  p_workspace_id uuid,p_company_id uuid,p_product_id uuid)
returns table(session_id uuid,state text,expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_session private.cli_connect_sessions%rowtype;
begin
  if p_user_code_hash !~ '^[0-9a-f]{64}$' or p_actor_user_id is null then
    raise exception 'invalid_cli_authorization' using errcode='22023';
  end if;
  select * into v_session from private.cli_connect_sessions where user_code_hash=p_user_code_hash for update;
  if not found then raise exception 'cli_connect_unavailable' using errcode='P0002'; end if;
  if v_session.state<>'pending' or v_session.expires_at<=now() then
    update private.cli_connect_sessions session set state='expired'
      where session.id=v_session.id and session.state='pending' and session.expires_at<=now();
    raise exception 'cli_connect_unavailable' using errcode='P0002';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id=p_workspace_id
      and m.user_id=p_actor_user_id and m.role in ('owner','admin')) then
    raise exception 'owner_or_admin_required' using errcode='42501';
  end if;
  if not exists (select 1 from public.workspace_products p join public.product_onboarding_progress o
      on o.product_id=p.id and o.workspace_id=p.workspace_id where p.id=p_product_id
      and p.workspace_id=p_workspace_id and p.status in ('draft','protected')
      and p.archived_at is null and o.company_id=p_company_id) then
    raise exception 'cli_product_unavailable' using errcode='P0002';
  end if;
  update private.cli_connect_sessions set approval_attempts=approval_attempts+1
    where id=v_session.id and approval_attempts<20;
  if not found then raise exception 'cli_connect_unavailable' using errcode='P0002'; end if;
  update private.cli_connect_sessions session set state='approved',actor_user_id=p_actor_user_id,
    workspace_id=p_workspace_id,company_id=p_company_id,product_id=p_product_id,approved_at=now(),
    credential_expires_at=now()+interval '24 hours' where session.id=v_session.id and session.state='pending';
  if not found then raise exception 'cli_connect_unavailable' using errcode='P0002'; end if;
  return query select v_session.id,'approved'::text,v_session.expires_at;
end;
$$;
revoke all on function public.approve_cli_connect_session(text,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.approve_cli_connect_session(text,uuid,uuid,uuid,uuid) to service_role;

create or replace function public.ingest_cli_discovery(p_credential_hash text,p_payload_digest text,
  p_payload jsonb,p_provider_matches jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session private.cli_connect_sessions%rowtype; v_existing public.cli_scan_runs%rowtype;
  v_run public.cli_scan_runs%rowtype; v_observation jsonb; v_provider_id uuid; v_dependency_id uuid;
  v_scan_id uuid; v_product_status text;
begin
  if p_credential_hash !~ '^[0-9a-f]{64}$' or p_payload_digest !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_payload)<>'object' or jsonb_typeof(p_provider_matches)<>'array' then
    raise exception 'invalid_cli_discovery' using errcode='22023';
  end if;
  select * into v_session from private.cli_connect_sessions where credential_hash=p_credential_hash for update;
  if not found or v_session.state<>'redeemed' or v_session.credential_expires_at<=now()
    or v_session.scope<>'submit_local_discovery' then
    raise exception 'cli_credential_unavailable' using errcode='42501';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id=v_session.workspace_id
      and m.user_id=v_session.actor_user_id) then
    raise exception 'cli_product_unavailable' using errcode='42501';
  end if;
  select p.status into v_product_status
    from public.workspace_products p join public.product_onboarding_progress o
      on o.product_id=p.id and o.workspace_id=p.workspace_id
   where p.id=v_session.product_id and p.workspace_id=v_session.workspace_id
     and p.status in ('draft','protected') and p.archived_at is null
     and o.company_id=v_session.company_id
   for share of p;
  if not found then raise exception 'cli_product_unavailable' using errcode='42501'; end if;
  v_scan_id := (p_payload->>'scanId')::uuid;
  select * into v_existing from public.cli_scan_runs where product_id=v_session.product_id and scan_id=v_scan_id;
  if found then
    if v_existing.payload_digest<>p_payload_digest then raise exception 'cli_scan_id_conflict' using errcode='23505'; end if;
    return jsonb_build_object('runId',v_existing.id,'scanId',v_existing.scan_id,'idempotent',true,'observations',v_existing.observation_count);
  end if;
  if v_session.submission_count>=1 then raise exception 'cli_submission_limit' using errcode='42501'; end if;
  insert into public.cli_scan_runs(workspace_id,company_id,product_id,scan_id,payload_digest,schema_version,
    scanner_version,registry_version,status,project_name,project_identity,scan_stats,observation_count)
  values (v_session.workspace_id,v_session.company_id,v_session.product_id,v_scan_id,p_payload_digest,
    p_payload->>'schemaVersion',p_payload->>'scannerVersion',p_payload->>'registryVersion',p_payload->>'status',
    p_payload#>>'{projectSummary,rootName}',coalesce(p_payload#>'{projectSummary,git}','{}'::jsonb),
    coalesce(p_payload->'stats','{}'::jsonb),jsonb_array_length(p_payload->'observations')) returning * into v_run;
  for v_observation in select value from jsonb_array_elements(p_payload->'observations') loop
    v_provider_id := null; v_dependency_id := null;
    select nullif(match->>'dependencyId','')::uuid into v_provider_id from jsonb_array_elements(p_provider_matches) match
      where match->>'observationId'=v_observation->>'id' limit 1;
    if v_provider_id is not null then
      select d.id into v_dependency_id from public.workspace_dependencies d where d.workspace_id=v_session.workspace_id
        and d.protected_product_id=v_session.product_id and d.dependency_id=v_provider_id limit 1;
    end if;
    insert into public.cli_observations(workspace_id,product_id,scan_run_id,observation_id,evidence_family,
      normalized_identifier,reason_code,confidence,provider_state,provider_id,workspace_dependency_id,
      safe_relative_path,subproject,safe_metadata)
    values (v_session.workspace_id,v_session.product_id,v_run.id,v_observation->>'id',v_observation->>'evidenceFamily',
      v_observation->>'normalizedIdentifier',v_observation->>'reasonCode',(v_observation->>'confidence')::numeric,
      case when v_provider_id is null then 'unknown' else 'known' end,v_provider_id,v_dependency_id,
      v_observation->>'safeRelativePath',v_observation->>'subproject',coalesce(v_observation->'metadata','{}'::jsonb));
  end loop;
  update private.cli_connect_sessions set submission_count=1 where id=v_session.id and submission_count=0;
  if not found then raise exception 'cli_submission_limit' using errcode='42501'; end if;
  return jsonb_build_object('runId',v_run.id,'scanId',v_run.scan_id,'idempotent',false,'observations',v_run.observation_count);
end;
$$;
revoke all on function public.ingest_cli_discovery(text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_cli_discovery(text,text,jsonb,jsonb) to service_role;
