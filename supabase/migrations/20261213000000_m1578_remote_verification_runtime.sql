-- Private, bounded artifact transport for the dedicated M15.78 verification runner.
-- No authenticated/anonymous storage policies are created; only the trusted
-- server-side Storage client can upload, read, sign, or purge these objects.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'fix-engine-verification-artifacts',
  'fix-engine-verification-artifacts',
  false,
  536870912,
  array['application/gzip', 'application/json', 'application/octet-stream']
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table public.fix_verification_snapshots (
  id uuid primary key default gen_random_uuid(),
  fix_run_id uuid not null,
  workspace_id uuid not null,
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_path text not null,
  status text not null default 'active' check (status in ('active','terminal','purged')),
  created_at timestamptz not null default now(),
  terminal_at timestamptz,
  purge_claimed_until timestamptz,
  purged_at timestamptz,
  constraint fix_verification_snapshot_path_matches_identity check (
    artifact_path = 'snapshots/' || fix_run_id::text || '/' || snapshot_sha256 || '.tar.gz'
  ),
  constraint fix_verification_snapshot_run_scope_fkey
    foreign key(fix_run_id,workspace_id) references public.fix_runs(id,workspace_id) on delete cascade,
  constraint fix_verification_snapshot_run_sha_unique unique(fix_run_id,snapshot_sha256),
  constraint fix_verification_snapshot_state_times check (
    (status='active' and terminal_at is null and purged_at is null) or
    (status='terminal' and terminal_at is not null and purged_at is null) or
    (status='purged' and terminal_at is not null and purged_at is not null)
  ),
  constraint fix_verification_snapshot_claim_state check (
    purge_claimed_until is null or status='terminal'
  )
);
create index fix_verification_snapshots_retention_idx
  on public.fix_verification_snapshots(status,terminal_at,purge_claimed_until)
  where status='terminal';
alter table public.fix_verification_snapshots enable row level security;
revoke all on public.fix_verification_snapshots from public,anon,authenticated;
revoke insert,update,delete on public.fix_verification_snapshots from service_role;
grant select on public.fix_verification_snapshots to service_role;

create function public.register_fix_verification_snapshot(
  p_fix_run_id uuid,
  p_workspace_id uuid,
  p_snapshot_sha256 text
)
returns text language plpgsql security definer set search_path = '' as $$
declare v_path text; v_run public.fix_runs%rowtype; v_existing public.fix_verification_snapshots%rowtype;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if p_snapshot_sha256 is null or p_snapshot_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid_fix_snapshot_identity' using errcode='22023'; end if;
  select * into v_run from public.fix_runs r
    where r.id=p_fix_run_id and r.workspace_id=p_workspace_id for update;
  if not found or v_run.current_stage<>'verify_patch' or v_run.status<>'validating' then
    raise exception 'fix_snapshot_stage_scope_invalid' using errcode='42501'; end if;
  v_path := 'snapshots/' || p_fix_run_id::text || '/' || p_snapshot_sha256 || '.tar.gz';
  insert into public.fix_verification_snapshots(
    fix_run_id,workspace_id,snapshot_sha256,artifact_path,status,terminal_at,purge_claimed_until,purged_at
  ) values (p_fix_run_id,p_workspace_id,p_snapshot_sha256,v_path,'active',null,null,null)
  on conflict (fix_run_id,snapshot_sha256) do update set
    status='active',terminal_at=null,purge_claimed_until=null,purged_at=null
  returning * into v_existing;
  if v_existing.artifact_path<>v_path or v_existing.workspace_id<>p_workspace_id then
    raise exception 'fix_snapshot_identity_conflict' using errcode='23505'; end if;
  return v_path;
end;
$$;
revoke all on function public.register_fix_verification_snapshot(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.register_fix_verification_snapshot(uuid,uuid,text) to service_role;

create function public.mark_fix_verification_snapshot_terminal(
  p_fix_run_id uuid,
  p_workspace_id uuid,
  p_snapshot_sha256 text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  update public.fix_verification_snapshots s set status='terminal',terminal_at=coalesce(s.terminal_at,now()),purge_claimed_until=null
  where s.fix_run_id=p_fix_run_id and s.workspace_id=p_workspace_id
    and s.snapshot_sha256=p_snapshot_sha256 and s.status in ('active','terminal');
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'fix_snapshot_terminal_transition_invalid' using errcode='40001'; end if;
  return true;
end;
$$;
revoke all on function public.mark_fix_verification_snapshot_terminal(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.mark_fix_verification_snapshot_terminal(uuid,uuid,text) to service_role;

create function public.claim_expired_fix_verification_snapshots(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_rows jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if p_limit not between 1 and 100 then raise exception 'invalid_fix_snapshot_purge_limit' using errcode='22023'; end if;
  with candidates as (
    select s.id from public.fix_verification_snapshots s
    join public.fix_runs r on r.id=s.fix_run_id and r.workspace_id=s.workspace_id
    where s.status='terminal' and s.terminal_at<now()-interval '1 day'
      and (s.purge_claimed_until is null or s.purge_claimed_until<now())
      and r.status not in ('queued','diagnosing','planning','generating_patch','applying_patch','validating','preflight_pending','risk_assessing','ready_for_pr','creating_pr')
    order by s.terminal_at,s.id for update of s skip locked limit p_limit
  ), claimed as (
    update public.fix_verification_snapshots s set purge_claimed_until=now()+interval '10 minutes'
    from candidates c where s.id=c.id
    returning s.workspace_id,s.fix_run_id,s.artifact_path
  ) select coalesce(jsonb_agg(jsonb_build_object(
    'workspaceId',workspace_id,'fixRunId',fix_run_id,'path',artifact_path
  ) order by workspace_id,fix_run_id,artifact_path),'[]'::jsonb) into v_rows from claimed;
  return jsonb_build_object('artifacts',v_rows,'count',jsonb_array_length(v_rows));
end;
$$;
revoke all on function public.claim_expired_fix_verification_snapshots(integer) from public,anon,authenticated;
grant execute on function public.claim_expired_fix_verification_snapshots(integer) to service_role;

create function public.complete_fix_verification_snapshot_purge(p_paths text[])
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if p_paths is null or cardinality(p_paths)>100 or exists(
    select 1 from unnest(p_paths) x where x !~ '^snapshots/[0-9a-f-]{36}/[a-f0-9]{64}\.tar\.gz$'
  ) or cardinality(p_paths)<>(select count(distinct x)::integer from unnest(p_paths) x) then
    raise exception 'invalid_fix_snapshot_purge_paths' using errcode='22023'; end if;
  update public.fix_verification_snapshots s set status='purged',purged_at=now(),purge_claimed_until=null
  where s.artifact_path=any(p_paths) and s.status='terminal' and s.purge_claimed_until>now()
    and s.terminal_at<now()-interval '1 day';
  get diagnostics v_count=row_count;
  if v_count<>cardinality(p_paths) then raise exception 'fix_snapshot_purge_lease_lost' using errcode='40001'; end if;
  return v_count;
end;
$$;
revoke all on function public.complete_fix_verification_snapshot_purge(text[]) from public,anon,authenticated;
grant execute on function public.complete_fix_verification_snapshot_purge(text[]) to service_role;
