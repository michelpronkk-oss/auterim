-- Baseline Preflight verifies an explicitly protected repository without
-- fabricating a provider change, impact assessment, or exposure finding.
alter table public.preflight_runs
  add column preflight_mode text not null default 'change'
    check (preflight_mode in ('change','baseline')),
  add column protected_product_id uuid;

alter table public.preflight_runs
  alter column impact_assessment_id drop not null,
  add constraint preflight_run_product_workspace_fkey
    foreign key (protected_product_id,workspace_id)
    references public.workspace_products(id,workspace_id) on delete cascade,
  add constraint preflight_run_mode_identity_check check (
    (preflight_mode='change' and impact_assessment_id is not null and protected_product_id is null)
    or (preflight_mode='baseline' and impact_assessment_id is null and protected_product_id is not null)
  );

alter table public.preflight_runs drop constraint preflight_run_result_state_check;
alter table public.preflight_runs add constraint preflight_run_result_state_check check (
  (status in ('queued','running','failed','canceled') and verified_impact is null and completed_at is null)
  or (status in ('completed','partial') and completed_at is not null and (
    (preflight_mode='change' and verified_impact is not null)
    or (preflight_mode='baseline' and verified_impact is null)
  ))
);

create unique index preflight_run_baseline_identity_key
  on public.preflight_runs(workspace_id,protected_product_id,repository_set_fingerprint,preflight_version)
  where preflight_mode='baseline';
create index preflight_runs_product_mode_recent_idx
  on public.preflight_runs(workspace_id,protected_product_id,preflight_mode,created_at desc)
  where protected_product_id is not null;

create table public.baseline_preflight_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  protected_product_id uuid not null,
  preflight_run_id uuid not null,
  repository_id uuid not null,
  provider text not null default 'github' check (provider='github'),
  external_repository_id bigint not null check (external_repository_id > 0),
  repository_owner text not null check (char_length(repository_owner) between 1 and 100),
  repository_name text not null check (char_length(repository_name) between 1 and 100),
  default_branch text not null check (char_length(default_branch) between 1 and 255),
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{40,64}$'),
  verification_state text not null default 'verified' check (verification_state='verified'),
  observed_at timestamptz not null default now(),
  foreign key (protected_product_id,workspace_id)
    references public.workspace_products(id,workspace_id) on delete cascade,
  foreign key (preflight_run_id,workspace_id)
    references public.preflight_runs(id,workspace_id) on delete cascade,
  foreign key (repository_id,workspace_id)
    references public.repositories(id,workspace_id) on delete cascade,
  constraint baseline_preflight_evidence_run_repository_key unique (preflight_run_id,repository_id),
  constraint baseline_preflight_evidence_identity unique (id,workspace_id)
);

create index baseline_preflight_evidence_product_repo_current_idx
  on public.baseline_preflight_evidence(workspace_id,protected_product_id,repository_id,observed_at desc,id desc);
alter table public.baseline_preflight_evidence enable row level security;
revoke all on public.baseline_preflight_evidence from public,anon,authenticated;
grant select on public.baseline_preflight_evidence to authenticated,service_role;
grant all on public.baseline_preflight_evidence to service_role;
create policy baseline_preflight_evidence_member_read
  on public.baseline_preflight_evidence for select to authenticated
  using (exists (
    select 1 from public.workspace_members member
    where member.workspace_id=baseline_preflight_evidence.workspace_id
      and member.user_id=(select auth.uid())
  ));

alter table public.product_deployment_evidence
  add column baseline_preflight_evidence_id uuid;
alter table public.product_deployment_evidence
  add constraint product_deployment_evidence_baseline_preflight_fkey
    foreign key (baseline_preflight_evidence_id,workspace_id)
    references public.baseline_preflight_evidence(id,workspace_id) on delete cascade,
  add constraint product_deployment_evidence_preflight_source_check check (
    preflight_finding_id is null or baseline_preflight_evidence_id is null
  );

