-- Auterim Milestone 7: repository protection, versioned Preflight, and safe remediation.

alter table public.impact_assessments add constraint impact_assessments_id_workspace_key unique (id,workspace_id);

create table public.repository_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider text not null default 'github' check (provider = 'github'),
  installation_id bigint not null check (installation_id > 0),
  account_login text not null check (char_length(account_login) between 1 and 255),
  status text not null default 'connected' check (status in ('connected','revoked','error')),
  connected_by uuid not null references auth.users (id) on delete restrict,
  connected_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint repository_connections_workspace_installation_key unique (workspace_id, provider, installation_id),
  constraint repository_connections_id_workspace_key unique (id, workspace_id),
  constraint repository_connections_revoked_check check ((status = 'revoked') = (revoked_at is not null))
);
create index repository_connections_workspace_status_idx on public.repository_connections (workspace_id,status);

create table public.repositories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  connection_id uuid not null,
  external_id bigint not null check (external_id > 0),
  owner text not null check (char_length(owner) between 1 and 255),
  name text not null check (char_length(name) between 1 and 255),
  default_branch text not null check (char_length(default_branch) between 1 and 255),
  private boolean not null default true,
  archived boolean not null default false,
  selected_for_protection boolean not null default false,
  status text not null default 'available' check (status in ('available','access_revoked','archived')),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint repositories_connection_workspace_fkey foreign key (connection_id,workspace_id)
    references public.repository_connections (id,workspace_id) on delete cascade,
  constraint repositories_external_workspace_key unique (workspace_id,external_id),
  constraint repositories_id_workspace_key unique (id,workspace_id)
);
create index repositories_selected_idx on public.repositories (workspace_id,connection_id) where selected_for_protection and status='available';

create table public.workspace_repository_access (
  workspace_id uuid not null,
  workspace_dependency_id uuid not null,
  repository_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (workspace_dependency_id,repository_id),
  foreign key (workspace_dependency_id,workspace_id) references public.workspace_dependencies (id,workspace_id) on delete cascade,
  foreign key (repository_id,workspace_id) references public.repositories (id,workspace_id) on delete cascade
);
create index workspace_repository_access_repository_idx on public.workspace_repository_access (repository_id,workspace_dependency_id);

create table public.repository_installation_states (
  state_hash text primary key check (state_hash ~ '^[a-f0-9]{64}$'),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  actor_user_id uuid not null references auth.users (id) on delete cascade,
  github_login text check (github_login is null or char_length(github_login)<=255),
  oauth_completed_at timestamptz,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index repository_installation_states_expiry_idx on public.repository_installation_states (expires_at) where consumed_at is null;

create table public.github_webhook_deliveries (
  delivery_id uuid primary key,
  event_kind text not null check (char_length(event_kind)<=80),
  action text check (action is null or char_length(action)<=80),
  received_at timestamptz not null default now()
);

create table public.preflight_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  impact_assessment_id uuid not null,
  status text not null default 'queued' check (status in ('queued','running','completed','partial','failed','canceled')),
  verified_impact text check (verified_impact is null or verified_impact in ('verified','likely','not_found','inconclusive')),
  confidence numeric(4,3) check (confidence is null or confidence between 0 and 1),
  complexity text check (complexity is null or complexity in ('low','medium','high','unknown')),
  recommended_remediation text check (recommended_remediation is null or octet_length(recommended_remediation) <= 1200),
  effective_at timestamptz,
  announced_at timestamptz,
  deadline timestamptz,
  days_remaining integer,
  preflight_version text not null check (char_length(preflight_version) between 1 and 80),
  repository_set_fingerprint text not null check (repository_set_fingerprint ~ '^[a-f0-9]{64}$'),
  change_fingerprint text not null check (change_fingerprint ~ '^[a-f0-9]{64}$'),
  provider text check (provider is null or provider='openai'),
  model text check (model is null or octet_length(model) <= 160),
  repositories_scanned integer not null default 0 check (repositories_scanned between 0 and 100),
  error_category text check (error_category is null or char_length(error_category) <= 80),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id) references public.workspaces (id) on delete cascade,
  foreign key (impact_assessment_id,workspace_id) references public.impact_assessments (id,workspace_id) on delete cascade,
  constraint preflight_run_identity_key unique (workspace_id,impact_assessment_id,repository_set_fingerprint,change_fingerprint,preflight_version),
  constraint preflight_run_id_workspace_key unique (id,workspace_id),
  constraint preflight_run_result_state_check check (
    (status in ('queued','running','failed','canceled') and verified_impact is null and completed_at is null)
    or (status in ('completed','partial') and verified_impact is not null and completed_at is not null)
  )
);
create index preflight_runs_workspace_recent_idx on public.preflight_runs (workspace_id,created_at desc);
create index preflight_runs_impact_idx on public.preflight_runs (impact_assessment_id,created_at desc);

