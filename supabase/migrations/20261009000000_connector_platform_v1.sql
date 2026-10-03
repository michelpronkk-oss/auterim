-- Shared tenant connector lifecycle and provider capability catalog.
create table public.connector_providers (
  provider text primary key check (provider in ('github','slack','linear','sentry')),
  display_name text not null check (octet_length(display_name)<=80),
  enabled boolean not null default true
);
insert into public.connector_providers(provider,display_name) values
  ('github','GitHub'),('slack','Slack'),('linear','Linear'),('sentry','Sentry');
create table public.connector_provider_capabilities (
  provider text not null references public.connector_providers(provider),
  capability text not null check (capability in ('CAN_VERIFY','CAN_READ_RUNTIME_CONTEXT','CAN_RECEIVE_ALERTS','CAN_CREATE_ACTIONS','CAN_PREPARE_REMEDIATION','CAN_READ_DEPLOYMENT_CONTEXT')),
  primary key(provider,capability)
);
insert into public.connector_provider_capabilities(provider,capability) values
  ('github','CAN_VERIFY'),('slack','CAN_RECEIVE_ALERTS'),('linear','CAN_CREATE_ACTIONS'),('sentry','CAN_READ_RUNTIME_CONTEXT');
alter table public.connector_providers enable row level security;
alter table public.connector_provider_capabilities enable row level security;
revoke all on public.connector_providers,public.connector_provider_capabilities from public,anon,authenticated;
grant select on public.connector_providers,public.connector_provider_capabilities to service_role;

create table public.connector_installations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null references public.connector_providers(provider),
  external_account_id text not null check (octet_length(external_account_id) between 1 and 200),
  account_name text not null check (octet_length(account_name) between 1 and 160),
  lifecycle_state text not null default 'connected' check (lifecycle_state in ('authorizing','connected','degraded','reauth_required','revoked','disconnected')),
  health_state text not null default 'healthy' check (health_state in ('healthy','degraded','reauth_required','revoked','provider_unavailable','permission_missing','resource_missing')),
  scopes text[] not null default '{}',
  safe_metadata jsonb not null default '{}'::jsonb check (octet_length(safe_metadata::text)<=2000),
  connected_by uuid references auth.users(id) on delete set null,
  connected_at timestamptz not null default now(),
  last_checked_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(workspace_id,provider),
  unique(id,workspace_id),
  check ((lifecycle_state='revoked')=(revoked_at is not null))
);
create index connector_installations_workspace_idx on public.connector_installations(workspace_id,provider,lifecycle_state);
alter table public.connector_installations enable row level security;
revoke all on public.connector_installations from public,anon;
grant select on public.connector_installations to authenticated,service_role;
grant all on public.connector_installations to service_role;
create policy connector_installations_member_read on public.connector_installations for select to authenticated
  using (exists(select 1 from public.workspace_members m where m.workspace_id=connector_installations.workspace_id and m.user_id=(select auth.uid())));

create table public.connector_resources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  installation_id uuid not null,
  external_resource_id text not null check (octet_length(external_resource_id) between 1 and 200),
  resource_type text not null check (resource_type in ('channel','team','project')),
  display_name text not null check (octet_length(display_name) between 1 and 160),
  safe_metadata jsonb not null default '{}'::jsonb check (octet_length(safe_metadata::text)<=1000),
  selected boolean not null default false,
  access_state text not null default 'available' check (access_state in ('available','missing','permission_missing','unknown')),
  last_seen_at timestamptz not null default now(),
  selected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(installation_id,workspace_id) references public.connector_installations(id,workspace_id) on delete cascade,
  unique(installation_id,external_resource_id),
  unique(id,workspace_id),
  check ((selected_at is not null)=selected)
);
create index connector_resources_selected_idx on public.connector_resources(workspace_id,installation_id,resource_type) where selected;
alter table public.connector_resources enable row level security;
revoke all on public.connector_resources from public,anon;
grant select on public.connector_resources to authenticated,service_role;
grant all on public.connector_resources to service_role;
create policy connector_resources_member_read on public.connector_resources for select to authenticated
  using (exists(select 1 from public.workspace_members m where m.workspace_id=connector_resources.workspace_id and m.user_id=(select auth.uid())));

create table public.connector_credentials (
  installation_id uuid primary key,
  workspace_id uuid not null,
  ciphertext text not null check (octet_length(ciphertext)<=20000),
  nonce text not null check (octet_length(nonce)<=100),
  authentication_tag text not null check (octet_length(authentication_tag)<=100),
  key_version integer not null check (key_version between 1 and 1000000),
  token_type text not null default 'Bearer' check (octet_length(token_type)<=30),
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  credential_version bigint not null default 1 check (credential_version>0),
  refresh_lease_token uuid,
  refresh_lease_until timestamptz,
  updated_at timestamptz not null default now(),
  foreign key(installation_id,workspace_id) references public.connector_installations(id,workspace_id) on delete cascade,
  check ((refresh_lease_token is null)=(refresh_lease_until is null))
);
create index connector_credentials_expiry_idx on public.connector_credentials(access_expires_at) where access_expires_at is not null;
alter table public.connector_credentials enable row level security;
revoke all on public.connector_credentials from public,anon,authenticated;
grant all on public.connector_credentials to service_role;

