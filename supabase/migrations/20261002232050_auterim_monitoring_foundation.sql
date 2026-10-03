-- Auterim Milestone 2: tenant foundation plus global source monitoring.
-- All monitoring writes are server-side and serialized per source.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete restrict,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_members_workspace_user_key unique (workspace_id, user_id),
  constraint workspace_members_id_workspace_key unique (id, workspace_id)
);

create index workspace_members_user_workspace_idx
  on public.workspace_members (user_id, workspace_id);

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  slug text not null check (slug ~ '^[a-z0-9]+([a-z0-9-]*[a-z0-9])?$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companies_workspace_slug_key unique (workspace_id, slug),
  constraint companies_id_workspace_key unique (id, workspace_id)
);

create index companies_workspace_idx on public.companies (workspace_id);

create table public.company_context (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  company_id uuid not null,
  context text not null default '' check (octet_length(context) <= 32768),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_context_company_key unique (company_id),
  constraint company_context_company_workspace_fkey
    foreign key (company_id, workspace_id)
    references public.companies (id, workspace_id) on delete cascade
);

create index company_context_workspace_idx on public.company_context (workspace_id);

create table public.dependency_catalog (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+([a-z0-9-]*[a-z0-9])?$'),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  category text not null check (category in ('ai', 'payments', 'infrastructure', 'developer-tools', 'communications', 'other')),
  website_url text not null check (website_url ~ '^https://'),
  enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.source_catalog (
  id uuid primary key default gen_random_uuid(),
  dependency_id uuid not null references public.dependency_catalog (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  source_type text not null check (source_type in (
    'pricing', 'changelog', 'documentation', 'api', 'deprecation', 'terms',
    'limits', 'status', 'announcement'
  )),
  url text not null check (url ~ '^https?://'),
  fetch_strategy text not null default 'http' check (fetch_strategy = 'http'),
  enabled boolean not null default true,
  default_interval_seconds integer not null default 86400
    check (default_interval_seconds between 300 and 2592000),
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_changed_at timestamptz,
  etag text check (etag is null or octet_length(etag) <= 512),
  last_modified text check (last_modified is null or octet_length(last_modified) <= 512),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_catalog_dependency_name_key unique (dependency_id, source_type, name),
  constraint source_catalog_id_dependency_key unique (id, dependency_id)
);

create index source_catalog_enabled_interval_idx
  on public.source_catalog (enabled, last_checked_at)
  where enabled;
create index source_catalog_dependency_idx on public.source_catalog (dependency_id);

create table public.workspace_dependencies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  dependency_id uuid not null references public.dependency_catalog (id) on delete restrict,
  selected_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_dependencies_workspace_dependency_key unique (workspace_id, dependency_id),
  constraint workspace_dependencies_id_workspace_key unique (id, workspace_id)
);

create index workspace_dependencies_dependency_idx
  on public.workspace_dependencies (dependency_id, workspace_id);

create table public.dependency_context (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  workspace_dependency_id uuid not null,
  context text not null default '' check (octet_length(context) <= 32768),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dependency_context_selection_key unique (workspace_dependency_id),
  constraint dependency_context_selection_workspace_fkey
    foreign key (workspace_dependency_id, workspace_id)
    references public.workspace_dependencies (id, workspace_id) on delete cascade
);

create index dependency_context_workspace_idx on public.dependency_context (workspace_id);

create table public.scan_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.source_catalog (id) on delete restrict,
  trigger_run_id text not null check (char_length(trigger_run_id) between 1 and 255),
  attempt_number integer not null check (attempt_number between 1 and 100),
  status text not null default 'pending'
    check (status in ('pending', 'success', 'unchanged', 'changed', 'not_modified', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  http_status integer check (http_status is null or http_status between 100 and 599),
  error_category text check (error_category is null or char_length(error_category) <= 80),
  error_summary text check (error_summary is null or octet_length(error_summary) <= 1000),
  content_bytes bigint check (content_bytes is null or content_bytes between 0 and 2097152),
  result_snapshot_id uuid,
  result_change_id uuid,
  created_at timestamptz not null default now(),
  constraint scan_runs_trigger_attempt_key unique (trigger_run_id, attempt_number),
  constraint scan_runs_id_source_key unique (id, source_id),
  constraint scan_runs_finished_state_check check (
    (status = 'pending' and finished_at is null) or
    (status <> 'pending' and finished_at is not null)
  )
);

create index scan_runs_source_started_idx on public.scan_runs (source_id, started_at desc);
create index scan_runs_failed_idx on public.scan_runs (started_at desc) where status = 'failed';

create table public.source_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.source_catalog (id) on delete restrict,
  scan_run_id uuid not null,
  previous_snapshot_id uuid,
  version integer not null check (version > 0),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  normalized_content text not null check (octet_length(normalized_content) <= 524288),
  normalized_bytes integer not null check (normalized_bytes between 0 and 524288),
  content_bytes bigint not null check (content_bytes between 0 and 2097152),
  created_at timestamptz not null default now(),
  constraint source_snapshots_scan_run_source_fkey
    foreign key (scan_run_id, source_id)
    references public.scan_runs (id, source_id) on delete restrict,
  constraint source_snapshots_previous_source_fkey
    foreign key (previous_snapshot_id, source_id)
    references public.source_snapshots (id, source_id) on delete restrict,
  constraint source_snapshots_source_version_key unique (source_id, version),
  constraint source_snapshots_source_id_key unique (source_id, id),
  constraint source_snapshots_source_run_key unique (source_id, scan_run_id),
  constraint source_snapshots_normalized_length_check
    check (normalized_bytes = octet_length(normalized_content))
);

create index source_snapshots_source_version_idx
  on public.source_snapshots (source_id, version desc);

create table public.source_changes (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.source_catalog (id) on delete restrict,
  scan_run_id uuid not null,
  previous_snapshot_id uuid not null,
  new_snapshot_id uuid not null,
  diff_text text not null check (octet_length(diff_text) <= 16384),
  added_lines integer not null check (added_lines >= 0),
  removed_lines integer not null check (removed_lines >= 0),
  diff_truncated boolean not null default false,
  previous_bytes integer not null check (previous_bytes between 0 and 524288),
  new_bytes integer not null check (new_bytes between 0 and 524288),
  created_at timestamptz not null default now(),
  constraint source_changes_scan_run_source_fkey
    foreign key (scan_run_id, source_id)
    references public.scan_runs (id, source_id) on delete restrict,
  constraint source_changes_previous_snapshot_source_fkey
    foreign key (previous_snapshot_id, source_id)
    references public.source_snapshots (id, source_id) on delete restrict,
  constraint source_changes_new_snapshot_source_fkey
    foreign key (new_snapshot_id, source_id)
    references public.source_snapshots (id, source_id) on delete restrict,
  constraint source_changes_distinct_snapshots_check check (previous_snapshot_id <> new_snapshot_id),
  constraint source_changes_new_snapshot_key unique (source_id, new_snapshot_id),
  constraint source_changes_id_source_key unique (id, source_id)
);

create index source_changes_source_created_idx on public.source_changes (source_id, created_at desc);

alter table public.scan_runs
  add constraint scan_runs_result_snapshot_source_fkey
    foreign key (result_snapshot_id, source_id)
    references public.source_snapshots (id, source_id) on delete restrict,
  add constraint scan_runs_result_change_source_fkey
    foreign key (result_change_id, source_id)
    references public.source_changes (id, source_id) on delete restrict;

create index scan_runs_result_snapshot_idx on public.scan_runs (result_snapshot_id)
  where result_snapshot_id is not null;

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create function private.prevent_immutable_evidence_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Monitoring evidence is immutable' using errcode = '55000';
end;
$$;

create function private.has_workspace_role(p_workspace_id uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members as member
    where member.workspace_id = p_workspace_id
      and member.user_id = (select auth.uid())
      and member.role = any (p_roles)
  );
$$;

create function public.create_workspace(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_workspace_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication is required to create a workspace'
      using errcode = '42501';
  end if;

  insert into public.workspaces (name, created_by)
  values (p_name, v_user_id)
  returning id into v_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace_id, v_user_id, 'owner');

  return v_workspace_id;
end;
$$;

create function public.begin_source_scan(
  p_source_id uuid,
  p_trigger_run_id text,
  p_attempt_number integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run public.scan_runs%rowtype;
begin
  if not exists (
    select 1 from public.source_catalog as source
    where source.id = p_source_id and source.enabled
  ) then
    raise exception 'Source is missing or disabled' using errcode = 'P0002';
  end if;

  insert into public.scan_runs (source_id, trigger_run_id, attempt_number)
  values (p_source_id, p_trigger_run_id, p_attempt_number)
  on conflict (trigger_run_id, attempt_number) do nothing;

  select * into v_run
  from public.scan_runs
  where trigger_run_id = p_trigger_run_id
    and attempt_number = p_attempt_number;

  if v_run.source_id <> p_source_id then
    raise exception 'Trigger run identity is already bound to another source'
      using errcode = '23505';
  end if;

  return jsonb_build_object(
    'scanRunId', v_run.id,
    'status', v_run.status,
    'snapshotId', v_run.result_snapshot_id,
    'changeId', v_run.result_change_id
  );
end;
$$;

create function public.list_due_source_ids(
  p_now timestamptz default now(),
  p_limit integer default 100
)
returns table (source_id uuid)
language sql
security invoker
set search_path = ''
as $$
  select source.id
  from public.source_catalog as source
  where source.enabled
    and (
      source.last_checked_at is null
      or source.last_checked_at + make_interval(secs => source.default_interval_seconds) <= p_now
    )
  order by source.last_checked_at asc nulls first, source.id
  limit least(greatest(coalesce(p_limit, 1), 1), 100);
$$;

create function public.record_source_scan_failure(
  p_scan_run_id uuid,
  p_source_id uuid,
  p_error_category text,
  p_error_summary text,
  p_http_status integer default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.scan_runs
  set status = 'failed',
      finished_at = now(),
      http_status = p_http_status,
      error_category = left(p_error_category, 80),
      error_summary = left(p_error_summary, 1000)
  where id = p_scan_run_id
    and source_id = p_source_id
    and status = 'pending';

  if not found then
    raise exception 'Pending scan run was not found' using errcode = 'P0002';
  end if;
end;
$$;

create function public.record_source_scan_result(
  p_scan_run_id uuid,
  p_source_id uuid,
  p_http_status integer,
  p_content_bytes bigint,
  p_not_modified boolean,
  p_content_hash text,
  p_normalized_content text,
  p_etag text,
  p_last_modified text,
  p_expected_previous_snapshot_id uuid,
  p_diff_text text,
  p_added_lines integer,
  p_removed_lines integer,
  p_diff_truncated boolean,
  p_previous_bytes integer,
  p_new_bytes integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_source public.source_catalog%rowtype;
  v_run public.scan_runs%rowtype;
  v_previous public.source_snapshots%rowtype;
  v_snapshot_id uuid;
  v_change_id uuid;
  v_version integer;
  v_status text;
begin
  select * into v_source
  from public.source_catalog
  where id = p_source_id and enabled
  for update;
  if not found then
    raise exception 'Source is missing or disabled' using errcode = 'P0002';
  end if;

  select * into v_run
  from public.scan_runs
  where id = p_scan_run_id and source_id = p_source_id
  for update;
  if not found then
    raise exception 'Scan run was not found' using errcode = 'P0002';
  end if;

  if v_run.status <> 'pending' then
    return jsonb_build_object(
      'status', v_run.status,
      'snapshotId', v_run.result_snapshot_id,
      'changeId', v_run.result_change_id,
      'replayed', true
    );
  end if;

  select * into v_previous
  from public.source_snapshots
  where source_id = p_source_id
  order by version desc
  limit 1;

  if p_not_modified then
    if p_http_status <> 304 or v_previous.id is null then
      raise exception '304 response requires an existing baseline snapshot'
        using errcode = '22023';
    end if;

    update public.scan_runs
    set status = 'not_modified', finished_at = now(), http_status = p_http_status,
        content_bytes = 0, result_snapshot_id = v_previous.id
    where id = p_scan_run_id;

    update public.source_catalog
    set last_checked_at = now(), last_success_at = now(),
        etag = p_etag, last_modified = p_last_modified
    where id = p_source_id;

    return jsonb_build_object('status', 'not_modified', 'snapshotId', v_previous.id);
  end if;

  if p_http_status is null or p_content_bytes is null or p_not_modified is null
     or p_http_status < 200 or p_http_status >= 300
     or p_content_bytes < 0 or p_content_bytes > 2097152
     or p_content_hash is null or p_content_hash !~ '^[a-f0-9]{64}$'
     or p_normalized_content is null
     or octet_length(p_normalized_content) > 524288
     or p_previous_bytes is null or p_previous_bytes < 0 or p_previous_bytes > 524288
     or p_new_bytes is null or p_new_bytes < 0 or p_new_bytes > 524288
     or p_new_bytes <> octet_length(p_normalized_content)
     or p_added_lines is null or p_added_lines < 0
     or p_removed_lines is null or p_removed_lines < 0
     or p_diff_truncated is null or p_diff_text is null
     or octet_length(p_diff_text) > 16384 then
    raise exception 'Scan result failed persistence validation' using errcode = '22023';
  end if;

  if p_etag is not null and octet_length(p_etag) > 512
     or p_last_modified is not null and octet_length(p_last_modified) > 512 then
    raise exception 'Response validators exceed their size limit' using errcode = '22023';
  end if;

  if v_previous.id is not null and v_previous.content_hash = p_content_hash then
    if v_previous.normalized_content <> p_normalized_content then
      raise exception 'Content hash collision or inconsistent normalization'
        using errcode = '23514';
    end if;

    update public.scan_runs
    set status = 'unchanged', finished_at = now(), http_status = p_http_status,
        content_bytes = p_content_bytes, result_snapshot_id = v_previous.id
    where id = p_scan_run_id;

    update public.source_catalog
    set last_checked_at = now(), last_success_at = now(),
        etag = p_etag, last_modified = p_last_modified
    where id = p_source_id;

    return jsonb_build_object('status', 'unchanged', 'snapshotId', v_previous.id);
  end if;

  if v_previous.id is distinct from p_expected_previous_snapshot_id then
    return jsonb_build_object(
      'status', 'stale',
      'previous', case when v_previous.id is null then null else jsonb_build_object(
        'id', v_previous.id,
        'version', v_previous.version,
        'contentHash', v_previous.content_hash,
        'normalizedContent', v_previous.normalized_content,
        'normalizedBytes', v_previous.normalized_bytes
      ) end
    );
  end if;

  if p_previous_bytes <> coalesce(v_previous.normalized_bytes, 0) then
    raise exception 'Previous content size does not match the locked snapshot'
      using errcode = '22023';
  end if;

  v_version := coalesce(v_previous.version, 0) + 1;
  insert into public.source_snapshots (
    source_id, scan_run_id, previous_snapshot_id, version,
    content_hash, normalized_content, normalized_bytes, content_bytes
  ) values (
    p_source_id, p_scan_run_id, v_previous.id, v_version,
    p_content_hash, p_normalized_content, p_new_bytes, p_content_bytes
  ) returning id into v_snapshot_id;

  if v_previous.id is null then
    v_status := 'success';
  else
    v_status := 'changed';
    insert into public.source_changes (
      source_id, scan_run_id, previous_snapshot_id, new_snapshot_id,
      diff_text, added_lines, removed_lines, diff_truncated,
      previous_bytes, new_bytes
    ) values (
      p_source_id, p_scan_run_id, v_previous.id, v_snapshot_id,
      p_diff_text, p_added_lines, p_removed_lines, p_diff_truncated,
      v_previous.normalized_bytes, p_new_bytes
    ) returning id into v_change_id;
  end if;

  update public.scan_runs
  set status = v_status, finished_at = now(), http_status = p_http_status,
      content_bytes = p_content_bytes,
      result_snapshot_id = v_snapshot_id, result_change_id = v_change_id
  where id = p_scan_run_id;

  update public.source_catalog
  set last_checked_at = now(), last_success_at = now(),
      last_changed_at = case when v_status = 'changed' then now() else last_changed_at end,
      etag = p_etag, last_modified = p_last_modified
  where id = p_source_id;

  return jsonb_build_object(
    'status', v_status,
    'snapshotId', v_snapshot_id,
    'changeId', v_change_id,
    'version', v_version
  );
end;
$$;

create trigger workspaces_set_updated_at before update on public.workspaces
  for each row execute function private.set_updated_at();
create trigger workspace_members_set_updated_at before update on public.workspace_members
  for each row execute function private.set_updated_at();
create trigger companies_set_updated_at before update on public.companies
  for each row execute function private.set_updated_at();
create trigger company_context_set_updated_at before update on public.company_context
  for each row execute function private.set_updated_at();
create trigger dependency_catalog_set_updated_at before update on public.dependency_catalog
  for each row execute function private.set_updated_at();
create trigger source_catalog_set_updated_at before update on public.source_catalog
  for each row execute function private.set_updated_at();
create trigger workspace_dependencies_set_updated_at before update on public.workspace_dependencies
  for each row execute function private.set_updated_at();
create trigger dependency_context_set_updated_at before update on public.dependency_context
  for each row execute function private.set_updated_at();

create trigger source_snapshots_immutable
  before update or delete on public.source_snapshots
  for each row execute function private.prevent_immutable_evidence_mutation();
create trigger source_snapshots_no_truncate
  before truncate on public.source_snapshots
  for each statement execute function private.prevent_immutable_evidence_mutation();
create trigger source_changes_immutable
  before update or delete on public.source_changes
  for each row execute function private.prevent_immutable_evidence_mutation();
create trigger source_changes_no_truncate
  before truncate on public.source_changes
  for each statement execute function private.prevent_immutable_evidence_mutation();

grant execute on function private.has_workspace_role(uuid, text[]) to authenticated;
revoke all on function private.set_updated_at() from public, anon, authenticated;
revoke all on function private.prevent_immutable_evidence_mutation() from public, anon, authenticated;
revoke all on function public.create_workspace(text) from public, anon, authenticated;
revoke all on function public.begin_source_scan(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.list_due_source_ids(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.record_source_scan_failure(uuid, uuid, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.record_source_scan_result(
  uuid, uuid, integer, bigint, boolean, text, text, text, text,
  uuid, text, integer, integer, boolean, integer, integer
) from public, anon, authenticated;
grant execute on function public.begin_source_scan(uuid, text, integer) to service_role;
grant execute on function public.create_workspace(text) to authenticated;
grant execute on function public.list_due_source_ids(timestamptz, integer) to service_role;
grant execute on function public.record_source_scan_failure(uuid, uuid, text, text, integer)
  to service_role;
grant execute on function public.record_source_scan_result(
  uuid, uuid, integer, bigint, boolean, text, text, text, text,
  uuid, text, integer, integer, boolean, integer, integer
) to service_role;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.companies enable row level security;
alter table public.company_context enable row level security;
alter table public.workspace_dependencies enable row level security;
alter table public.dependency_context enable row level security;
alter table public.dependency_catalog enable row level security;
alter table public.source_catalog enable row level security;
alter table public.scan_runs enable row level security;
alter table public.source_snapshots enable row level security;
alter table public.source_changes enable row level security;

revoke all on table public.workspaces, public.workspace_members, public.companies,
  public.company_context, public.workspace_dependencies, public.dependency_context,
  public.dependency_catalog, public.source_catalog, public.scan_runs,
  public.source_snapshots, public.source_changes
  from public, anon, authenticated;

grant select, update on table public.workspaces to authenticated;
grant select on table public.workspace_members to authenticated;
grant select, insert, update, delete on table public.companies, public.company_context,
  public.workspace_dependencies, public.dependency_context to authenticated;
grant select on table public.dependency_catalog, public.source_catalog to authenticated;
grant all on table public.workspaces, public.workspace_members, public.companies,
  public.company_context, public.workspace_dependencies, public.dependency_context,
  public.dependency_catalog, public.source_catalog, public.scan_runs,
  public.source_snapshots, public.source_changes to service_role;

create policy workspaces_select_member on public.workspaces
  for select to authenticated
  using ((select private.has_workspace_role(id, array['owner', 'admin', 'member'])));
create policy workspaces_update_admin on public.workspaces
  for update to authenticated
  using ((select private.has_workspace_role(id, array['owner', 'admin'])))
  with check ((select private.has_workspace_role(id, array['owner', 'admin'])));

create policy workspace_members_select_self_or_admin on public.workspace_members
  for select to authenticated
  using (
    user_id = (select auth.uid()) or
    (select private.has_workspace_role(workspace_id, array['owner', 'admin']))
  );
create policy companies_select_member on public.companies
  for select to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member'])));
create policy companies_insert_admin on public.companies
  for insert to authenticated
  with check ((select private.has_workspace_role(workspace_id, array['owner', 'admin'])));
create policy companies_update_admin on public.companies
  for update to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin'])))
  with check ((select private.has_workspace_role(workspace_id, array['owner', 'admin'])));
create policy companies_delete_admin on public.companies
  for delete to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin'])));

create policy company_context_select_member on public.company_context
  for select to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member'])));
create policy company_context_insert_admin on public.company_context
  for insert to authenticated
  with check ((select private.has_workspace_role(workspace_id, array['owner', 'admin'])));
create policy company_context_update_admin on public.company_context
  for update to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin'])))
  with check ((select private.has_workspace_role(workspace_id, array['owner', 'admin'])));
create policy company_context_delete_admin on public.company_context
  for delete to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin'])));

create policy workspace_dependencies_select_member on public.workspace_dependencies
  for select to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member'])));
create policy workspace_dependencies_insert_admin on public.workspace_dependencies
  for insert to authenticated
  with check (
    selected_by = (select auth.uid())
    and (select private.has_workspace_role(workspace_id, array['owner', 'admin']))
  );
create policy workspace_dependencies_update_admin on public.workspace_dependencies
  for update to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin'])))
  with check ((select private.has_workspace_role(workspace_id, array['owner', 'admin'])));
create policy workspace_dependencies_delete_admin on public.workspace_dependencies
  for delete to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin'])));

create policy dependency_context_select_member on public.dependency_context
  for select to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member'])));
create policy dependency_context_insert_admin on public.dependency_context
  for insert to authenticated
  with check ((select private.has_workspace_role(workspace_id, array['owner', 'admin'])));
create policy dependency_context_update_admin on public.dependency_context
  for update to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin'])))
  with check ((select private.has_workspace_role(workspace_id, array['owner', 'admin'])));
create policy dependency_context_delete_admin on public.dependency_context
  for delete to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin'])));

create policy dependency_catalog_read_enabled on public.dependency_catalog
  for select to authenticated using (enabled);
create policy source_catalog_read_enabled on public.source_catalog
  for select to authenticated using (enabled);

insert into public.dependency_catalog (slug, name, category, website_url)
values ('openai', 'OpenAI', 'ai', 'https://openai.com')
on conflict (slug) do nothing;

insert into public.source_catalog (dependency_id, name, source_type, url, default_interval_seconds)
select id, 'OpenAI API pricing', 'pricing', 'https://openai.com/api/pricing/', 86400
from public.dependency_catalog
where slug = 'openai'
on conflict (dependency_id, source_type, name) do nothing;
