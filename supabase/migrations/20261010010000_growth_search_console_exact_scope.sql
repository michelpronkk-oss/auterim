create or replace function public.persist_growth_search_console_connection(
  p_property text,
  p_ciphertext text,
  p_nonce text,
  p_authentication_tag text,
  p_key_version integer,
  p_scopes text[],
  p_actor_user_id uuid,
  p_access_expires_at timestamptz
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_property is distinct from 'sc-domain:auterim.com'
    or p_scopes is null
    or cardinality(p_scopes) <> 1
    or p_scopes[1] is distinct from 'https://www.googleapis.com/auth/webmasters.readonly' then
    raise exception 'invalid_search_console_connection' using errcode = '22023';
  end if;

  insert into public.growth_search_console_connection(
    id,
    property,
    lifecycle_state,
    health_state,
    scopes,
    ciphertext,
    nonce,
    authentication_tag,
    key_version,
    access_expires_at,
    credential_version,
    connected_by,
    connected_at,
    updated_at
  )
  values (
    'auterim',
    p_property,
    'connected',
    'healthy',
    p_scopes,
    p_ciphertext,
    p_nonce,
    p_authentication_tag,
    p_key_version,
    p_access_expires_at,
    1,
    p_actor_user_id,
    now(),
    now()
  )
  on conflict (id) do update set
    property = excluded.property,
    lifecycle_state = 'connected',
    health_state = 'healthy',
    scopes = excluded.scopes,
    ciphertext = excluded.ciphertext,
    nonce = excluded.nonce,
    authentication_tag = excluded.authentication_tag,
    key_version = excluded.key_version,
    access_expires_at = excluded.access_expires_at,
    credential_version = public.growth_search_console_connection.credential_version + 1,
    connected_by = excluded.connected_by,
    connected_at = now(),
    last_error_category = null,
    updated_at = now();
end;
$$;

revoke all on function public.persist_growth_search_console_connection(
  text,
  text,
  text,
  text,
  integer,
  text[],
  uuid,
  timestamptz
) from public, anon, authenticated;

grant execute on function public.persist_growth_search_console_connection(
  text,
  text,
  text,
  text,
  integer,
  text[],
  uuid,
  timestamptz
) to service_role;