create table public.connector_authorization_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null unique check (state_hash ~ '^[a-f0-9]{64}$'),
  provider text not null references public.connector_providers(provider),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  browser_binding_hash text not null check (browser_binding_hash ~ '^[a-f0-9]{64}$'),
  pkce_ciphertext text,
  pkce_nonce text,
  pkce_tag text,
  pkce_key_version integer,
  expires_at timestamptz not null,
  claim_token uuid,
  claimed_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((pkce_ciphertext is null)=(pkce_nonce is null) and (pkce_ciphertext is null)=(pkce_tag is null) and (pkce_ciphertext is null)=(pkce_key_version is null))
  ,check ((claim_token is null)=(claimed_at is null))
);
create index connector_authorization_states_expiry_idx on public.connector_authorization_states(expires_at) where consumed_at is null;
alter table public.connector_authorization_states enable row level security;
revoke all on public.connector_authorization_states from public,anon,authenticated;
grant all on public.connector_authorization_states to service_role;

create table public.connector_audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  installation_id uuid,
  provider text not null references public.connector_providers(provider),
  actor_user_id uuid references auth.users(id) on delete set null,
  event_kind text not null check (event_kind in ('connected','reauthorized','scopes_changed','resource_selected','refresh_failed','permission_lost','revoked','disconnected','runtime_context_checked','runtime_signal_found','linear_issue_created','slack_notification_delivered')),
  safe_metadata jsonb not null default '{}'::jsonb check (octet_length(safe_metadata::text)<=1500),
  created_at timestamptz not null default now(),
  foreign key(installation_id,workspace_id) references public.connector_installations(id,workspace_id) on delete set null (installation_id)
);
create index connector_audit_events_workspace_idx on public.connector_audit_events(workspace_id,created_at desc,id desc);
alter table public.connector_audit_events enable row level security;
revoke all on public.connector_audit_events from public,anon;
grant select on public.connector_audit_events to authenticated,service_role;
grant all on public.connector_audit_events to service_role;
create policy connector_audit_events_member_read on public.connector_audit_events for select to authenticated
  using (exists(select 1 from public.workspace_members m where m.workspace_id=connector_audit_events.workspace_id and m.user_id=(select auth.uid())));

create table public.connector_action_mappings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  installation_id uuid not null,
  action_kind text not null check (action_kind in ('preflight_finding','impact_assessment','verified_risk','deadline')),
  action_id uuid not null,
  status text not null default 'creating' check (status in ('creating','created','failed','unknown_result')),
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  external_object_id text,
  external_object_key text,
  external_url text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(installation_id,workspace_id) references public.connector_installations(id,workspace_id) on delete cascade,
  unique(workspace_id,action_kind,action_id),
  check (external_url is null or (external_url like 'https://linear.app/%' and octet_length(external_url)<=500))
);
alter table public.connector_action_mappings enable row level security;
revoke all on public.connector_action_mappings from public,anon;
grant select on public.connector_action_mappings to authenticated,service_role;
grant all on public.connector_action_mappings to service_role;
create policy connector_action_mappings_member_read on public.connector_action_mappings for select to authenticated
  using (exists(select 1 from public.workspace_members m where m.workspace_id=connector_action_mappings.workspace_id and m.user_id=(select auth.uid())));

create table public.connector_runtime_signals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  installation_id uuid not null,
  impact_assessment_id uuid,
  result text not null check (result in ('runtime_signal_found','runtime_signal_not_found','runtime_signal_inconclusive')),
  evidence_count integer not null check (evidence_count between 0 and 250),
  safe_issue_ids text[] not null default '{}' check (cardinality(safe_issue_ids)<=20),
  window_start timestamptz not null,
  window_end timestamptz not null,
  checked_at timestamptz not null default now(),
  foreign key(installation_id,workspace_id) references public.connector_installations(id,workspace_id) on delete cascade,
  foreign key(impact_assessment_id,workspace_id) references public.impact_assessments(id,workspace_id) on delete set null (impact_assessment_id),
  check (window_start<window_end)
);
create unique index connector_runtime_signals_assessment_window_key
  on public.connector_runtime_signals(installation_id,impact_assessment_id);
create index connector_runtime_signals_workspace_idx on public.connector_runtime_signals(workspace_id,checked_at desc);
alter table public.connector_runtime_signals enable row level security;
revoke all on public.connector_runtime_signals from public,anon;
grant select on public.connector_runtime_signals to authenticated,service_role;
grant all on public.connector_runtime_signals to service_role;
create policy connector_runtime_signals_member_read on public.connector_runtime_signals for select to authenticated
  using (exists(select 1 from public.workspace_members m where m.workspace_id=connector_runtime_signals.workspace_id and m.user_id=(select auth.uid())));

