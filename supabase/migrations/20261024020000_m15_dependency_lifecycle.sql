-- Disable one tenant dependency through a serialized, owner/admin-only lifecycle operation.
-- Keep historical dependency, context, discovery, impact, and remediation rows intact.
create function public.disable_workspace_dependency(
  p_workspace_id uuid,
  p_workspace_dependency_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_product_id uuid;
  v_changed boolean := false;
  v_row_count integer := 0;
begin
  if v_user_id is null or not exists (
    select 1 from public.workspace_members member
    where member.workspace_id = p_workspace_id
      and member.user_id = v_user_id
      and member.role in ('owner', 'admin')
  ) then
    raise exception 'owner_or_admin_required' using errcode = '42501';
  end if;

  -- protected_product_id is immutable after insert. This initial read obtains the
  -- product key; all writes then follow the established workspace → product → dependency order.
  select dependency.protected_product_id into v_product_id
  from public.workspace_dependencies dependency
  where dependency.id = p_workspace_dependency_id
    and dependency.workspace_id = p_workspace_id;
  if v_product_id is null then
    raise exception 'dependency_not_found' using errcode = 'P0002';
  end if;

  perform 1 from public.workspaces workspace
  where workspace.id = p_workspace_id
  for update;
  if not found then
    raise exception 'dependency_not_found' using errcode = 'P0002';
  end if;

  perform 1 from public.workspace_products product
  where product.id = v_product_id
    and product.workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception 'dependency_not_found' using errcode = 'P0002';
  end if;

  perform 1 from public.workspace_dependencies dependency
  where dependency.id = p_workspace_dependency_id
    and dependency.workspace_id = p_workspace_id
    and dependency.protected_product_id = v_product_id
  for update;
  if not found then
    raise exception 'dependency_not_found' using errcode = 'P0002';
  end if;

  update public.workspace_dependencies
  set monitoring_enabled = false
  where id = p_workspace_dependency_id
    and workspace_id = p_workspace_id
    and monitoring_enabled = true;
  get diagnostics v_row_count = row_count;
  v_changed := v_row_count > 0;

  return jsonb_build_object(
    'workspaceId', p_workspace_id,
    'workspaceDependencyId', p_workspace_dependency_id,
    'monitoringEnabled', false,
    'changed', v_changed
  );
end;
$$;

revoke all on function public.disable_workspace_dependency(uuid, uuid) from public, anon;
grant execute on function public.disable_workspace_dependency(uuid, uuid) to authenticated;

-- Prevent bypassing the serialized lifecycle RPC with direct tenant table writes.
revoke update on public.workspace_dependencies from authenticated;
