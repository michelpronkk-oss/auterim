create function public.get_dependency_source_baselines(
  p_workspace_id uuid,
  p_source_ids uuid[]
)
returns table(source_id uuid, latest_baseline_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = auth.uid()
  ) then
    raise exception 'Workspace is unavailable' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_source_ids), 0) > 100 then
    raise exception 'Too many sources' using errcode = '22023';
  end if;
  return query
  select requested.id, baseline.created_at
  from (select distinct unnest(coalesce(p_source_ids, '{}'::uuid[])) as id) requested
  join public.source_catalog source on source.id = requested.id and source.enabled
  join public.workspace_dependencies dependency
    on dependency.dependency_id = source.dependency_id
    and dependency.workspace_id = p_workspace_id
    and dependency.monitoring_enabled
  left join lateral (
    select snapshot.created_at
    from public.source_snapshots snapshot
    where snapshot.source_id = source.id
    order by snapshot.created_at desc, snapshot.id desc
    limit 1
  ) baseline on true;
end;
$$;

revoke all on function public.get_dependency_source_baselines(uuid, uuid[]) from public, anon;
grant execute on function public.get_dependency_source_baselines(uuid, uuid[]) to authenticated;

create or replace function private.workspace_repository_limit(p_workspace_id uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select case private.workspace_quota_plan(p_workspace_id)
    when 'pro' then 5 when 'business' then 25 else 0 end
$$;
revoke all on function private.workspace_repository_limit(uuid) from public, anon, authenticated;
grant execute on function private.workspace_repository_limit(uuid) to service_role;

create table public.public_rate_limit_buckets (
  policy text not null check (policy in ('public_stack_scan', 'public_conversion')),
  client_fingerprint text not null check (client_fingerprint ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (policy, client_fingerprint, window_start)
);
create index public_rate_limit_buckets_window_idx
  on public.public_rate_limit_buckets (window_start);
alter table public.public_rate_limit_buckets enable row level security;
revoke all on public.public_rate_limit_buckets from public, anon, authenticated;
grant all on public.public_rate_limit_buckets to service_role;

create function public.claim_public_rate_limit(
  p_policy text,
  p_fingerprint text,
  p_limit integer,
  p_window_seconds integer,
  p_now timestamptz default now()
)
returns table(allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_window_start timestamptz;
  v_count integer;
begin
  if p_policy not in ('public_stack_scan', 'public_conversion')
    or p_fingerprint !~ '^[0-9a-f]{64}$'
    or p_limit < 1 or p_limit > 100
    or p_window_seconds < 1 or p_window_seconds > 86400
    or p_now is null then
    raise exception 'invalid_rate_limit_claim' using errcode = '22023';
  end if;
  v_window_start := to_timestamp(
    floor(extract(epoch from p_now) / p_window_seconds) * p_window_seconds
  );
  insert into public.public_rate_limit_buckets as bucket (
    policy, client_fingerprint, window_start, request_count
  ) values (p_policy, p_fingerprint, v_window_start, 1)
  on conflict (policy, client_fingerprint, window_start) do update
    set request_count = least(bucket.request_count + 1, p_limit + 1)
  returning request_count into v_count;
  with expired as (
    select ctid from public.public_rate_limit_buckets
    where window_start < p_now - interval '2 days'
    limit 1000
  )
  delete from public.public_rate_limit_buckets bucket
  using expired where bucket.ctid = expired.ctid;
  return query select
    v_count <= p_limit,
    greatest(p_limit - v_count, 0),
    greatest(1, ceil(extract(epoch from (v_window_start + make_interval(secs => p_window_seconds) - p_now)))::integer);
end;
$$;
revoke all on function public.claim_public_rate_limit(text, text, integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_public_rate_limit(text, text, integer, integer, timestamptz)
  to service_role;

create table public.public_scan_capacity (
  singleton_id smallint primary key check (singleton_id = 1)
);
insert into public.public_scan_capacity (singleton_id) values (1);
create table public.public_scan_leases (
  lease_id uuid primary key,
  expires_at timestamptz not null
);
create index public_scan_leases_expiry_idx on public.public_scan_leases (expires_at);
alter table public.public_scan_capacity enable row level security;
alter table public.public_scan_leases enable row level security;
revoke all on public.public_scan_capacity, public.public_scan_leases from public, anon, authenticated;
grant all on public.public_scan_capacity, public.public_scan_leases to service_role;

create function public.claim_public_scan_slot(
  p_lease_id uuid,
  p_limit integer default 2,
  p_lease_seconds integer default 30
)
returns table(acquired boolean, lease_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  if p_lease_id is null or p_limit < 1 or p_limit > 10
    or p_lease_seconds < 15 or p_lease_seconds > 60 then
    raise exception 'invalid_scan_slot_claim' using errcode = '22023';
  end if;
  perform singleton_id from public.public_scan_capacity where singleton_id = 1 for update;
  if not found then raise exception 'scan_capacity_unavailable' using errcode = '55000'; end if;
  delete from public.public_scan_leases where expires_at <= now();
  if (select count(*) from public.public_scan_leases) >= p_limit then
    return query select false, null::uuid;
    return;
  end if;
  insert into public.public_scan_leases (lease_id, expires_at)
  values (p_lease_id, now() + make_interval(secs => p_lease_seconds))
  on conflict on constraint public_scan_leases_pkey do nothing;
  if not found then
    return query select false, null::uuid;
    return;
  end if;
  return query select true, p_lease_id;
end;
$$;

create function public.release_public_scan_slot(p_lease_id uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_lease_id is null then return false; end if;
  delete from public.public_scan_leases where lease_id = p_lease_id;
  return found;
end;
$$;
revoke all on function public.claim_public_scan_slot(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.release_public_scan_slot(uuid) from public, anon, authenticated;
grant execute on function public.claim_public_scan_slot(uuid, integer, integer) to service_role;
grant execute on function public.release_public_scan_slot(uuid) to service_role;