-- Consume/lease state atomically before the code exchange to prevent callback replay races.
create function public.claim_connector_authorization_state(
  p_state_hash text,p_browser_binding_hash text,p_provider text,p_workspace_id uuid,p_actor_user_id uuid,p_claim_token uuid
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_plan text; v_claimed integer;
begin
  if not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_actor_user_id and role in ('owner','admin')) then
    raise exception 'connector_admin_required' using errcode='42501'; end if;
  select private.workspace_quota_plan(p_workspace_id) into v_plan;
  if v_plan is null or (p_provider<>'slack' and v_plan not in ('pro','business')) then
    raise exception 'connector_entitlement_required' using errcode='42501'; end if;
  update public.connector_authorization_states set claim_token=p_claim_token,claimed_at=now()
  where state_hash=p_state_hash and browser_binding_hash=p_browser_binding_hash and provider=p_provider
    and workspace_id=p_workspace_id and actor_user_id=p_actor_user_id and consumed_at is null
    and expires_at>now() and (claim_token is null or claimed_at<now()-interval '2 minutes');
  get diagnostics v_claimed=row_count;
  return v_claimed=1;
end;
$$;
revoke all on function public.claim_connector_authorization_state(text,text,text,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_connector_authorization_state(text,text,text,uuid,uuid,uuid) to service_role;

-- The browser state proof, actor, workspace and provider are bound to the one-time callback transaction.
create function public.complete_connector_authorization(
  p_state_hash text,p_browser_binding_hash text,p_provider text,p_workspace_id uuid,p_actor_user_id uuid,p_claim_token uuid,
  p_external_account_id text,p_account_name text,p_scopes text[],p_safe_metadata jsonb,
  p_ciphertext text,p_nonce text,p_authentication_tag text,p_key_version integer,
  p_access_expires_at timestamptz,p_refresh_expires_at timestamptz
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_state public.connector_authorization_states%rowtype; v_install public.connector_installations%rowtype; v_plan text; v_event text;
begin
  select * into v_state from public.connector_authorization_states
    where state_hash=p_state_hash and browser_binding_hash=p_browser_binding_hash and provider=p_provider
      and workspace_id=p_workspace_id and actor_user_id=p_actor_user_id and claim_token=p_claim_token
      and claimed_at>now()-interval '2 minutes' and consumed_at is null and expires_at>now()
    for update;
  if not found then raise exception 'connector_oauth_state_invalid' using errcode='42501'; end if;
  if not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_actor_user_id and role in ('owner','admin')) then
    raise exception 'connector_admin_required' using errcode='42501'; end if;
  select private.workspace_quota_plan(p_workspace_id) into v_plan;
  if v_plan is null or (p_provider<>'slack' and v_plan not in ('pro','business')) then
    raise exception 'connector_entitlement_required' using errcode='42501'; end if;
  if p_provider not in ('slack','linear','sentry') or p_external_account_id is null or octet_length(p_external_account_id)>200
    or p_account_name is null or octet_length(p_account_name)>160 or p_ciphertext is null or octet_length(p_ciphertext)>20000
    or p_nonce is null or p_authentication_tag is null or p_key_version not between 1 and 1000000
    or octet_length(coalesce(p_safe_metadata,'{}'::jsonb)::text)>2000 then
    raise exception 'invalid_connector_authorization' using errcode='22023'; end if;
  select * into v_install from public.connector_installations where workspace_id=p_workspace_id and provider=p_provider for update;
  v_event:=case when found then 'reauthorized' else 'connected' end;
  insert into public.connector_installations(workspace_id,provider,external_account_id,account_name,lifecycle_state,health_state,scopes,safe_metadata,connected_by,connected_at,revoked_at,updated_at)
    values(p_workspace_id,p_provider,p_external_account_id,p_account_name,'connected','healthy',coalesce(p_scopes,'{}'),coalesce(p_safe_metadata,'{}'),p_actor_user_id,now(),null,now())
    on conflict(workspace_id,provider) do update set external_account_id=excluded.external_account_id,account_name=excluded.account_name,
      lifecycle_state='connected',health_state='healthy',scopes=excluded.scopes,safe_metadata=excluded.safe_metadata,
      connected_by=excluded.connected_by,connected_at=now(),last_checked_at=null,revoked_at=null,updated_at=now()
    returning * into v_install;
  insert into public.connector_credentials(installation_id,workspace_id,ciphertext,nonce,authentication_tag,key_version,access_expires_at,refresh_expires_at,credential_version,refresh_lease_token,refresh_lease_until,updated_at)
    values(v_install.id,p_workspace_id,p_ciphertext,p_nonce,p_authentication_tag,p_key_version,p_access_expires_at,p_refresh_expires_at,1,null,null,now())
    on conflict(installation_id) do update set ciphertext=excluded.ciphertext,nonce=excluded.nonce,authentication_tag=excluded.authentication_tag,
      key_version=excluded.key_version,access_expires_at=excluded.access_expires_at,refresh_expires_at=excluded.refresh_expires_at,
      credential_version=public.connector_credentials.credential_version+1,refresh_lease_token=null,refresh_lease_until=null,updated_at=now();
  update public.connector_authorization_states set consumed_at=now() where id=v_state.id;
  insert into public.connector_audit_events(workspace_id,installation_id,provider,actor_user_id,event_kind,safe_metadata)
    values(p_workspace_id,v_install.id,p_provider,p_actor_user_id,v_event,jsonb_build_object('scopeCount',cardinality(coalesce(p_scopes,'{}'))));
  return v_install.id;
end;
$$;
revoke all on function public.complete_connector_authorization(text,text,text,uuid,uuid,uuid,text,text,text[],jsonb,text,text,text,integer,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.complete_connector_authorization(text,text,text,uuid,uuid,uuid,text,text,text[],jsonb,text,text,text,integer,timestamptz,timestamptz) to service_role;

create function public.claim_connector_refresh(p_installation_id uuid,p_workspace_id uuid)
returns table(lease_token uuid,ciphertext text,nonce text,authentication_tag text,key_version integer,credential_version bigint,provider text,external_account_id text)
language plpgsql security invoker set search_path = '' as $$
declare v_token uuid:=gen_random_uuid();
begin
  return query update public.connector_credentials credential
    set refresh_lease_token=v_token,refresh_lease_until=now()+interval '2 minutes'
    from public.connector_installations installation
    where credential.installation_id=p_installation_id and credential.workspace_id=p_workspace_id
      and installation.id=credential.installation_id and installation.workspace_id=credential.workspace_id
      and installation.lifecycle_state in ('connected','degraded')
      and (credential.refresh_lease_until is null or credential.refresh_lease_until<now())
    returning v_token,credential.ciphertext,credential.nonce,credential.authentication_tag,credential.key_version,
      credential.credential_version,installation.provider,installation.external_account_id;
end;
$$;
revoke all on function public.claim_connector_refresh(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_connector_refresh(uuid,uuid) to service_role;

create function public.replace_connector_credential(
  p_installation_id uuid,p_workspace_id uuid,p_lease_token uuid,p_expected_version bigint,
  p_ciphertext text,p_nonce text,p_authentication_tag text,p_key_version integer,
  p_access_expires_at timestamptz,p_refresh_expires_at timestamptz,p_scopes text[]
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_updated integer;
begin
  update public.connector_credentials credential set ciphertext=p_ciphertext,nonce=p_nonce,authentication_tag=p_authentication_tag,
    key_version=p_key_version,access_expires_at=p_access_expires_at,refresh_expires_at=p_refresh_expires_at,
    credential_version=credential.credential_version+1,refresh_lease_token=null,refresh_lease_until=null,updated_at=now()
  where credential.installation_id=p_installation_id and credential.workspace_id=p_workspace_id
    and credential.refresh_lease_token=p_lease_token and credential.credential_version=p_expected_version and credential.refresh_lease_until>now();
  get diagnostics v_updated=row_count;
  if v_updated=1 then
    update public.connector_installations set scopes=coalesce(p_scopes,scopes),lifecycle_state='connected',health_state='healthy',updated_at=now()
      where id=p_installation_id and workspace_id=p_workspace_id;
  end if;
  return v_updated=1;
end;
$$;
revoke all on function public.replace_connector_credential(uuid,uuid,uuid,bigint,text,text,text,integer,timestamptz,timestamptz,text[]) from public,anon,authenticated;
grant execute on function public.replace_connector_credential(uuid,uuid,uuid,bigint,text,text,text,integer,timestamptz,timestamptz,text[]) to service_role;

create function public.select_connector_resources(
  p_workspace_id uuid,p_installation_id uuid,p_actor_user_id uuid,p_resource_ids uuid[]
) returns integer language plpgsql security invoker set search_path = '' as $$
declare v_install public.connector_installations%rowtype; v_plan text; v_expected integer; v_changed integer;
begin
  select * into v_install from public.connector_installations where id=p_installation_id and workspace_id=p_workspace_id for update;
  if not found then raise exception 'connector_not_found' using errcode='P0002'; end if;
  if not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_actor_user_id and role in ('owner','admin')) then
    raise exception 'connector_admin_required' using errcode='42501'; end if;
  select private.workspace_quota_plan(p_workspace_id) into v_plan;
  if v_plan is null or (v_install.provider<>'slack' and v_plan not in ('pro','business')) then
    raise exception 'connector_entitlement_required' using errcode='42501'; end if;
  p_resource_ids:=coalesce(p_resource_ids,'{}');
  if cardinality(p_resource_ids)<1 or cardinality(p_resource_ids)>(case v_install.provider when 'sentry' then 5 else 1 end)
    or (select count(distinct item) from unnest(p_resource_ids) item)<>cardinality(p_resource_ids) then
    raise exception 'invalid_connector_resource_selection' using errcode='22023'; end if;
  select count(*) into v_expected from public.connector_resources
    where id=any(p_resource_ids) and workspace_id=p_workspace_id and installation_id=p_installation_id
      and access_state='available' and resource_type=case v_install.provider when 'slack' then 'channel' when 'linear' then 'team' else 'project' end;
  if v_expected<>cardinality(p_resource_ids) then raise exception 'connector_resource_not_found' using errcode='P0002'; end if;
  update public.connector_resources set selected=false,selected_at=null,updated_at=now()
    where workspace_id=p_workspace_id and installation_id=p_installation_id and selected;
  update public.connector_resources set selected=true,selected_at=now(),updated_at=now()
    where workspace_id=p_workspace_id and installation_id=p_installation_id and id=any(p_resource_ids);
  get diagnostics v_changed=row_count;
  insert into public.connector_audit_events(workspace_id,installation_id,provider,actor_user_id,event_kind,safe_metadata)
    values(p_workspace_id,p_installation_id,v_install.provider,p_actor_user_id,'resource_selected',jsonb_build_object('resourceCount',v_changed));
  return v_changed;
end;
$$;
revoke all on function public.select_connector_resources(uuid,uuid,uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.select_connector_resources(uuid,uuid,uuid,uuid[]) to service_role;

create function public.disconnect_connector(p_workspace_id uuid,p_installation_id uuid,p_actor_user_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_install public.connector_installations%rowtype;
begin
  select * into v_install from public.connector_installations where id=p_installation_id and workspace_id=p_workspace_id for update;
  if not found then raise exception 'connector_not_found' using errcode='P0002'; end if;
  if not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_actor_user_id and role in ('owner','admin')) then
    raise exception 'connector_admin_required' using errcode='42501'; end if;
  update public.connector_installations set lifecycle_state='disconnected',health_state='revoked',revoked_at=null,updated_at=now()
    where id=p_installation_id and workspace_id=p_workspace_id;
  delete from public.connector_credentials where installation_id=p_installation_id and workspace_id=p_workspace_id;
  update public.connector_resources set selected=false,selected_at=null,access_state='unknown',updated_at=now()
    where installation_id=p_installation_id and workspace_id=p_workspace_id;
  if v_install.provider='slack' then
    update public.workspace_notification_preferences set slack_enabled=false where workspace_id=p_workspace_id;
    update public.notification_deliveries set status='suppressed',lease_until=null,error_category='connector_disconnected'
      where workspace_id=p_workspace_id and channel='slack' and connector_resource_id in
        (select id from public.connector_resources where installation_id=p_installation_id);
  end if;
  insert into public.connector_audit_events(workspace_id,installation_id,provider,actor_user_id,event_kind,safe_metadata)
    values(p_workspace_id,p_installation_id,v_install.provider,p_actor_user_id,'disconnected','{}'::jsonb);
  return true;
end;
$$;
revoke all on function public.disconnect_connector(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.disconnect_connector(uuid,uuid,uuid) to service_role;

create function public.set_connector_slack_preference(p_workspace_id uuid,p_actor_user_id uuid,p_enabled boolean)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_enabled is null or not exists(select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=p_actor_user_id and role in ('owner','admin')) then
    raise exception 'connector_admin_required' using errcode='42501'; end if;
  if p_enabled and (private.workspace_quota_plan(p_workspace_id) is null
    or not exists(select 1 from public.connector_resources resource
      join public.connector_installations installation on installation.id=resource.installation_id and installation.workspace_id=resource.workspace_id
      join public.connector_credentials credential on credential.installation_id=installation.id and credential.workspace_id=installation.workspace_id
      where resource.workspace_id=p_workspace_id and resource.selected and resource.resource_type='channel' and resource.access_state='available'
        and installation.provider='slack' and installation.lifecycle_state='connected' and installation.health_state='healthy'
        and installation.scopes @> array['chat:write'])) then
    raise exception 'slack_destination_required' using errcode='22023'; end if;
  update public.workspace_notification_preferences set slack_enabled=p_enabled where workspace_id=p_workspace_id;
  if not found then raise exception 'notification_preferences_not_found' using errcode='P0002'; end if;
  return p_enabled;
end;
$$;
revoke all on function public.set_connector_slack_preference(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.set_connector_slack_preference(uuid,uuid,boolean) to service_role;

create function public.claim_slack_notification_deliveries(p_limit integer default 50)
returns table(delivery_id uuid,workspace_id uuid,installation_id uuid,resource_id uuid,notification_id uuid,title text,summary text,priority text,lease_until timestamptz)
language plpgsql security invoker set search_path = '' as $$
begin
  with stale as (
    select delivery.id from public.notification_deliveries delivery
    join public.notifications notification on notification.id=delivery.notification_id and notification.workspace_id=delivery.workspace_id
    join public.workspace_notification_preferences preference on preference.workspace_id=delivery.workspace_id
    where delivery.channel='slack' and (delivery.status='pending' or (delivery.status='sending' and delivery.lease_until<now()))
      and (not preference.slack_enabled or not (
        (notification.priority in ('critical','high') and preference.critical_changes='instant')
        or (notification.priority='normal' and preference.important_changes='instant')))
    order by delivery.next_attempt_at,delivery.created_at,delivery.id limit 50 for update of delivery skip locked
  )
  update public.notification_deliveries delivery set status='suppressed',lease_until=null,error_category='preference_changed'
    from stale where delivery.id=stale.id;
  return query with candidates as (
    select delivery.id from public.notification_deliveries delivery
    join public.connector_resources resource on resource.id=delivery.connector_resource_id and resource.workspace_id=delivery.workspace_id
    join public.connector_installations installation on installation.id=resource.installation_id and installation.workspace_id=resource.workspace_id
    join public.connector_credentials credential on credential.installation_id=installation.id and credential.workspace_id=installation.workspace_id
    join public.notifications notification on notification.id=delivery.notification_id and notification.workspace_id=delivery.workspace_id
    join public.workspace_notification_preferences preference on preference.workspace_id=delivery.workspace_id
    where delivery.channel='slack' and delivery.attempt_count<5 and delivery.next_attempt_at<=now()
      and (delivery.status='pending' or (delivery.status='sending' and delivery.lease_until<now()))
      and resource.selected and resource.resource_type='channel' and resource.access_state='available'
      and installation.provider='slack' and installation.lifecycle_state in ('connected','degraded')
      and installation.health_state in ('healthy','degraded','provider_unavailable')
      and installation.scopes @> array['chat:write'] and private.workspace_quota_plan(delivery.workspace_id) is not null
      and preference.slack_enabled
      and ((notification.priority in ('critical','high') and preference.critical_changes='instant')
        or (notification.priority='normal' and preference.important_changes='instant'))
    order by delivery.next_attempt_at,delivery.created_at,delivery.id
    limit least(greatest(coalesce(p_limit,1),1),10) for update of delivery skip locked
  ), claimed as (
    update public.notification_deliveries delivery set status='sending',attempt_count=delivery.attempt_count+1,
      lease_until=now()+interval '5 minutes',error_category=null
    from candidates where delivery.id=candidates.id
    returning delivery.id,delivery.workspace_id,delivery.connector_resource_id,delivery.notification_id,delivery.lease_until
  )
  select claimed.id,claimed.workspace_id,resource.installation_id,resource.id,notification.id,notification.title,notification.summary,notification.priority,claimed.lease_until
    from claimed join public.connector_resources resource on resource.id=claimed.connector_resource_id
    join public.notifications notification on notification.id=claimed.notification_id;
end;
$$;
revoke all on function public.claim_slack_notification_deliveries(integer) from public,anon,authenticated;
grant execute on function public.claim_slack_notification_deliveries(integer) to service_role;

alter table public.workspace_notification_preferences add column slack_enabled boolean not null default false;
alter table public.notifications drop constraint notifications_notification_type_check;
alter table public.notifications add constraint notifications_notification_type_check check (notification_type in (
  'customer_relevant_change','verified_preflight_risk','deadline_approaching','remediation_ready','draft_pr_prepared',
  'repository_access_broken','coverage_problem','connector_health_problem'));
alter table public.notification_deliveries drop constraint notification_deliveries_channel_check;
alter table public.notification_deliveries add column connector_resource_id uuid;
alter table public.notification_deliveries alter column recipient_user_id drop not null;
alter table public.notification_deliveries alter column recipient_email drop not null;
alter table public.notification_deliveries add constraint notification_deliveries_channel_check check (channel in ('email','slack'));
alter table public.notification_deliveries add constraint notification_delivery_channel_target_check check (
  (channel='email' and recipient_user_id is not null and recipient_email is not null and connector_resource_id is null)
  or (channel='slack' and recipient_user_id is null and recipient_email is null and connector_resource_id is not null));
alter table public.notification_deliveries add constraint notification_delivery_resource_fkey
  foreign key(connector_resource_id,workspace_id) references public.connector_resources(id,workspace_id) on delete cascade;
alter table public.notification_deliveries drop constraint notification_delivery_recipient_key;
create unique index notification_delivery_email_key on public.notification_deliveries(notification_id,recipient_user_id,channel) where channel='email';
create unique index notification_delivery_slack_key on public.notification_deliveries(notification_id,connector_resource_id) where channel='slack';
create index notification_deliveries_slack_pending_idx on public.notification_deliveries(next_attempt_at,created_at,id)
  where channel='slack' and status in ('pending','sending') and attempt_count<5;

create or replace function public.claim_notification_deliveries(p_limit integer default 50)
returns table(delivery_id uuid,notification_id uuid,workspace_id uuid,recipient_email text,title text,summary text,priority text,notification_type text,lease_until timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  update public.notification_deliveries delivery set status='suppressed',lease_until=null,error_category='recipient_or_preference_changed'
  where delivery.channel='email' and (delivery.status='pending' or (delivery.status='sending' and delivery.lease_until<now())) and not exists(
    select 1 from public.workspace_members member join auth.users user_row on user_row.id=member.user_id
    join public.workspace_notification_preferences preference on preference.workspace_id=member.workspace_id
    where member.workspace_id=delivery.workspace_id and member.user_id=delivery.recipient_user_id and member.role in ('owner','admin')
      and user_row.email=delivery.recipient_email and user_row.email_confirmed_at is not null and preference.email_enabled
      and (((select notification.priority from public.notifications notification where notification.id=delivery.notification_id) in ('critical','high') and preference.critical_changes='instant')
        or ((select notification.priority from public.notifications notification where notification.id=delivery.notification_id)='normal' and preference.important_changes='instant'))
      and ((select notification.notification_type from public.notifications notification where notification.id=delivery.notification_id)<>'verified_preflight_risk'
        or exists(select 1 from public.workspace_subscriptions subscription where subscription.workspace_id=delivery.workspace_id and subscription.plan in ('pro','business') and subscription.status in ('trialing','active'))));
  return query with picked as (
    select delivery.id from public.notification_deliveries delivery
    join public.notifications notification on notification.id=delivery.notification_id and notification.workspace_id=delivery.workspace_id
    join public.workspace_members member on member.workspace_id=delivery.workspace_id and member.user_id=delivery.recipient_user_id and member.role in ('owner','admin')
    join auth.users user_row on user_row.id=member.user_id and user_row.email=delivery.recipient_email and user_row.email_confirmed_at is not null
    join public.workspace_notification_preferences preference on preference.workspace_id=delivery.workspace_id and preference.email_enabled
    where delivery.channel='email' and delivery.attempt_count<5 and delivery.next_attempt_at<=now()
      and (delivery.status='pending' or (delivery.status='sending' and delivery.lease_until<now()))
      and ((notification.priority in ('critical','high') and preference.critical_changes='instant') or (notification.priority='normal' and preference.important_changes='instant'))
      and (notification.notification_type<>'verified_preflight_risk' or exists(select 1 from public.workspace_subscriptions subscription where subscription.workspace_id=delivery.workspace_id and subscription.plan in ('pro','business') and subscription.status in ('trialing','active')))
    order by delivery.next_attempt_at,delivery.created_at,delivery.id
    limit least(greatest(coalesce(p_limit,1),1),50) for update of delivery skip locked
  ), claimed as (
    update public.notification_deliveries delivery set status='sending',attempt_count=delivery.attempt_count+1,lease_until=now()+interval '5 minutes',error_category=null
    from picked where delivery.id=picked.id
    returning delivery.id,delivery.notification_id,delivery.workspace_id,delivery.recipient_email,delivery.lease_until
  )
  select claimed.id,claimed.notification_id,claimed.workspace_id,claimed.recipient_email,notification.title,notification.summary,notification.priority,notification.notification_type,claimed.lease_until
  from claimed join public.notifications notification on notification.id=claimed.notification_id and notification.workspace_id=claimed.workspace_id;
end;
$$;
revoke all on function public.claim_notification_deliveries(integer) from public,anon,authenticated;
grant execute on function public.claim_notification_deliveries(integer) to service_role;

create or replace function private.enqueue_notification_delivery()
returns trigger language plpgsql security definer set search_path = '' as $$
declare preference public.workspace_notification_preferences%rowtype; v_send boolean:=false;
begin
  select * into preference from public.workspace_notification_preferences where workspace_id=new.workspace_id;
  if new.priority in ('critical','high') and preference.critical_changes='instant' then v_send:=true;
  elsif new.priority='normal' and preference.important_changes='instant' then v_send:=true; end if;
  if not v_send then return new; end if;
  if preference.email_enabled then
    insert into public.notification_deliveries(notification_id,workspace_id,recipient_user_id,recipient_email,channel)
    select new.id,new.workspace_id,m.user_id,u.email,'email'
    from public.workspace_members m join auth.users u on u.id=m.user_id and u.email is not null and u.email_confirmed_at is not null
    where m.workspace_id=new.workspace_id and m.role in ('owner','admin')
    on conflict(notification_id,recipient_user_id,channel) where channel='email' do nothing;
  end if;
  if preference.slack_enabled and private.workspace_quota_plan(new.workspace_id) is not null then
    insert into public.notification_deliveries(notification_id,workspace_id,channel,connector_resource_id)
    select new.id,new.workspace_id,'slack',resource.id
    from public.connector_resources resource
    join public.connector_installations installation on installation.id=resource.installation_id and installation.workspace_id=resource.workspace_id
    join public.connector_credentials credential on credential.installation_id=installation.id and credential.workspace_id=installation.workspace_id
    where resource.workspace_id=new.workspace_id and resource.selected and resource.resource_type='channel' and resource.access_state='available'
      and installation.provider='slack' and installation.lifecycle_state='connected' and installation.health_state='healthy'
      and installation.scopes @> array['chat:write']
    on conflict(notification_id,connector_resource_id) where channel='slack' do nothing;
  end if;
  return new;
end;
$$;
revoke all on function private.enqueue_notification_delivery() from public,anon,authenticated;

create function public.release_connector_refresh(p_installation_id uuid,p_workspace_id uuid,p_lease_token uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_count integer;
begin
  update public.connector_credentials set refresh_lease_token=null,refresh_lease_until=null
    where installation_id=p_installation_id and workspace_id=p_workspace_id and refresh_lease_token=p_lease_token;
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;
revoke all on function public.release_connector_refresh(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.release_connector_refresh(uuid,uuid,uuid) to service_role;

create function public.update_connector_health(p_workspace_id uuid,p_installation_id uuid,p_lifecycle_state text,p_health_state text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_install public.connector_installations%rowtype;
begin
  select * into v_install from public.connector_installations where id=p_installation_id and workspace_id=p_workspace_id for update;
  if not found or v_install.lifecycle_state in ('disconnected','revoked') then return false; end if;
  if v_install.lifecycle_state='reauth_required' and p_lifecycle_state='degraded' then return false; end if;
  update public.connector_installations set lifecycle_state=p_lifecycle_state,health_state=p_health_state,last_checked_at=now(),updated_at=now()
    where id=p_installation_id and workspace_id=p_workspace_id;
  return true;
end;
$$;
revoke all on function public.update_connector_health(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.update_connector_health(uuid,uuid,text,text) to service_role;

create function public.fail_notification_delivery(p_delivery_id uuid,p_lease_until timestamptz,p_error_category text,p_transient boolean,p_retry_after_seconds integer)
returns text language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  update public.notification_deliveries set
    status=case when p_transient and attempt_count<5 then 'pending' else 'failed' end,
    next_attempt_at=case when p_transient and attempt_count<5 then now()+make_interval(secs=>least(3600,greatest(1,coalesce(p_retry_after_seconds,5*attempt_count)))) else next_attempt_at end,
    lease_until=null,error_category=left(coalesce(p_error_category,'provider_error'),80)
  where id=p_delivery_id and status='sending' and lease_until=p_lease_until returning status into v_status;
  if not found then raise exception 'Notification delivery lease is no longer current' using errcode='40001'; end if;
  return v_status;
end;
$$;
revoke all on function public.fail_notification_delivery(uuid,timestamptz,text,boolean,integer) from public,anon,authenticated;
grant execute on function public.fail_notification_delivery(uuid,timestamptz,text,boolean,integer) to service_role;

create function public.set_notification_preferences_with_slack(p_workspace_id uuid,p_actor_user_id uuid,p_in_app_enabled boolean,p_email_enabled boolean,p_slack_enabled boolean)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_preferences public.workspace_notification_preferences%rowtype;
begin
  if not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_actor_user_id and role in ('owner','admin')) then
    raise exception 'connector_admin_required' using errcode='42501'; end if;
  if p_slack_enabled and not exists(select 1 from public.connector_resources resource
    join public.connector_installations installation on installation.id=resource.installation_id and installation.workspace_id=resource.workspace_id
    join public.connector_credentials credential on credential.installation_id=installation.id and credential.workspace_id=installation.workspace_id
    where resource.workspace_id=p_workspace_id and resource.selected and resource.resource_type='channel' and resource.access_state='available'
      and installation.provider='slack' and installation.lifecycle_state='connected' and installation.health_state='healthy'
      and installation.scopes @> array['chat:write']) then
    raise exception 'slack_destination_required' using errcode='P0002'; end if;
  update public.workspace_notification_preferences set in_app_enabled=p_in_app_enabled,email_enabled=p_email_enabled,slack_enabled=p_slack_enabled
    where workspace_id=p_workspace_id returning * into v_preferences;
  if not found then raise exception 'Notification preferences were not found' using errcode='P0002'; end if;
  return jsonb_build_object('inAppEnabled',v_preferences.in_app_enabled,'emailEnabled',v_preferences.email_enabled,
    'importantChanges',v_preferences.important_changes,'criticalChanges',v_preferences.critical_changes,'slackEnabled',v_preferences.slack_enabled);
end;
$$;
revoke all on function public.set_notification_preferences_with_slack(uuid,uuid,boolean,boolean,boolean) from public,anon,authenticated;
grant execute on function public.set_notification_preferences_with_slack(uuid,uuid,boolean,boolean,boolean) to service_role;
