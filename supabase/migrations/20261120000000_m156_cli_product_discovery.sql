-- M15.6 Phase 2: device authorization and Product-scoped local evidence.

alter table public.public_rate_limit_buckets drop constraint public_rate_limit_buckets_policy_check;
alter table public.public_rate_limit_buckets add constraint public_rate_limit_buckets_policy_check
  check (policy in ('public_stack_scan','public_conversion','cli_connect','cli_poll','cli_connect_approval','cli_discovery'));

create or replace function public.claim_public_rate_limit(
  p_policy text,p_fingerprint text,p_limit integer,p_window_seconds integer,p_now timestamptz default now()
)
returns table(allowed boolean,remaining integer,retry_after_seconds integer)
language plpgsql security definer set search_path = '' as $$
declare v_window_start timestamptz; v_count integer;
begin
  if p_policy not in ('public_stack_scan','public_conversion','cli_connect','cli_poll','cli_connect_approval','cli_discovery')
    or p_fingerprint !~ '^[0-9a-f]{64}$' or p_limit<1 or p_limit>100
    or p_window_seconds<1 or p_window_seconds>86400 or p_now is null then
    raise exception 'invalid_rate_limit_claim' using errcode='22023';
  end if;
  v_window_start:=to_timestamp(floor(extract(epoch from p_now)/p_window_seconds)*p_window_seconds);
  insert into public.public_rate_limit_buckets as bucket(policy,client_fingerprint,window_start,request_count)
    values(p_policy,p_fingerprint,v_window_start,1)
    on conflict(policy,client_fingerprint,window_start) do update
      set request_count=least(bucket.request_count+1,p_limit+1)
    returning request_count into v_count;
  with expired as (
    select ctid from public.public_rate_limit_buckets
    where window_start < p_now - interval '2 days'
    limit 1000
  )
  delete from public.public_rate_limit_buckets bucket using expired where bucket.ctid=expired.ctid;
  return query select v_count<=p_limit,greatest(p_limit-v_count,0),
    greatest(1,ceil(extract(epoch from (v_window_start+make_interval(secs=>p_window_seconds)-p_now)))::integer);