create table public.preflight_findings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  preflight_run_id uuid not null,
  repository_id uuid not null,
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{40,64}$'),
  file_path text not null check (char_length(file_path) between 1 and 1024 and left(file_path,1) <> '/'),
  line_start integer not null check (line_start > 0),
  line_end integer not null check (line_end >= line_start and line_end - line_start <= 200),
  finding_type text not null check (finding_type in ('model_reference','endpoint_reference','parameter_reference','package_version','provider_import','configuration_reference','environment_variable_name')),
  affected_entity text not null check (char_length(affected_entity) between 1 and 255),
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  verification text not null check (verification in ('verified','likely')),
  explanation text not null check (octet_length(explanation) between 1 and 1200),
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz not null default now(),
  foreign key (preflight_run_id,workspace_id) references public.preflight_runs (id,workspace_id) on delete cascade,
  foreign key (repository_id,workspace_id) references public.repositories (id,workspace_id) on delete cascade,
  constraint preflight_finding_identity_key unique (preflight_run_id,repository_id,commit_sha,file_path,evidence_fingerprint)
);
create index preflight_findings_workspace_run_idx on public.preflight_findings (workspace_id,preflight_run_id);

create table public.remediation_proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  preflight_run_id uuid not null,
  status text not null default 'prepared' check (status in ('prepared','rejected','draft_pr_prepared','ci_pending','ci_passed','ci_failed')),
  proposal_kind text not null default 'grounded_guidance' check (proposal_kind in ('grounded_guidance','patch')),
  proposal_fingerprint text not null check (proposal_fingerprint ~ '^[a-f0-9]{64}$'),
  rationale text not null check (octet_length(rationale) between 1 and 2000),
  migration_notes text not null default '' check (octet_length(migration_notes) <= 2000),
  validation_requirements jsonb not null default '[]'::jsonb check (jsonb_typeof(validation_requirements)='array' and jsonb_array_length(validation_requirements)<=20 and octet_length(validation_requirements::text)<=4000),
  affected_files jsonb not null check (jsonb_typeof(affected_files)='array' and jsonb_array_length(affected_files) between 1 and 20 and octet_length(affected_files::text)<=4000),
  patch text check (patch is null or octet_length(patch) between 1 and 65536),
  base_commit_sha text not null check (base_commit_sha ~ '^[a-f0-9]{40,64}$'),
  branch_name text check (branch_name is null or char_length(branch_name)<=255),
  draft_pr_url text check (draft_pr_url is null or (draft_pr_url ~ '^https://github\.com/' and octet_length(draft_pr_url)<=2048)),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (preflight_run_id,workspace_id) references public.preflight_runs (id,workspace_id) on delete cascade,
  constraint remediation_proposal_fingerprint_key unique (preflight_run_id,proposal_fingerprint),
  constraint remediation_proposals_id_workspace_key unique (id,workspace_id),
  constraint remediation_proposal_branch_check check (branch_name is null or branch_name like 'auterim/fix/%'),
  constraint remediation_proposal_patch_kind_check check ((proposal_kind='patch' and patch is not null) or (proposal_kind='grounded_guidance' and patch is null)),
  constraint remediation_proposal_pr_state_check check ((draft_pr_url is null) or status in ('draft_pr_prepared','ci_pending','ci_passed','ci_failed'))
);
create index remediation_proposals_workspace_recent_idx on public.remediation_proposals (workspace_id,created_at desc);