create function public.persist_baseline_preflight(
  p_actor_id uuid,
  p_workspace_id uuid,
  p_product_id uuid,
  p_repository_id uuid,
  p_external_repository_id bigint,
  p_repository_owner text,
  p_repository_name text,
  p_default_branch text,
  p_commit_sha text,
  p_repository_set_fingerprint text,
  p_preflight_version text
)
returns table(preflight_run_id uuid,baseline_evidence_id uuid,created boolean,observed_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_run_id uuid;
  v_evidence_id uuid;
  v_created boolean := false;
  v_observed_at timestamptz;
  v_existing record;
begin
  if p_actor_id is null or p_workspace_id is null or p_product_id is null or p_repository_id is null
    or p_external_repository_id is null or p_external_repository_id<=0
    or p_repository_owner is null or char_length(p_repository_owner) not between 1 and 100
    or p_repository_name is null or char_length(p_repository_name) not between 1 and 100
    or p_default_branch is null or char_length(p_default_branch) not between 1 and 255
    or p_commit_sha !~ '^[a-f0-9]{40,64}$'
    or p_repository_set_fingerprint !~ '^[a-f0-9]{64}$'
    or p_preflight_version is null or char_length(p_preflight_version) not between 1 and 80 then
    raise exception 'invalid_baseline_preflight_input' using errcode='22023';
  end if;

  if not exists (
    select 1 from public.workspace_members member
    where member.workspace_id=p_workspace_id and member.user_id=p_actor_id
      and member.role in ('owner','admin')
  ) then raise exception 'forbidden' using errcode='42501'; end if;

  perform 1 from public.workspaces where id=p_workspace_id for update;
  if not exists (
    select 1
    from public.workspace_products product
    join public.workspace_product_repositories mapping
      on mapping.protected_product_id=product.id and mapping.workspace_id=product.workspace_id
        and mapping.repository_id=p_repository_id and mapping.status='active'
    join public.repositories repository
      on repository.id=mapping.repository_id and repository.workspace_id=mapping.workspace_id
    join public.repository_connections connection
      on connection.id=repository.connection_id and connection.workspace_id=repository.workspace_id
    where product.id=p_product_id and product.workspace_id=p_workspace_id and product.status='protected'
      and repository.id=p_repository_id and repository.external_id=p_external_repository_id
      and lower(repository.owner)=lower(p_repository_owner) and lower(repository.name)=lower(p_repository_name)
      and repository.default_branch=p_default_branch and repository.status='available'
      and repository.selected_for_protection and connection.status='connected'
      and private.m15_product_repository_is_current(p_workspace_id,p_product_id,p_repository_id)
  ) then raise exception 'baseline_preflight_ineligible' using errcode='42501'; end if;

  insert into public.preflight_runs(
    workspace_id,impact_assessment_id,protected_product_id,preflight_mode,status,
    verified_impact,preflight_version,repository_set_fingerprint,change_fingerprint,
    repositories_scanned,started_at,completed_at
  ) values (
    p_workspace_id,null,p_product_id,'baseline','completed',null,
    p_preflight_version,p_repository_set_fingerprint,p_repository_set_fingerprint,
    1,now(),now()
  )
  on conflict (workspace_id,protected_product_id,repository_set_fingerprint,preflight_version)
    where preflight_mode='baseline'
  do nothing
  returning id,created_at into v_run_id,v_observed_at;
  v_created := found;

  if not v_created then
    select run.id,run.created_at into v_existing
    from public.preflight_runs run
    where run.workspace_id=p_workspace_id and run.protected_product_id=p_product_id
      and run.repository_set_fingerprint=p_repository_set_fingerprint
      and run.preflight_version=p_preflight_version and run.preflight_mode='baseline'
      and run.status='completed'
    for update;
    if not found then raise exception 'baseline_preflight_reconciliation_required' using errcode='40001'; end if;
    v_run_id := v_existing.id;
    v_observed_at := v_existing.created_at;
  end if;

  insert into public.baseline_preflight_evidence(
    workspace_id,protected_product_id,preflight_run_id,repository_id,external_repository_id,
    repository_owner,repository_name,default_branch,commit_sha,observed_at
  ) values (
    p_workspace_id,p_product_id,v_run_id,p_repository_id,p_external_repository_id,
    p_repository_owner,p_repository_name,p_default_branch,p_commit_sha,v_observed_at
  ) on conflict on constraint baseline_preflight_evidence_run_repository_key do nothing
  returning id into v_evidence_id;
  if v_evidence_id is null then
    select evidence.id into v_evidence_id from public.baseline_preflight_evidence evidence
    where evidence.preflight_run_id=v_run_id and evidence.repository_id=p_repository_id
      and evidence.workspace_id=p_workspace_id and evidence.commit_sha=p_commit_sha
      and evidence.verification_state='verified';
    if v_evidence_id is null then raise exception 'baseline_preflight_replay_mismatch' using errcode='40001'; end if;
  end if;

  return query select v_run_id,v_evidence_id,v_created,v_observed_at;
end;
$$;
revoke all on function public.persist_baseline_preflight(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.persist_baseline_preflight(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text) to service_role;
