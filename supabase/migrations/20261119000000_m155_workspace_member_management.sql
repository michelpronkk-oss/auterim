-- Existing-account membership management for workspace owners/admins.
-- Auth user lookup and membership writes stay behind service-role-only RPCs.
create or replace function public.list_workspace_members_for_admin(
  p_workspace_id uuid,
  p_actor_user_id uuid
)
returns table(email text, role text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_actor_user_id is null or not exists (
    select 1 from public.workspace_members member
    where member.workspace_id = p_workspace_id
      and member.user_id = p_actor_user_id
      and member.role in ('owner', 'admin')
  ) then
    raise exception 'owner_or_admin_required' using errcode = '42501';
  end if;

  return query
  select coalesce(user_row.email, 'Account')::text, member.role, member.created_at
  from public.workspace_members member
  join auth.users user_row on user_row.id = member.user_id
  where member.workspace_id = p_workspace_id
  order by case member.role when 'owner' then 0 when 'admin' then 1 else 2 end,
    lower(coalesce(user_row.email, ''));
end;
$$;

create or replace function public.add_existing_workspace_member(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_email text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(p_email));
  v_target_user_id uuid;
begin
  if p_actor_user_id is null or not exists (
    select 1 from public.workspace_members member
    where member.workspace_id = p_workspace_id
      and member.user_id = p_actor_user_id
      and member.role in ('owner', 'admin')
  ) then
    raise exception 'owner_or_admin_required' using errcode = '42501';
  end if;

  if v_email is null or char_length(v_email) > 254 or
    v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;

  -- Only a specifically entered, existing, email-confirmed account can be added.
  -- A non-match is deliberately a successful no-op so callers cannot probe accounts.
  select user_row.id into v_target_user_id
  from auth.users user_row
  where lower(user_row.email) = v_email
    and user_row.email_confirmed_at is not null
  limit 1;

  if v_target_user_id is null then
    return;
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (p_workspace_id, v_target_user_id, 'member')
  on conflict (workspace_id, user_id) do nothing;
end;
$$;

revoke all on function public.list_workspace_members_for_admin(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.add_existing_workspace_member(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.list_workspace_members_for_admin(uuid, uuid) to service_role;
grant execute on function public.add_existing_workspace_member(uuid, uuid, text) to service_role;