create table public.protection_value_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  event_kind text not null check (event_kind in ('automatic_preflight_started','preflight_completed','verified_risk_found','verified_risk_not_found','remediation_generated','draft_pr_prepared')),
  impact_assessment_id uuid,
  preflight_run_id uuid,
  remediation_proposal_id uuid,
  dedupe_key text not null check (dedupe_key ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object' and octet_length(metadata::text)<=2000),
  constraint protection_value_event_workspace_key unique (workspace_id,event_kind,dedupe_key),
  foreign key (impact_assessment_id,workspace_id) references public.impact_assessments (id,workspace_id) on delete cascade,
  foreign key (preflight_run_id,workspace_id) references public.preflight_runs (id,workspace_id) on delete cascade,
  foreign key (remediation_proposal_id,workspace_id) references public.remediation_proposals (id,workspace_id) on delete cascade
);
create index protection_value_events_workspace_recent_idx on public.protection_value_events (workspace_id,occurred_at desc);

create table public.preflight_dispatch_queue (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  impact_assessment_id uuid not null,
  repository_set_fingerprint text not null check (repository_set_fingerprint ~ '^[a-f0-9]{64}$'),
  status text not null default 'queued' check (status in ('queued','dispatched','complete','failed','superseded')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 6),
  error_category text check (error_category is null or char_length(error_category)<=80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id) references public.workspaces (id) on delete cascade,
  constraint preflight_dispatch_impact_workspace_fkey foreign key (impact_assessment_id,workspace_id)
    references public.impact_assessments (id,workspace_id) on delete cascade,
  constraint preflight_dispatch_impact_key unique (impact_assessment_id,repository_set_fingerprint)
);
create index preflight_dispatch_pending_idx on public.preflight_dispatch_queue (created_at,id) where status in ('queued','failed');

create trigger repository_connections_set_updated_at before update on public.repository_connections for each row execute function private.set_updated_at();
create trigger repositories_set_updated_at before update on public.repositories for each row execute function private.set_updated_at();
create trigger preflight_runs_set_updated_at before update on public.preflight_runs for each row execute function private.set_updated_at();
create trigger remediation_proposals_set_updated_at before update on public.remediation_proposals for each row execute function private.set_updated_at();
create trigger preflight_dispatch_queue_set_updated_at before update on public.preflight_dispatch_queue for each row execute function private.set_updated_at();

create function private.enqueue_eligible_preflight()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status <> 'assessed' or new.relevant is distinct from true then return new; end if;
  if not exists (
    select 1 from public.workspace_repository_access access
    join public.repositories repo on repo.id=access.repository_id and repo.workspace_id=access.workspace_id
    join public.repository_connections connection on connection.id=repo.connection_id and connection.workspace_id=repo.workspace_id
    where access.workspace_id=new.workspace_id and access.workspace_dependency_id=new.workspace_dependency_id
      and repo.selected_for_protection and repo.status='available' and connection.status='connected'
  ) then return new; end if;
  insert into public.preflight_dispatch_queue (workspace_id,impact_assessment_id)
  values (new.workspace_id,new.id) on conflict (impact_assessment_id) do nothing;
  return new;
end;
$$;
create trigger impact_assessments_enqueue_preflight after insert or update of status,relevant on public.impact_assessments
  for each row execute function private.enqueue_eligible_preflight();