end;
$$;
revoke all on function public.claim_public_rate_limit(text,text,integer,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.claim_public_rate_limit(text,text,integer,integer,timestamptz) to service_role;

create table private.cli_connect_sessions (
  id uuid primary key default gen_random_uuid(),
  user_code_hash text not null unique check (user_code_hash ~ '^[0-9a-f]{64}$'),
  poll_secret_hash text not null check (poll_secret_hash ~ '^[0-9a-f]{64}$'),
  credential_hash text not null check (credential_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'pending' check (state in ('pending','approved','redeemed','revoked','expired')),
  scope text not null default 'submit_local_discovery' check (scope = 'submit_local_discovery'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  approved_at timestamptz,
  redeemed_at timestamptz,
  revoked_at timestamptz,
  actor_user_id uuid references auth.users(id) on delete set null,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  product_id uuid,
  credential_expires_at timestamptz,
  last_polled_at timestamptz,
  poll_attempts integer not null default 0 check (poll_attempts between 0 and 1000),
  approval_attempts integer not null default 0 check (approval_attempts between 0 and 100),
  submission_count integer not null default 0 check (submission_count between 0 and 1),
  constraint cli_connect_session_binding_check check (
    (state='pending' and actor_user_id is null and workspace_id is null
      and company_id is null and product_id is null and approved_at is null and credential_expires_at is null)
    or (state='expired' and ((actor_user_id is null and workspace_id is null and company_id is null
      and product_id is null and approved_at is null and credential_expires_at is null)
      or (workspace_id is not null and company_id is not null and product_id is not null
      and approved_at is not null and credential_expires_at is not null)))
    or (state='revoked' and ((actor_user_id is null and workspace_id is null and company_id is null
      and product_id is null and approved_at is null and credential_expires_at is null)
      or (workspace_id is not null and company_id is not null and product_id is not null
      and approved_at is not null and credential_expires_at is not null)))
    or (state in ('approved','redeemed')
      and workspace_id is not null and company_id is not null and product_id is not null
      and approved_at is not null and credential_expires_at is not null)
  ),
  constraint cli_connect_session_company_workspace_fkey foreign key (company_id,workspace_id)
    references public.companies(id,workspace_id) on delete cascade,
  constraint cli_connect_session_product_workspace_fkey foreign key (product_id,workspace_id)
    references public.workspace_products(id,workspace_id) on delete cascade
);
create index cli_connect_sessions_expiry_idx on private.cli_connect_sessions(state,expires_at);
create index cli_connect_sessions_product_idx on private.cli_connect_sessions(workspace_id,product_id,state);
alter table private.cli_connect_sessions enable row level security;
revoke all on private.cli_connect_sessions from public,anon,authenticated;
grant all on private.cli_connect_sessions to service_role;

create function public.create_cli_connect_session(p_session_id uuid,p_user_code_hash text,p_poll_secret_hash text,p_credential_hash text)
returns table(session_id uuid,expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_session private.cli_connect_sessions%rowtype;
begin
  if p_session_id is null or p_user_code_hash !~ '^[0-9a-f]{64}$' or p_poll_secret_hash !~ '^[0-9a-f]{64}$'
    or p_credential_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_cli_connect' using errcode='22023';
  end if;
  insert into private.cli_connect_sessions(id,user_code_hash,poll_secret_hash,credential_hash,expires_at)
    values (p_session_id,p_user_code_hash,p_poll_secret_hash,p_credential_hash,now()+interval '15 minutes')
    returning * into v_session;
  return query select v_session.id,v_session.expires_at;
end;
$$;
revoke all on function public.create_cli_connect_session(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.create_cli_connect_session(uuid,text,text,text) to service_role;

create function public.cancel_cli_connect_session(p_session_id uuid,p_poll_secret_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_session private.cli_connect_sessions%rowtype;
begin
  select * into v_session from private.cli_connect_sessions where id=p_session_id for update;
  if not found or v_session.poll_secret_hash is distinct from p_poll_secret_hash then return false; end if;
  if v_session.state in ('pending','approved','redeemed') then
    update private.cli_connect_sessions set state='revoked',revoked_at=now() where id=v_session.id;
    return true;
  end if;
  return false;
end;
$$;
revoke all on function public.cancel_cli_connect_session(uuid,text) from public,anon,authenticated;
grant execute on function public.cancel_cli_connect_session(uuid,text) to service_role;

create table public.cli_scan_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  company_id uuid not null,
  product_id uuid not null,
  scan_id uuid not null,
  payload_digest text not null check (payload_digest ~ '^[0-9a-f]{64}$'),
  schema_version text not null check (char_length(schema_version) between 1 and 32),
  scanner_version text not null check (char_length(scanner_version) between 1 and 32),
  registry_version text not null check (char_length(registry_version) between 1 and 80),
  status text not null check (status in ('complete','partial')),
  observed_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  project_name text not null check (char_length(project_name) between 1 and 100),
  project_identity jsonb not null default '{}'::jsonb
    check (jsonb_typeof(project_identity)='object' and octet_length(project_identity::text)<=2048),
  scan_stats jsonb not null default '{}'::jsonb
    check (jsonb_typeof(scan_stats)='object' and octet_length(scan_stats::text)<=2048),
  observation_count integer not null check (observation_count between 0 and 1500),
  constraint cli_scan_runs_product_scan_key unique (product_id,scan_id),
  constraint cli_scan_runs_id_workspace_product_key unique (id,workspace_id,product_id),
  constraint cli_scan_runs_company_workspace_fkey foreign key (company_id,workspace_id)
    references public.companies(id,workspace_id) on delete cascade,
  constraint cli_scan_runs_product_workspace_fkey foreign key (product_id,workspace_id)
    references public.workspace_products(id,workspace_id) on delete cascade
);
create index cli_scan_runs_latest_product_idx on public.cli_scan_runs(product_id,received_at desc,id desc);
alter table public.cli_scan_runs enable row level security;
revoke all on public.cli_scan_runs from public,anon,authenticated;
grant select on public.cli_scan_runs to authenticated;
grant all on public.cli_scan_runs to service_role;
create policy cli_scan_runs_select_member on public.cli_scan_runs for select to authenticated
  using ((select private.has_workspace_role(workspace_id,array['owner','admin','member'])));

create table public.cli_observations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  product_id uuid not null,
  scan_run_id uuid not null,
  observation_id text not null check (observation_id ~ '^[a-f0-9]{32}$'),
  evidence_family text not null check (evidence_family in ('package_manifest','environment_variable_name',
    'import_reference','provider_host','model_identifier','configuration_file','framework_runtime','lockfile_identity','git_remote')),
  normalized_identifier text not null check (char_length(normalized_identifier) between 1 and 180),
  reason_code text not null check (reason_code in ('known_package_provider','unmapped_package','framework_package',
    'environment_name','known_environment_provider','imported_provider_package','provider_host_reference',
    'model_reference','configuration_identity','lockfile_identity','sanitized_git_origin')),
  confidence numeric not null check (confidence between 0 and 1),
  provider_state text not null check (provider_state in ('known','unknown')),
  provider_id uuid references public.dependency_catalog(id) on delete restrict,
  workspace_dependency_id uuid,
  safe_relative_path text check (safe_relative_path is null or char_length(safe_relative_path)<=240),
  subproject text check (subproject is null or char_length(subproject)<=180),
  safe_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(safe_metadata)='object' and octet_length(safe_metadata::text)<=2048),
  created_at timestamptz not null default now(),
  constraint cli_observations_run_observation_key unique (scan_run_id,observation_id),
  constraint cli_observations_run_workspace_product_fkey foreign key (scan_run_id,workspace_id,product_id)
    references public.cli_scan_runs(id,workspace_id,product_id) on delete cascade,
  constraint cli_observations_dependency_scope_fkey foreign key (workspace_dependency_id,workspace_id,product_id)
    references public.workspace_dependencies(id,workspace_id,protected_product_id) on delete set null (workspace_dependency_id),
  constraint cli_observations_resolution_state_check check (
    (provider_state='known' and provider_id is not null) or
    (provider_state='unknown' and provider_id is null and workspace_dependency_id is null)
  )
);
create index cli_observations_product_scan_idx on public.cli_observations(product_id,scan_run_id,evidence_family);
create index cli_observations_product_provider_idx on public.cli_observations(product_id,provider_id,created_at desc);
alter table public.cli_observations enable row level security;
revoke all on public.cli_observations from public,anon,authenticated;
grant select on public.cli_observations to authenticated;
grant all on public.cli_observations to service_role;
create policy cli_observations_select_member on public.cli_observations for select to authenticated
  using ((select private.has_workspace_role(workspace_id,array['owner','admin','member'])));

create function public.get_cli_product_provider_coverage(
  p_workspace_id uuid,p_product_id uuid,p_provider_ids uuid[]
)
returns table(provider_id uuid,enabled_source_count bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.has_workspace_role(p_workspace_id,array['owner','admin','member'])
    or not exists (select 1 from public.workspace_products product
      where product.id=p_product_id and product.workspace_id=p_workspace_id)
    or coalesce(cardinality(p_provider_ids),0)>500 then
    raise exception 'cli_product_unavailable' using errcode='42501';
  end if;
  return query
  select requested.id, count(source.id)::bigint
  from (select distinct unnest(coalesce(p_provider_ids,'{}'::uuid[])) as id) requested
  join public.dependency_catalog provider on provider.id=requested.id and provider.enabled
  left join public.source_catalog source on source.dependency_id=provider.id and source.enabled
  group by requested.id order by requested.id;
end;
$$;
revoke all on function public.get_cli_product_provider_coverage(uuid,uuid,uuid[]) from public,anon;
grant execute on function public.get_cli_product_provider_coverage(uuid,uuid,uuid[]) to authenticated;

create function public.approve_cli_connect_session(p_user_code_hash text,p_actor_user_id uuid,
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
      and p.workspace_id=p_workspace_id and p.status='protected' and o.company_id=p_company_id) then
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

create function public.redeem_cli_connect_session(p_session_id uuid,p_poll_secret_hash text)
returns table(state text,credential_hash text,workspace_id uuid,company_id uuid,product_id uuid,scope text,expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_session private.cli_connect_sessions%rowtype;
begin
  select * into v_session from private.cli_connect_sessions where id=p_session_id for update;
  if not found or p_poll_secret_hash !~ '^[0-9a-f]{64}$' or v_session.poll_secret_hash is distinct from p_poll_secret_hash then
    raise exception 'cli_connect_unavailable' using errcode='P0002';
  end if;
  if v_session.expires_at<=now() and v_session.state='pending' then
    update private.cli_connect_sessions session set state='expired' where session.id=v_session.id;
    return query select 'expired'::text,null::text,null::uuid,null::uuid,null::uuid,v_session.scope,null::timestamptz;
    return;
  end if;
  if v_session.state='approved' and v_session.credential_expires_at<=now() then
    update private.cli_connect_sessions session set state='expired'
      where session.id=v_session.id and session.state='approved';
    return query select 'expired'::text,null::text,v_session.workspace_id,v_session.company_id,
      v_session.product_id,v_session.scope,null::timestamptz;
    return;
  end if;
  if v_session.last_polled_at is not null and v_session.last_polled_at>now()-interval '2 seconds' then
    if v_session.state='redeemed' then
      return query select 'redeemed'::text,null::text,v_session.workspace_id,v_session.company_id,
        v_session.product_id,v_session.scope,v_session.credential_expires_at;
      return;
    end if;
    raise exception 'cli_poll_too_frequent' using errcode='22023';
  end if;
  update private.cli_connect_sessions set poll_attempts=poll_attempts+1,last_polled_at=now()
    where id=v_session.id and poll_attempts<1000;
  if not found then raise exception 'cli_connect_unavailable' using errcode='P0002'; end if;
  if v_session.state='pending' then
    return query select 'pending'::text,null::text,null::uuid,null::uuid,null::uuid,v_session.scope,v_session.expires_at;
  elsif v_session.state='approved' and v_session.credential_expires_at>now() then
    update private.cli_connect_sessions session set state='redeemed',redeemed_at=now()
      where session.id=v_session.id and session.state='approved';
    return query select 'approved'::text,v_session.credential_hash,v_session.workspace_id,v_session.company_id,
      v_session.product_id,v_session.scope,v_session.credential_expires_at;
  else
    return query select v_session.state,null::text,v_session.workspace_id,v_session.company_id,
      v_session.product_id,v_session.scope,v_session.credential_expires_at;
  end if;
end;
$$;
revoke all on function public.redeem_cli_connect_session(uuid,text) from public,anon,authenticated;
grant execute on function public.redeem_cli_connect_session(uuid,text) to service_role;

create function public.ingest_cli_discovery(p_credential_hash text,p_payload_digest text,
  p_payload jsonb,p_provider_matches jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session private.cli_connect_sessions%rowtype; v_existing public.cli_scan_runs%rowtype;
  v_run public.cli_scan_runs%rowtype; v_observation jsonb; v_provider_id uuid; v_dependency_id uuid; v_scan_id uuid;
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
      and m.user_id=v_session.actor_user_id) or not exists (select 1 from public.workspace_products p
      where p.id=v_session.product_id and p.workspace_id=v_session.workspace_id and p.status='protected')
    or not exists (select 1 from public.product_onboarding_progress o where o.workspace_id=v_session.workspace_id
      and o.product_id=v_session.product_id and o.company_id=v_session.company_id) then
    raise exception 'cli_product_unavailable' using errcode='42501';
  end if;
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
