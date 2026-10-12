-- M15.7: the shared OAuth persistence RPC must accept the Vercel provider
-- registered by m157_deployment_surfaces while retaining the provider allowlist.
create or replace function public.complete_connector_authorization(
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
  if p_provider not in ('slack','linear','sentry','vercel') or p_external_account_id is null or octet_length(p_external_account_id)>200
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