create function private.record_automatic_preflight_started()
returns trigger language plpgsql security definer set search_path = '' as $$
declare event_key text;
begin
  event_key := md5(new.impact_assessment_id::text) || md5(new.impact_assessment_id::text);
  insert into public.protection_value_events (workspace_id,event_kind,impact_assessment_id,dedupe_key)
  values (new.workspace_id,'automatic_preflight_started',new.impact_assessment_id,event_key)
  on conflict (workspace_id,event_kind,dedupe_key) do nothing;
  return new;
end;
$$;
create trigger preflight_queue_record_value_event after insert on public.preflight_dispatch_queue
  for each row execute function private.record_automatic_preflight_started();

create function public.list_preflight_dispatch_queue(p_limit integer default 100)
returns table(queue_id uuid,workspace_id uuid,impact_assessment_id uuid)
language sql security invoker set search_path = '' as $$
  select queue.id,queue.workspace_id,queue.impact_assessment_id from public.preflight_dispatch_queue queue
  where queue.attempt_count<6 and (queue.status in ('queued','failed') or (queue.status='dispatched' and queue.updated_at<now()-interval '15 minutes'))
  order by queue.created_at,queue.id limit least(greatest(coalesce(p_limit,1),1),100);
$$;
create function public.mark_preflight_dispatch(p_queue_id uuid,p_status text,p_error_category text default null)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_status not in ('dispatched','complete','failed','superseded') then raise exception 'invalid_preflight_queue_status' using errcode='22023'; end if;
  update public.preflight_dispatch_queue set status=p_status,
    attempt_count=attempt_count+case when p_status='dispatched' then 1 else 0 end,
    error_category=case when p_status='failed' then left(coalesce(p_error_category,'preflight_failed'),80) else null end
  where id=p_queue_id and (p_status<>'dispatched' or attempt_count<6);
  if not found then raise exception 'preflight queue item is no longer current' using errcode='40001'; end if;
end;
$$;

create function public.claim_preflight_run(p_run_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.preflight_runs set status='running',started_at=now(),error_category=null
  where id=p_run_id and status in ('queued','failed');
  return found;
end;
$$;

create function public.set_repository_protection(
  p_repository_id uuid,p_selected boolean,p_dependency_ids uuid[]
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare repository_row public.repositories%rowtype; actor_id uuid := auth.uid(); dependency_count integer;
begin
  if actor_id is null or p_selected is null or p_dependency_ids is null or cardinality(p_dependency_ids)>50
    or (p_selected and cardinality(p_dependency_ids)=0) or (not p_selected and cardinality(p_dependency_ids)>0) then
    raise exception 'invalid_repository_selection' using errcode='22023';
  end if;
  select * into repository_row from public.repositories where id=p_repository_id for update;
  if not found then raise exception 'repository_not_found' using errcode='P0002'; end if;
  if not exists(select 1 from public.workspace_members where workspace_id=repository_row.workspace_id and user_id=actor_id) then
    raise exception 'forbidden' using errcode='42501';
  end if;
  if p_selected and (repository_row.status<>'available' or (select connection.status from public.repository_connections connection where connection.id=repository_row.connection_id)<>'connected') then
    raise exception 'repository_unavailable' using errcode='22023';
  end if;
  select count(distinct dependency_id)::integer into dependency_count from unnest(p_dependency_ids) dependency_id;
  if dependency_count<>cardinality(p_dependency_ids) then raise exception 'duplicate_dependency' using errcode='22023'; end if;
  if dependency_count>0 and dependency_count<>(select count(*) from public.workspace_dependencies dependency where dependency.workspace_id=repository_row.workspace_id and dependency.id=any(p_dependency_ids)) then
    raise exception 'dependency_not_found' using errcode='P0002';
  end if;
  delete from public.workspace_repository_access where repository_id=p_repository_id and workspace_id=repository_row.workspace_id;
  update public.repositories set selected_for_protection=p_selected where id=p_repository_id;
  if p_selected then
    insert into public.workspace_repository_access (workspace_id,workspace_dependency_id,repository_id)
    select repository_row.workspace_id,dependency_id,p_repository_id from unnest(p_dependency_ids) dependency_id;
  end if;
  return jsonb_build_object('repositoryId',p_repository_id,'selectedForProtection',p_selected,'dependencyCount',dependency_count);
end;
$$;

alter table public.repository_connections enable row level security;
alter table public.repositories enable row level security;
alter table public.workspace_repository_access enable row level security;
alter table public.repository_installation_states enable row level security;
alter table public.github_webhook_deliveries enable row level security;
alter table public.preflight_runs enable row level security;
alter table public.preflight_findings enable row level security;
alter table public.remediation_proposals enable row level security;
alter table public.protection_value_events enable row level security;
alter table public.preflight_dispatch_queue enable row level security;

create policy repository_connections_select_member on public.repository_connections for select to authenticated
  using (exists(select 1 from public.workspace_members member where member.workspace_id=repository_connections.workspace_id and member.user_id=(select auth.uid())));
create policy repositories_select_member on public.repositories for select to authenticated
  using (exists(select 1 from public.workspace_members member where member.workspace_id=repositories.workspace_id and member.user_id=(select auth.uid())));
create policy workspace_repository_access_select_member on public.workspace_repository_access for select to authenticated
  using (exists(select 1 from public.workspace_members member where member.workspace_id=workspace_repository_access.workspace_id and member.user_id=(select auth.uid())));
create policy preflight_runs_select_member on public.preflight_runs for select to authenticated
  using (exists(select 1 from public.workspace_members member where member.workspace_id=preflight_runs.workspace_id and member.user_id=(select auth.uid())));
create policy preflight_findings_select_member on public.preflight_findings for select to authenticated
  using (exists(select 1 from public.workspace_members member where member.workspace_id=preflight_findings.workspace_id and member.user_id=(select auth.uid())));
create policy remediation_proposals_select_member on public.remediation_proposals for select to authenticated
  using (exists(select 1 from public.workspace_members member where member.workspace_id=remediation_proposals.workspace_id and member.user_id=(select auth.uid())));
create policy protection_value_events_select_member on public.protection_value_events for select to authenticated
  using (exists(select 1 from public.workspace_members member where member.workspace_id=protection_value_events.workspace_id and member.user_id=(select auth.uid())));

revoke all on public.repository_connections,public.repositories,public.workspace_repository_access,public.repository_installation_states,
  public.preflight_runs,public.preflight_findings,public.remediation_proposals,public.protection_value_events,public.preflight_dispatch_queue
  from public,anon,authenticated;
revoke all on public.github_webhook_deliveries from public,anon,authenticated;
grant select on public.repository_connections,public.repositories,public.workspace_repository_access,public.preflight_runs,
  public.preflight_findings,public.remediation_proposals,public.protection_value_events to authenticated;
grant all on public.github_webhook_deliveries to service_role;
grant all on public.repository_connections,public.repositories,public.workspace_repository_access,public.repository_installation_states,
  public.preflight_runs,public.preflight_findings,public.remediation_proposals,public.protection_value_events,public.preflight_dispatch_queue to service_role;

revoke all on function private.enqueue_eligible_preflight() from public,anon,authenticated;
revoke all on function private.record_automatic_preflight_started() from public,anon,authenticated;
revoke all on function public.list_preflight_dispatch_queue(integer) from public,anon,authenticated;
revoke all on function public.mark_preflight_dispatch(uuid,text,text) from public,anon,authenticated;
revoke all on function public.claim_preflight_run(uuid) from public,anon,authenticated;
revoke all on function public.set_repository_protection(uuid,boolean,uuid[]) from public,anon;
grant execute on function public.set_repository_protection(uuid,boolean,uuid[]) to authenticated;
grant execute on function public.list_preflight_dispatch_queue(integer) to service_role;
grant execute on function public.mark_preflight_dispatch(uuid,text,text) to service_role;
grant execute on function public.claim_preflight_run(uuid) to service_role;

-- Bound worker retries and make result/finding persistence one transaction.
alter table public.preflight_runs add column run_lease_until timestamptz;
alter table public.preflight_runs add column run_claim_token uuid;
drop trigger preflight_queue_record_value_event on public.preflight_dispatch_queue;

create or replace function private.enqueue_eligible_preflight()
returns trigger language plpgsql security definer set search_path = '' as $$
declare repo_fingerprint text;
begin
  if new.status <> 'assessed' or new.relevant is distinct from true then return new; end if;
  if not exists (
    select 1 from public.source_change_classifications classification
    where classification.id=new.source_change_classification_id and classification.status='classified' and classification.material=true
  ) then return new; end if;
  if not exists (
    select 1 from public.workspace_repository_access access
    join public.repositories repo on repo.id=access.repository_id and repo.workspace_id=access.workspace_id
    join public.repository_connections connection on connection.id=repo.connection_id and connection.workspace_id=repo.workspace_id
    where access.workspace_id=new.workspace_id and access.workspace_dependency_id=new.workspace_dependency_id
      and repo.selected_for_protection and repo.status='available' and connection.status='connected'
  ) then return new; end if;
  select md5(coalesce(string_agg(access.repository_id::text,',' order by access.repository_id),'') || 'preflight') || md5('preflight' || coalesce(string_agg(access.repository_id::text,',' order by access.repository_id),'')) into repo_fingerprint
  from public.workspace_repository_access access
  join public.repositories repo on repo.id=access.repository_id and repo.workspace_id=access.workspace_id and repo.selected_for_protection and repo.status='available'
  join public.repository_connections connection on connection.id=repo.connection_id and connection.workspace_id=repo.workspace_id and connection.status='connected'
  where access.workspace_id=new.workspace_id and access.workspace_dependency_id=new.workspace_dependency_id;
  insert into public.preflight_dispatch_queue (workspace_id,impact_assessment_id,repository_set_fingerprint)
  values (new.workspace_id,new.id,repo_fingerprint) on conflict (impact_assessment_id,repository_set_fingerprint) do nothing;
  return new;
end;
$$;

drop function public.claim_preflight_run(uuid);
create function public.claim_preflight_run(p_run_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare claim_token uuid := gen_random_uuid();
begin
  update public.preflight_runs set status='running',started_at=now(),run_lease_until=now()+interval '15 minutes',run_claim_token=claim_token,error_category=null
  where id=p_run_id and (status in ('queued','failed') or (status='running' and (run_lease_until is null or run_lease_until<now())));
  if not found then return null; end if;
  return claim_token;
end;
$$;

create function private.record_preflight_started()
returns trigger language plpgsql security definer set search_path = '' as $$
declare event_key text;
begin
  if new.status='running' and old.status is distinct from 'running' then
    event_key := md5(new.id::text) || md5(new.id::text);
    insert into public.protection_value_events (workspace_id,event_kind,impact_assessment_id,preflight_run_id,dedupe_key)
    values (new.workspace_id,'automatic_preflight_started',new.impact_assessment_id,new.id,event_key)
    on conflict (workspace_id,event_kind,dedupe_key) do nothing;
  end if;
  return new;
end;
$$;
create trigger preflight_run_started_value_event after update of status on public.preflight_runs
  for each row execute function private.record_preflight_started();

create function private.record_preflight_completed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare event_key text;
begin
  if new.status in ('completed','partial') and old.status is distinct from new.status then
    event_key := md5(new.id::text) || md5(new.id::text);
    insert into public.protection_value_events (workspace_id,event_kind,impact_assessment_id,preflight_run_id,dedupe_key)
    values (new.workspace_id,'preflight_completed',new.impact_assessment_id,new.id,event_key)
    on conflict (workspace_id,event_kind,dedupe_key) do nothing;
    if new.status='completed' and new.verified_impact in ('verified','not_found') then
      insert into public.protection_value_events (workspace_id,event_kind,impact_assessment_id,preflight_run_id,dedupe_key)
      values (new.workspace_id,case when new.verified_impact='verified' then 'verified_risk_found' else 'verified_risk_not_found' end,new.impact_assessment_id,new.id,event_key)
      on conflict (workspace_id,event_kind,dedupe_key) do nothing;
    end if;
  end if;
  return new;
end;
$$;
create trigger preflight_run_completed_value_event after update of status on public.preflight_runs
  for each row execute function private.record_preflight_completed();

create function private.enqueue_preflight_for_access()
returns trigger language plpgsql security definer set search_path = '' as $$
declare assessment_row record; repo_fingerprint text;
begin
  select md5(coalesce(string_agg(access.repository_id::text,',' order by access.repository_id),'') || 'preflight') || md5('preflight' || coalesce(string_agg(access.repository_id::text,',' order by access.repository_id),'')) into repo_fingerprint
  from public.workspace_repository_access access
  join public.repositories repo on repo.id=access.repository_id and repo.workspace_id=access.workspace_id and repo.selected_for_protection and repo.status='available'
  join public.repository_connections connection on connection.id=repo.connection_id and connection.workspace_id=repo.workspace_id and connection.status='connected'
  where access.workspace_id=new.workspace_id and access.workspace_dependency_id=new.workspace_dependency_id;
  for assessment_row in
    select assessment.id,assessment.workspace_id from public.impact_assessments assessment
    join public.source_change_classifications classification on classification.id=assessment.source_change_classification_id and classification.status='classified' and classification.material
    where assessment.workspace_id=new.workspace_id and assessment.workspace_dependency_id=new.workspace_dependency_id
      and assessment.status='assessed' and assessment.relevant
  loop
    insert into public.preflight_dispatch_queue (workspace_id,impact_assessment_id,repository_set_fingerprint)
    values (assessment_row.workspace_id,assessment_row.id,repo_fingerprint)
    on conflict (impact_assessment_id,repository_set_fingerprint) do nothing;
  end loop;
  return new;
end;
$$;
create constraint trigger workspace_access_enqueue_existing_preflight after insert on public.workspace_repository_access
  deferrable initially deferred for each row execute function private.enqueue_preflight_for_access();

drop function public.mark_preflight_dispatch(uuid,text,text);
create function public.mark_preflight_dispatch(p_queue_id uuid,p_status text,p_error_category text default null)
returns integer language plpgsql security invoker set search_path = '' as $$
declare resulting_attempt integer;
begin
  if p_status not in ('dispatched','complete','failed','superseded') then raise exception 'invalid_preflight_queue_status' using errcode='22023'; end if;
  update public.preflight_dispatch_queue set status=p_status,
    attempt_count=attempt_count+case when p_status='dispatched' then 1 else 0 end,
    error_category=case when p_status='failed' then left(coalesce(p_error_category,'preflight_failed'),80) else null end
  where id=p_queue_id and (
    (p_status='dispatched' and attempt_count<6 and (status in ('queued','failed') or (status='dispatched' and updated_at<now()-interval '15 minutes')))
    or (p_status<>'dispatched' and status in ('queued','dispatched','failed'))
  ) returning attempt_count into resulting_attempt;
  if not found then raise exception 'preflight queue item is no longer current' using errcode='40001'; end if;
  return resulting_attempt;
end;
$$;

create function public.save_preflight_result(p_run_id uuid,p_claim_token uuid,p_repository_ids uuid[],p_result jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare run_row public.preflight_runs%rowtype; finding jsonb; dependency_id uuid;
begin
  select * into run_row from public.preflight_runs where id=p_run_id and status='running' and run_claim_token=p_claim_token and run_lease_until>now() for update;
  if not found then raise exception 'preflight_run_not_running' using errcode='40001'; end if;
  select assessment.workspace_dependency_id into dependency_id from public.impact_assessments assessment
    where assessment.id=run_row.impact_assessment_id and assessment.workspace_id=run_row.workspace_id;
  if dependency_id is null or p_repository_ids is null or cardinality(p_repository_ids)>5
    or cardinality(p_repository_ids)<>(select count(distinct id) from unnest(p_repository_ids) id)
    or cardinality(p_repository_ids)<>(
      select count(*) from unnest(p_repository_ids) expected(id)
      join public.workspace_repository_access access on access.repository_id=expected.id and access.workspace_id=run_row.workspace_id and access.workspace_dependency_id=dependency_id
      join public.repositories repo on repo.id=expected.id and repo.workspace_id=run_row.workspace_id and repo.selected_for_protection and repo.status='available'
      join public.repository_connections connection on connection.id=repo.connection_id and connection.workspace_id=run_row.workspace_id and connection.status='connected'
    ) then raise exception 'preflight_repository_access_revoked' using errcode='42501'; end if;
  if jsonb_typeof(p_result)<>'object' or jsonb_typeof(p_result->'findings')<>'array'
    or jsonb_array_length(p_result->'findings')>200
    or p_result->>'status' not in ('completed','partial')
    or p_result->>'verifiedImpact' not in ('verified','likely','not_found','inconclusive') then
    raise exception 'invalid_preflight_result' using errcode='22023';
  end if;
  for finding in select value from jsonb_array_elements(p_result->'findings') loop
    if not ((finding->>'repositoryId')::uuid=any(p_repository_ids)) then raise exception 'preflight_finding_repository_mismatch' using errcode='42501'; end if;
    insert into public.preflight_findings (workspace_id,preflight_run_id,repository_id,commit_sha,file_path,line_start,line_end,finding_type,affected_entity,confidence,verification,explanation,evidence_fingerprint)
    values (run_row.workspace_id,p_run_id,(finding->>'repositoryId')::uuid,finding->>'commitSha',finding->>'path',
      (finding->>'lineStart')::integer,(finding->>'lineEnd')::integer,finding->>'findingType',finding->>'affectedEntity',
      (finding->>'confidence')::numeric,finding->>'verification',finding->>'explanation',finding->>'evidenceFingerprint')
    on conflict (preflight_run_id,repository_id,commit_sha,file_path,evidence_fingerprint) do nothing;
  end loop;
  update public.preflight_runs set status=p_result->>'status',verified_impact=p_result->>'verifiedImpact',
    confidence=(p_result->>'confidence')::numeric,complexity=p_result->>'complexity',
    recommended_remediation=p_result->>'recommendedRemediation',effective_at=nullif(p_result->>'effectiveAt','')::timestamptz,
    announced_at=nullif(p_result->>'announcedAt','')::timestamptz,deadline=nullif(p_result->>'deadline','')::timestamptz,
    days_remaining=nullif(p_result->>'daysRemaining','')::integer,repositories_scanned=(p_result->>'repositoriesScanned')::integer,
    completed_at=now(),run_lease_until=null,run_claim_token=null,error_category=null
  where id=p_run_id;
end;
$$;

revoke all on function private.record_preflight_started() from public,anon,authenticated;
revoke all on function private.record_preflight_completed() from public,anon,authenticated;
revoke all on function public.save_preflight_result(uuid,uuid,uuid[],jsonb) from public,anon,authenticated;
revoke all on function private.enqueue_preflight_for_access() from public,anon,authenticated;
revoke all on function public.mark_preflight_dispatch(uuid,text,text) from public,anon,authenticated;
grant execute on function public.save_preflight_result(uuid,uuid,uuid[],jsonb) to service_role;
grant execute on function public.mark_preflight_dispatch(uuid,text,text) to service_role;
grant execute on function public.claim_preflight_run(uuid) to service_role;
