-- Persisted M15 policy and bounded patch-validation lifecycle.

alter table public.preflight_dispatch_queue
  add column trigger_run_id text check (trigger_run_id is null or char_length(trigger_run_id) <= 255);

drop function public.list_preflight_dispatch_queue(integer);
create function public.list_preflight_dispatch_queue(p_limit integer default 100)
returns table(queue_id uuid,workspace_id uuid,impact_assessment_id uuid,attempt_count integer)
language sql security invoker set search_path = '' as $$
  select queue.id,queue.workspace_id,queue.impact_assessment_id,queue.attempt_count
  from public.preflight_dispatch_queue queue
  where queue.attempt_count<6 and (queue.status in ('queued','failed')
    or (queue.status='dispatched' and queue.updated_at<now()-interval '15 minutes'))
  order by queue.created_at,queue.id limit least(greatest(coalesce(p_limit,1),1),100);
$$;

create function public.finish_preflight_dispatch(p_queue_id uuid,p_attempt integer,p_status text,p_error_category text default null)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_status not in ('complete','failed','superseded') then
    raise exception 'invalid_preflight_queue_status' using errcode='22023';
  end if;
  update public.preflight_dispatch_queue
  set status=p_status,
      error_category=case when p_status='failed' then left(coalesce(p_error_category,'preflight_failed'),80) else null end
  where id=p_queue_id and attempt_count=p_attempt and status='dispatched';
  return found;
end;
$$;

create function public.mark_preflight_dispatch_run(p_queue_id uuid,p_attempt integer,p_trigger_run_id text)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.preflight_dispatch_queue
  set trigger_run_id=left(p_trigger_run_id,255)
  where id=p_queue_id and attempt_count=p_attempt
    and (trigger_run_id is null or trigger_run_id=left(p_trigger_run_id,255));
  return found;
end;
$$;

alter table public.protection_value_events
  drop constraint protection_value_events_event_kind_check,
  add constraint protection_value_events_event_kind_check
    check (event_kind in ('automatic_preflight_started','preflight_completed','verified_risk_found',
      'verified_risk_not_found','remediation_generated','draft_pr_prepared',
      'remediation_validated','remediation_validation_failed','risk_resolved'));

create table public.customer_risk_resolutions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  impact_assessment_id uuid not null,
  resolution_kind text not null check (resolution_kind in ('reviewed','mitigated_externally','accepted_risk','no_longer_applicable')),
  resolved_by uuid not null references auth.users (id) on delete restrict,
  resolved_at timestamptz not null default now(),
  unique (impact_assessment_id),
  unique (id,workspace_id),
  foreign key (impact_assessment_id,workspace_id)
    references public.impact_assessments (id,workspace_id) on delete restrict
);
create index customer_risk_resolutions_workspace_idx
  on public.customer_risk_resolutions (workspace_id,resolved_at desc);

create function private.reject_customer_risk_resolution_mutation()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'customer_risk_resolution_is_immutable' using errcode='42501';
end;
$$;
create trigger customer_risk_resolutions_immutable
  before update or delete on public.customer_risk_resolutions
  for each row execute function private.reject_customer_risk_resolution_mutation();
revoke all on function private.reject_customer_risk_resolution_mutation() from public,anon,authenticated;
alter table public.customer_risk_resolutions enable row level security;
create policy customer_risk_resolutions_select_member on public.customer_risk_resolutions for select to authenticated
  using (exists(select 1 from public.workspace_members member where member.workspace_id=customer_risk_resolutions.workspace_id and member.user_id=(select auth.uid())));
revoke all on public.customer_risk_resolutions from public,anon,authenticated;
grant select on public.customer_risk_resolutions to authenticated;
grant all on public.customer_risk_resolutions to service_role;

create function public.resolve_customer_risk(p_workspace_id uuid,p_impact_assessment_id uuid,p_resolution_kind text)
returns public.customer_risk_resolutions
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_result public.customer_risk_resolutions%rowtype;
  v_existing public.customer_risk_resolutions%rowtype;
  v_event_key text;
  v_dependency_id uuid;
  v_product_id uuid;
begin
  if v_actor is null or p_workspace_id is null or p_impact_assessment_id is null
    or p_resolution_kind is null
    or p_resolution_kind not in ('reviewed','mitigated_externally','accepted_risk','no_longer_applicable') then
    raise exception 'invalid_risk_resolution' using errcode='22023';
  end if;
  if not exists(select 1 from public.workspace_members member
    where member.workspace_id=p_workspace_id and member.user_id=v_actor) then
    raise exception 'workspace_access_required' using errcode='42501';
  end if;
  select dependency.id,dependency.protected_product_id into v_dependency_id,v_product_id
  from public.impact_assessments assessment
  join public.workspace_dependencies dependency
    on dependency.id=assessment.workspace_dependency_id and dependency.workspace_id=assessment.workspace_id
  where assessment.id=p_impact_assessment_id and assessment.workspace_id=p_workspace_id;
  if v_dependency_id is null or v_product_id is null then
    raise exception 'active_customer_risk_required' using errcode='P0002';
  end if;
  perform 1 from public.workspaces where id=p_workspace_id for update;
  perform 1 from public.workspace_products product
    where product.id=v_product_id and product.workspace_id=p_workspace_id and product.status='protected' for update;
  if not found then raise exception 'active_customer_risk_required' using errcode='P0002'; end if;
  perform 1 from public.workspace_dependencies dependency
    where dependency.id=v_dependency_id and dependency.workspace_id=p_workspace_id
      and dependency.monitoring_enabled=true for update;
  if not found then raise exception 'active_customer_risk_required' using errcode='P0002'; end if;
  perform 1 from public.impact_assessments assessment
    join public.source_change_classifications classification
      on classification.id=assessment.source_change_classification_id
    join public.source_changes change on change.id=classification.change_id
    where assessment.id=p_impact_assessment_id and assessment.workspace_id=p_workspace_id
      and assessment.workspace_dependency_id=v_dependency_id
      and assessment.status='assessed' and assessment.relevant=true
      and classification.status='classified' and classification.material=true
      and not exists(select 1 from public.source_change_classifications newer
        where newer.change_id=classification.change_id and newer.status='classified'
          and (newer.created_at>classification.created_at
            or (newer.created_at=classification.created_at and newer.id>classification.id)))
    for update of assessment;
  if not found then raise exception 'active_customer_risk_required' using errcode='P0002'; end if;
  insert into public.customer_risk_resolutions (workspace_id,impact_assessment_id,resolution_kind,resolved_by)
    values(p_workspace_id,p_impact_assessment_id,p_resolution_kind,v_actor)
    on conflict (impact_assessment_id) do nothing returning * into v_result;
  if not found then
    select * into v_existing from public.customer_risk_resolutions
      where impact_assessment_id=p_impact_assessment_id and workspace_id=p_workspace_id;
    if not found or v_existing.resolution_kind<>p_resolution_kind then
      raise exception 'risk_already_resolved' using errcode='40001';
    end if;
    return v_existing;
  end if;
  v_event_key := md5(p_impact_assessment_id::text || ':' || p_resolution_kind) ||
    md5('risk-resolved:' || p_impact_assessment_id::text || ':' || p_resolution_kind);
  insert into public.protection_value_events
    (workspace_id,event_kind,impact_assessment_id,dedupe_key,metadata)
  values(p_workspace_id,'risk_resolved',p_impact_assessment_id,v_event_key,
    jsonb_build_object('resolutionKind',p_resolution_kind))
  on conflict (workspace_id,event_kind,dedupe_key) do nothing;
  return v_result;
end;
$$;

alter table public.remediation_proposals
  add column product_id uuid,
  add column workspace_dependency_id uuid,
  add column source_change_id uuid,
  add column source_change_classification_id uuid,
  add column patch_fingerprint text,
  add column generation_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(generation_metadata) = 'object' and octet_length(generation_metadata::text) <= 4000),
  add column patch_validation_status text not null default 'not_requested'
    check (patch_validation_status in ('not_requested','queued','validating','validated','validation_failed'));

update public.remediation_proposals proposal
set workspace_dependency_id = assessment.workspace_dependency_id,
    product_id = dependency.protected_product_id,
    source_change_classification_id = assessment.source_change_classification_id,
    source_change_id = classification.change_id
from public.preflight_runs run
join public.impact_assessments assessment
  on assessment.id = run.impact_assessment_id and assessment.workspace_id = run.workspace_id
join public.workspace_dependencies dependency
  on dependency.id = assessment.workspace_dependency_id and dependency.workspace_id = assessment.workspace_id
join public.source_change_classifications classification
  on classification.id = assessment.source_change_classification_id
where proposal.preflight_run_id = run.id and proposal.workspace_id = run.workspace_id;

alter table public.remediation_proposals
  add constraint remediation_proposals_product_workspace_fkey
    foreign key (product_id,workspace_id) references public.workspace_products (id,workspace_id) on delete cascade,
  add constraint remediation_proposals_dependency_product_fkey
    foreign key (workspace_dependency_id,workspace_id,product_id)
    references public.workspace_dependencies (id,workspace_id,protected_product_id) on delete cascade,
  add constraint remediation_proposals_source_change_fkey
    foreign key (source_change_id) references public.source_changes (id) on delete restrict,
  add constraint remediation_proposals_classification_fkey
    foreign key (source_change_classification_id) references public.source_change_classifications (id) on delete restrict,
  add constraint remediation_proposals_patch_fingerprint_check
    check (patch_fingerprint is null or patch_fingerprint ~ '^[a-f0-9]{64}$');

alter table public.source_change_classifications
  add constraint source_change_classifications_id_change_key unique (id,change_id);

create table public.source_remediation_replacements (
  id uuid primary key default gen_random_uuid(),
  source_change_id uuid not null references public.source_changes (id) on delete restrict,
  source_change_classification_id uuid not null references public.source_change_classifications (id) on delete restrict,
  old_expression text not null check (octet_length(old_expression) between 1 and 240 and position(chr(10) in old_expression) = 0 and position(chr(13) in old_expression) = 0),
  new_expression text not null check (octet_length(new_expression) between 1 and 240 and position(chr(10) in new_expression) = 0 and position(chr(13) in new_expression) = 0),
  evidence_source_url text not null check (evidence_source_url ~ '^https://'),
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[a-f0-9]{64}$'),
  synthetic boolean not null default false,
  internal_qa boolean not null default false,
  public_eligible boolean not null default false,
  created_at timestamptz not null default now(),
  constraint source_remediation_replacements_change_evidence_key unique (source_change_id,evidence_fingerprint),
  constraint source_remediation_replacements_classification_change_fkey
    foreign key (source_change_classification_id,source_change_id)
    references public.source_change_classifications (id,change_id) on delete restrict,
  constraint source_remediation_replacements_privacy_check
    check (not synthetic or (internal_qa and not public_eligible)),
  constraint source_remediation_replacements_qa_privacy_check
    check (not internal_qa or not public_eligible),
  constraint source_remediation_replacements_distinct_check check (old_expression <> new_expression)
);

create table public.product_remediation_policies (
  workspace_id uuid not null,
  product_id uuid not null,
  policy_version integer not null default 1 check (policy_version > 0),
  enabled boolean not null default false,
  human_review_required boolean not null default true check (human_review_required),
  draft_pr_preparation_allowed boolean not null default false,
  automatic_workflow_handoff_allowed boolean not null default false,
  approval_required boolean not null default true,
  allowed_repository_ids uuid[] not null default '{}'::uuid[]
    check (cardinality(allowed_repository_ids) <= 100),
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id),
  constraint product_remediation_policies_product_workspace_fkey
    foreign key (product_id,workspace_id) references public.workspace_products (id,workspace_id) on delete cascade,
  constraint product_remediation_policies_handoff_approval_check
    check (not automatic_workflow_handoff_allowed or approval_required)
);

create index product_remediation_policies_workspace_idx
  on public.product_remediation_policies (workspace_id,product_id);

create table public.remediation_validation_queue (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  remediation_proposal_id uuid not null,
  patch_fingerprint text not null check (patch_fingerprint ~ '^[a-f0-9]{64}$'),
  status text not null default 'queued'
    check (status in ('queued','dispatched','running','validated','validation_failed','denied','canceled')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  trigger_run_id text check (trigger_run_id is null or char_length(trigger_run_id) <= 255),
  claim_token uuid,
  lease_until timestamptz,
  error_category text check (error_category is null or char_length(error_category) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (remediation_proposal_id,patch_fingerprint),
  unique (id,workspace_id),
  foreign key (remediation_proposal_id,workspace_id)
    references public.remediation_proposals (id,workspace_id) on delete cascade,
  constraint remediation_validation_queue_lease_check
    check ((status = 'running' and claim_token is not null and lease_until is not null)
      or (status <> 'running' and claim_token is null and lease_until is null))
);

create index remediation_validation_dispatch_idx
  on public.remediation_validation_queue (created_at,id)
  where status in ('queued','validation_failed');
create index remediation_validation_workspace_idx
  on public.remediation_validation_queue (workspace_id,created_at desc);

create table public.remediation_validation_attempts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  queue_id uuid not null,
  attempt_number integer not null check (attempt_number between 1 and 5),
  patch_fingerprint text not null check (patch_fingerprint ~ '^[a-f0-9]{64}$'),
  outcome text not null check (outcome in ('validated','validation_failed','denied')),
  error_category text check (error_category is null or char_length(error_category) <= 80),
  commands jsonb not null default '[]'::jsonb
    check (jsonb_typeof(commands) = 'array' and jsonb_array_length(commands) <= 10 and octet_length(commands::text) <= 2000),
  diagnostics text not null default '' check (octet_length(diagnostics) <= 4000),
  duration_ms integer not null check (duration_ms between 0 and 120000),
  completed_at timestamptz not null default now(),
  unique (queue_id,attempt_number),
  foreign key (queue_id,workspace_id) references public.remediation_validation_queue (id,workspace_id) on delete cascade
);

create index remediation_validation_attempts_workspace_idx
  on public.remediation_validation_attempts (workspace_id,completed_at desc);

create table public.remediation_preparation_queue (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  preflight_run_id uuid not null,
  impact_assessment_id uuid not null,
  status text not null default 'queued'
    check (status in ('queued','dispatched','running','completed','denied','failed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  trigger_run_id text check (trigger_run_id is null or char_length(trigger_run_id) <= 255),
  claim_token uuid,
  lease_until timestamptz,
  remediation_proposal_id uuid,
  error_category text check (error_category is null or char_length(error_category) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (preflight_run_id),
  foreign key (preflight_run_id,workspace_id)
    references public.preflight_runs (id,workspace_id) on delete cascade,
  foreign key (impact_assessment_id,workspace_id)
    references public.impact_assessments (id,workspace_id) on delete cascade,
  foreign key (remediation_proposal_id,workspace_id)
    references public.remediation_proposals (id,workspace_id) on delete cascade,
  constraint remediation_preparation_queue_lease_check
    check ((status = 'running' and claim_token is not null and lease_until is not null)
      or (status <> 'running' and claim_token is null and lease_until is null))
);

create index remediation_preparation_dispatch_idx
  on public.remediation_preparation_queue (created_at,id)
  where status in ('queued','failed') or (status in ('dispatched','running'));
create index remediation_preparation_workspace_idx
  on public.remediation_preparation_queue (workspace_id,created_at desc);

create trigger product_remediation_policies_set_updated_at before update on public.product_remediation_policies
  for each row execute function private.set_updated_at();
create trigger remediation_validation_queue_set_updated_at before update on public.remediation_validation_queue
  for each row execute function private.set_updated_at();
create trigger remediation_preparation_queue_set_updated_at before update on public.remediation_preparation_queue
  for each row execute function private.set_updated_at();

create function private.enqueue_remediation_patch_validation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare inserted_count integer;
begin
  if new.proposal_kind <> 'patch' or new.patch is null or new.patch_fingerprint is null then
    return new;
  end if;
  insert into public.remediation_validation_queue
    (workspace_id,remediation_proposal_id,patch_fingerprint)
  values (new.workspace_id,new.id,new.patch_fingerprint)
  on conflict (remediation_proposal_id,patch_fingerprint) do nothing;
  get diagnostics inserted_count = row_count;
  -- A duplicate patch write must not rewind a completed validation lifecycle.
  if inserted_count > 0 then
    update public.remediation_proposals set patch_validation_status = 'queued'
    where id = new.id and workspace_id = new.workspace_id;
  end if;
  return new;
end;
$$;

create trigger remediation_proposal_enqueue_validation
  after insert or update of proposal_kind,patch,patch_fingerprint on public.remediation_proposals
  for each row execute function private.enqueue_remediation_patch_validation();

create function private.enqueue_eligible_remediation_preparation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status <> 'completed' or new.verified_impact <> 'verified'
    or (tg_op = 'UPDATE' and old.status = 'completed' and old.verified_impact = 'verified') then
    return new;
  end if;
  if not exists (
    select 1
    from public.impact_assessments assessment
    join public.workspace_dependencies dependency
      on dependency.id=assessment.workspace_dependency_id and dependency.workspace_id=assessment.workspace_id
    join public.workspace_products product
      on product.id=dependency.protected_product_id and product.workspace_id=dependency.workspace_id
    join public.source_change_classifications classification
      on classification.id=assessment.source_change_classification_id
    join public.source_remediation_replacements replacement
      on replacement.source_change_id=classification.change_id
      and replacement.source_change_classification_id=classification.id
      and ((replacement.synthetic=false and replacement.internal_qa=false and replacement.public_eligible=true)
        or (replacement.synthetic=true and replacement.internal_qa=true and replacement.public_eligible=false))
    where assessment.id=new.impact_assessment_id and assessment.workspace_id=new.workspace_id
      and assessment.status='assessed' and assessment.relevant=true
      and dependency.monitoring_enabled=true and product.status='protected'
      and classification.status='classified' and classification.material=true
      and exists (
        select 1 from public.preflight_findings finding
        where finding.preflight_run_id=new.id and finding.workspace_id=new.workspace_id
          and finding.verification='verified'
      )
      and private.workspace_quota_plan(new.workspace_id) in ('pro','business')
  ) then return new; end if;
  insert into public.remediation_preparation_queue
    (workspace_id,preflight_run_id,impact_assessment_id)
  values (new.workspace_id,new.id,new.impact_assessment_id)
  on conflict (preflight_run_id) do nothing;
  return new;
end;
$$;

create trigger preflight_enqueue_remediation_preparation
  after insert or update of status,verified_impact on public.preflight_runs
  for each row execute function private.enqueue_eligible_remediation_preparation();

create function public.list_remediation_preparation_queue(p_limit integer default 40)
returns table (queue_id uuid,workspace_id uuid,preflight_run_id uuid,impact_assessment_id uuid,attempt_count integer)
language plpgsql security invoker set search_path = '' as $$
begin
  return query
  select queue.id,queue.workspace_id,queue.preflight_run_id,queue.impact_assessment_id,queue.attempt_count
  from public.remediation_preparation_queue queue
  where queue.attempt_count < 5 and (
    queue.status in ('queued','failed')
    or (queue.status='dispatched' and queue.updated_at < now() - interval '15 minutes')
    or (queue.status='running' and queue.lease_until < now())
  )
  order by queue.created_at,queue.id
  limit greatest(1,least(coalesce(p_limit,40),100));
end;
$$;

create function public.claim_remediation_preparation_dispatch(p_queue_id uuid)
returns integer language plpgsql security invoker set search_path = '' as $$
declare v_attempt integer;
begin
  update public.remediation_preparation_queue queue
  set status='dispatched',attempt_count=attempt_count+1,claim_token=null,lease_until=null,
      error_category=null,trigger_run_id=null
  where queue.id=p_queue_id and queue.attempt_count<5 and (
    queue.status in ('queued','failed')
    or (queue.status='dispatched' and queue.updated_at<now()-interval '15 minutes')
    or (queue.status='running' and queue.lease_until<now())
  ) returning queue.attempt_count into v_attempt;
  if not found then return null; end if;
  return v_attempt;
end;
$$;

create function public.mark_remediation_preparation_dispatched(p_queue_id uuid,p_attempt integer,p_trigger_run_id text)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.remediation_preparation_queue
  set trigger_run_id=left(p_trigger_run_id,255)
  where id=p_queue_id and attempt_count=p_attempt
    and (trigger_run_id is null or trigger_run_id=left(p_trigger_run_id,255));
  return found;
end;
$$;

create function public.claim_remediation_preparation(p_queue_id uuid,p_attempt integer)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_queue public.remediation_preparation_queue%rowtype;
  v_product_id uuid;
  v_token uuid := gen_random_uuid();
begin
  select * into v_queue from public.remediation_preparation_queue where id=p_queue_id;
  if not found or v_queue.attempt_count<>p_attempt then return null; end if;
  -- Canonical money-path lock order: workspace → product → dependency/change → Preflight → remediation → validation.
  perform 1 from public.workspaces where id=v_queue.workspace_id for update;
  select dependency.protected_product_id into v_product_id
  from public.impact_assessments assessment
  join public.workspace_dependencies dependency
    on dependency.id=assessment.workspace_dependency_id and dependency.workspace_id=assessment.workspace_id
  where assessment.id=v_queue.impact_assessment_id and assessment.workspace_id=v_queue.workspace_id;
  perform 1 from public.workspace_products
    where id=v_product_id and workspace_id=v_queue.workspace_id for update;
  perform 1 from public.workspace_dependencies dependency
  join public.impact_assessments assessment
    on assessment.workspace_dependency_id=dependency.id and assessment.workspace_id=dependency.workspace_id
  where assessment.id=v_queue.impact_assessment_id and assessment.workspace_id=v_queue.workspace_id
    and dependency.protected_product_id=v_product_id for update of dependency;
  perform 1 from public.preflight_runs
    where id=v_queue.preflight_run_id and workspace_id=v_queue.workspace_id for update;
  select * into v_queue from public.remediation_preparation_queue
    where id=p_queue_id and workspace_id=v_queue.workspace_id for update;
  if not found or v_queue.attempt_count<>p_attempt or v_queue.status<>'dispatched' then return null; end if;
  if not exists (
    select 1
    from public.preflight_runs run
    join public.impact_assessments assessment
      on assessment.id=run.impact_assessment_id and assessment.workspace_id=run.workspace_id
    join public.workspace_dependencies dependency
      on dependency.id=assessment.workspace_dependency_id and dependency.workspace_id=assessment.workspace_id
    join public.workspace_products product
      on product.id=dependency.protected_product_id and product.workspace_id=dependency.workspace_id
    join public.source_change_classifications classification
      on classification.id=assessment.source_change_classification_id
    join public.source_remediation_replacements replacement
      on replacement.source_change_id=classification.change_id
      and replacement.source_change_classification_id=classification.id
      and ((replacement.synthetic=false and replacement.internal_qa=false and replacement.public_eligible=true)
        or (replacement.synthetic=true and replacement.internal_qa=true and replacement.public_eligible=false))
    where run.id=v_queue.preflight_run_id and run.workspace_id=v_queue.workspace_id
      and run.status='completed' and run.verified_impact='verified'
      and assessment.id=v_queue.impact_assessment_id and assessment.status='assessed' and assessment.relevant
      and dependency.monitoring_enabled and product.status='protected'
      and classification.status='classified' and classification.material
      and private.workspace_quota_plan(v_queue.workspace_id) in ('pro','business')
      and exists (select 1 from public.preflight_findings finding
        where finding.preflight_run_id=run.id and finding.workspace_id=run.workspace_id and finding.verification='verified')
  ) then
    update public.remediation_preparation_queue set status='denied',error_category='execution_ineligible'
    where id=p_queue_id;
    return null;
  end if;
  update public.remediation_preparation_queue
  set status='running',claim_token=v_token,lease_until=now()+interval '15 minutes'
  where id=p_queue_id;
  return v_token;
end;
$$;

create function public.complete_remediation_preparation(
  p_queue_id uuid,p_claim_token uuid,p_outcome text,p_proposal_id uuid default null,p_error_category text default null
)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_outcome not in ('completed','denied','failed') then raise exception 'invalid_preparation_outcome' using errcode='22023'; end if;
  update public.remediation_preparation_queue queue
  set status=p_outcome,claim_token=null,lease_until=null,
      remediation_proposal_id=p_proposal_id,error_category=case when p_outcome='completed' then null else left(coalesce(p_error_category,p_outcome),80) end
  where queue.id=p_queue_id and queue.status='running' and queue.claim_token=p_claim_token
    and queue.lease_until>now() and (p_proposal_id is null or exists (
      select 1 from public.remediation_proposals proposal
      where proposal.id=p_proposal_id and proposal.workspace_id=queue.workspace_id
        and proposal.preflight_run_id=queue.preflight_run_id
    ));
  return found;
end;
$$;

create function public.set_product_remediation_policy(
  p_workspace_id uuid,
  p_product_id uuid,
  p_enabled boolean,
  p_draft_pr_preparation_allowed boolean,
  p_automatic_workflow_handoff_allowed boolean,
  p_approval_required boolean,
  p_allowed_repository_ids uuid[]
)
returns public.product_remediation_policies
language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
  v_policy public.product_remediation_policies%rowtype;
begin
  if v_user_id is null or not exists (
    select 1 from public.workspace_members member
    where member.workspace_id = p_workspace_id and member.user_id = v_user_id and member.role in ('owner','admin')
  ) then
    raise exception 'owner_or_admin_required' using errcode = '42501';
  end if;
  if p_enabled is null or p_draft_pr_preparation_allowed is null
    or p_automatic_workflow_handoff_allowed is null or p_approval_required is null
    or p_allowed_repository_ids is null or cardinality(p_allowed_repository_ids) > 100
    or cardinality(p_allowed_repository_ids) <> (select count(distinct id) from unnest(p_allowed_repository_ids) id)
    or cardinality(p_allowed_repository_ids) <> (
      select count(*) from unnest(p_allowed_repository_ids) expected(id)
      join public.repositories repository on repository.id = expected.id and repository.workspace_id = p_workspace_id
    ) then
    raise exception 'invalid_remediation_policy' using errcode = '22023';
  end if;
  perform 1 from public.workspace_products product
    where product.id = p_product_id and product.workspace_id = p_workspace_id and product.status <> 'archived'
    for update;
  if not found then raise exception 'product_not_found' using errcode = 'P0002'; end if;
  insert into public.product_remediation_policies (
    workspace_id,product_id,enabled,human_review_required,draft_pr_preparation_allowed,
    automatic_workflow_handoff_allowed,approval_required,allowed_repository_ids,updated_by
  ) values (
    p_workspace_id,p_product_id,p_enabled,true,p_draft_pr_preparation_allowed,
    p_automatic_workflow_handoff_allowed,p_approval_required,p_allowed_repository_ids,v_user_id
  ) on conflict (product_id) do update set
    policy_version = public.product_remediation_policies.policy_version + 1,
    enabled = excluded.enabled,
    human_review_required = true,
    draft_pr_preparation_allowed = excluded.draft_pr_preparation_allowed,
    automatic_workflow_handoff_allowed = excluded.automatic_workflow_handoff_allowed,
    approval_required = excluded.approval_required,
    allowed_repository_ids = excluded.allowed_repository_ids,
    updated_by = v_user_id
  returning * into v_policy;
  return v_policy;
end;
$$;

create function public.list_remediation_validation_queue(p_limit integer default 40)
returns table (queue_id uuid,workspace_id uuid,remediation_proposal_id uuid,patch_fingerprint text,attempt_count integer)
language plpgsql security invoker set search_path = '' as $$
begin
  return query
  select queue.id,queue.workspace_id,queue.remediation_proposal_id,queue.patch_fingerprint,queue.attempt_count
  from public.remediation_validation_queue queue
  where queue.attempt_count < 5 and (
    queue.status in ('queued','validation_failed')
    or (queue.status = 'dispatched' and queue.updated_at < now() - interval '15 minutes')
    or (queue.status = 'running' and queue.lease_until < now())
  )
  order by queue.created_at,queue.id
  limit greatest(1,least(coalesce(p_limit,40),100));
end;
$$;

create function public.claim_remediation_validation_dispatch(p_queue_id uuid)
returns integer language plpgsql security invoker set search_path = '' as $$
declare v_attempt integer;
begin
  update public.remediation_validation_queue queue
  set status = 'dispatched',attempt_count = attempt_count + 1,error_category = null,trigger_run_id = null
  where queue.id = p_queue_id and queue.attempt_count < 5 and (
    queue.status in ('queued','validation_failed')
    or (queue.status = 'dispatched' and queue.updated_at < now() - interval '15 minutes')
    or (queue.status = 'running' and queue.lease_until < now())
  ) returning queue.attempt_count into v_attempt;
  if not found then return null; end if;
  return v_attempt;
end;
$$;

create function public.mark_remediation_validation_dispatched(p_queue_id uuid,p_attempt integer,p_trigger_run_id text)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.remediation_validation_queue
  set trigger_run_id = left(p_trigger_run_id,255)
  where id = p_queue_id and attempt_count = p_attempt
    and (trigger_run_id is null or trigger_run_id = left(p_trigger_run_id,255));
  return found;
end;
$$;

create function public.claim_remediation_validation(p_queue_id uuid,p_attempt integer)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_queue public.remediation_validation_queue%rowtype;
  v_proposal public.remediation_proposals%rowtype;
  v_product_id uuid;
  v_repository_id uuid;
  v_token uuid := gen_random_uuid();
begin
  select * into v_queue from public.remediation_validation_queue where id=p_queue_id;
  if not found or v_queue.attempt_count<>p_attempt then return null; end if;
  select * into v_proposal from public.remediation_proposals
    where id=v_queue.remediation_proposal_id and workspace_id=v_queue.workspace_id;
  if not found then return null; end if;
  v_product_id := v_proposal.product_id;
  begin
    v_repository_id := (v_proposal.generation_metadata->'repository'->>'id')::uuid;
  exception when others then
    v_repository_id := null;
  end;

  -- Canonical lock order: workspace → product → dependency/change → Preflight → remediation → validation.
  perform 1 from public.workspaces where id=v_queue.workspace_id for update;
  perform 1 from public.workspace_products
    where id=v_product_id and workspace_id=v_queue.workspace_id for update;
  perform 1 from public.workspace_dependencies
    where id=v_proposal.workspace_dependency_id and workspace_id=v_queue.workspace_id for update;
  perform 1 from public.preflight_runs
    where id=v_proposal.preflight_run_id and workspace_id=v_queue.workspace_id for update;
  select * into v_proposal from public.remediation_proposals
    where id=v_queue.remediation_proposal_id and workspace_id=v_queue.workspace_id for update;
  select * into v_queue from public.remediation_validation_queue
    where id=p_queue_id and workspace_id=v_queue.workspace_id for update;
  if not found or v_queue.attempt_count<>p_attempt then return null; end if;

  if not exists (
    select 1
    from public.workspace_products product
    join public.workspace_dependencies dependency
      on dependency.id=v_proposal.workspace_dependency_id and dependency.workspace_id=product.workspace_id
    join public.impact_assessments assessment
      on assessment.workspace_dependency_id=dependency.id and assessment.workspace_id=dependency.workspace_id
    join public.preflight_runs run
      on run.id=v_proposal.preflight_run_id and run.workspace_id=assessment.workspace_id
    join public.source_change_classifications classification
      on classification.id=v_proposal.source_change_classification_id
      and classification.change_id=v_proposal.source_change_id
    join public.product_remediation_policies policy
      on policy.product_id=product.id and policy.workspace_id=product.workspace_id
    where product.id=v_product_id and product.workspace_id=v_queue.workspace_id and product.status='protected'
      and dependency.protected_product_id=product.id and dependency.monitoring_enabled=true
      and assessment.id=run.impact_assessment_id and assessment.status='assessed' and assessment.relevant=true
      and assessment.source_change_classification_id=v_proposal.source_change_classification_id
      and run.status='completed' and run.verified_impact='verified'
      and classification.status='classified' and classification.material=true
      and classification.id=assessment.source_change_classification_id
      and classification.change_id=v_proposal.source_change_id
      and v_proposal.proposal_kind='patch' and v_proposal.patch is not null
      and v_proposal.patch_fingerprint=v_queue.patch_fingerprint
      and v_proposal.patch_validation_status in ('queued','validation_failed','validating')
      and policy.enabled=true and policy.draft_pr_preparation_allowed=true
      and policy.allowed_repository_ids @> array[v_repository_id]
      and private.workspace_quota_plan(v_queue.workspace_id) in ('pro','business')
      and exists (
        select 1 from public.preflight_findings finding
        where finding.preflight_run_id=run.id and finding.workspace_id=run.workspace_id
          and finding.repository_id=v_repository_id and finding.commit_sha=v_proposal.base_commit_sha
          and finding.verification='verified'
      )
      and exists (
        select 1 from public.workspace_repository_access access
        join public.repositories repository
          on repository.id=access.repository_id and repository.workspace_id=access.workspace_id
        join public.repository_connections connection
          on connection.id=repository.connection_id and connection.workspace_id=repository.workspace_id
        where access.workspace_id=v_queue.workspace_id
          and access.workspace_dependency_id=dependency.id and access.repository_id=v_repository_id
          and repository.status='available' and repository.selected_for_protection=true
          and connection.status='connected'
      )
      and exists (select 1 from public.source_remediation_replacements replacement
        where replacement.id=(v_proposal.generation_metadata->>'replacementEvidenceId')::uuid
          and replacement.source_change_id=v_proposal.source_change_id
          and replacement.source_change_classification_id=v_proposal.source_change_classification_id
          and ((replacement.synthetic=false and replacement.internal_qa=false and replacement.public_eligible=true)
            or (v_proposal.generation_metadata->>'internalQaOnly'='true'
              and replacement.synthetic=true and replacement.internal_qa=true and replacement.public_eligible=false)))
  ) then
    insert into public.remediation_validation_attempts (
      workspace_id,queue_id,attempt_number,patch_fingerprint,outcome,error_category,commands,diagnostics,duration_ms
    ) values (
      v_queue.workspace_id,v_queue.id,v_queue.attempt_count,v_queue.patch_fingerprint,'denied',
      'execution_ineligible','[]'::jsonb,'Execution-time eligibility check denied validation.',0
    ) on conflict (queue_id,attempt_number) do nothing;
    update public.remediation_validation_queue
    set status='denied',claim_token=null,lease_until=null,error_category='execution_ineligible'
    where id=p_queue_id;
    update public.remediation_proposals
    set patch_validation_status='validation_failed'
    where id=v_proposal.id and workspace_id=v_queue.workspace_id;
    return null;
  end if;

  update public.remediation_validation_queue
  set status='running',claim_token=v_token,lease_until=now()+interval '15 minutes'
  where id=p_queue_id and (status='dispatched'
    or (status='running' and lease_until<now()));
  if not found then return null; end if;
  update public.remediation_proposals set patch_validation_status='validating'
  where id=v_proposal.id and workspace_id=v_queue.workspace_id;
  return v_token;
end;
$$;

create function public.complete_remediation_validation(
  p_queue_id uuid,p_claim_token uuid,p_outcome text,p_error_category text,
  p_commands jsonb,p_diagnostics text,p_duration_ms integer
)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_queue public.remediation_validation_queue%rowtype;
  v_proposal public.remediation_proposals%rowtype;
begin
  -- Read identities without locking, then take locks in the same order as the claim path.
  select * into v_queue from public.remediation_validation_queue where id=p_queue_id;
  if not found then raise exception 'remediation_validation_claim_lost' using errcode = '40001'; end if;
  select * into v_proposal from public.remediation_proposals
    where id=v_queue.remediation_proposal_id and workspace_id=v_queue.workspace_id;
  if not found then raise exception 'remediation_validation_claim_lost' using errcode = '40001'; end if;

  perform 1 from public.workspaces where id=v_queue.workspace_id for update;
  perform 1 from public.workspace_products
    where id=v_proposal.product_id and workspace_id=v_queue.workspace_id for update;
  perform 1 from public.workspace_dependencies
    where id=v_proposal.workspace_dependency_id and workspace_id=v_queue.workspace_id for update;
  perform 1 from public.preflight_runs
    where id=v_proposal.preflight_run_id and workspace_id=v_queue.workspace_id for update;
  select * into v_proposal from public.remediation_proposals
    where id=v_queue.remediation_proposal_id and workspace_id=v_queue.workspace_id for update;
  select * into v_queue from public.remediation_validation_queue queue
  where queue.id=p_queue_id and queue.workspace_id=v_queue.workspace_id
    and queue.status='running' and queue.claim_token=p_claim_token and queue.lease_until>now()
  for update;
  if not found then raise exception 'remediation_validation_claim_lost' using errcode = '40001'; end if;
  if p_outcome not in ('validated','validation_failed','denied')
    or p_commands is null or jsonb_typeof(p_commands) <> 'array'
    or p_diagnostics is null or octet_length(p_diagnostics) > 4000
    or p_duration_ms is null or p_duration_ms not between 0 and 120000 then
    raise exception 'invalid_remediation_validation_result' using errcode = '22023';
  end if;
  insert into public.remediation_validation_attempts (
    workspace_id,queue_id,attempt_number,patch_fingerprint,outcome,error_category,commands,diagnostics,duration_ms
  ) values (
    v_queue.workspace_id,v_queue.id,v_queue.attempt_count,v_queue.patch_fingerprint,p_outcome,
    left(p_error_category,80),p_commands,left(p_diagnostics,4000),p_duration_ms
  ) on conflict (queue_id,attempt_number) do nothing;
  update public.remediation_validation_queue
  set status = p_outcome,claim_token = null,lease_until = null,
      error_category = case when p_outcome = 'validated' then null else left(coalesce(p_error_category,p_outcome),80) end
  where id = v_queue.id;
  update public.remediation_proposals proposal
  set patch_validation_status = case p_outcome
    when 'validated' then 'validated' when 'denied' then 'validation_failed' else 'validation_failed' end
  where proposal.id = v_queue.remediation_proposal_id and proposal.workspace_id = v_queue.workspace_id;
  insert into public.protection_value_events
    (workspace_id,event_kind,impact_assessment_id,preflight_run_id,remediation_proposal_id,dedupe_key,metadata)
  select proposal.workspace_id,
    case p_outcome when 'validated' then 'remediation_validated' else 'remediation_validation_failed' end,
    run.impact_assessment_id,proposal.preflight_run_id,proposal.id,
    md5(v_queue.id::text || ':' || v_queue.patch_fingerprint || ':' || p_outcome) ||
      md5('m15-validation:' || v_queue.id::text || ':' || v_queue.patch_fingerprint || ':' || p_outcome),
    jsonb_build_object('outcome',p_outcome,'attempt',v_queue.attempt_count)
  from public.remediation_proposals proposal
  join public.preflight_runs run on run.id=proposal.preflight_run_id and run.workspace_id=proposal.workspace_id
  where proposal.id=v_queue.remediation_proposal_id and proposal.workspace_id=v_queue.workspace_id
    and p_outcome in ('validated','validation_failed')
  on conflict (workspace_id,event_kind,dedupe_key) do nothing;
end;
$$;

alter table public.product_remediation_policies enable row level security;
alter table public.remediation_validation_queue enable row level security;
alter table public.remediation_validation_attempts enable row level security;
alter table public.remediation_preparation_queue enable row level security;
alter table public.source_remediation_replacements enable row level security;

create policy product_remediation_policies_select_member on public.product_remediation_policies for select to authenticated
  using (exists(select 1 from public.workspace_members member where member.workspace_id=product_remediation_policies.workspace_id and member.user_id=(select auth.uid())));
create policy remediation_validation_queue_select_member on public.remediation_validation_queue for select to authenticated
  using (exists(select 1 from public.workspace_members member where member.workspace_id=remediation_validation_queue.workspace_id and member.user_id=(select auth.uid())));
create policy remediation_validation_attempts_select_member on public.remediation_validation_attempts for select to authenticated
  using (exists(select 1 from public.workspace_members member where member.workspace_id=remediation_validation_attempts.workspace_id and member.user_id=(select auth.uid())));
create policy remediation_preparation_queue_select_member on public.remediation_preparation_queue for select to authenticated
  using (exists(select 1 from public.workspace_members member where member.workspace_id=remediation_preparation_queue.workspace_id and member.user_id=(select auth.uid())));

revoke all on public.source_remediation_replacements,public.product_remediation_policies,
  public.remediation_validation_queue,public.remediation_validation_attempts,
  public.remediation_preparation_queue from public,anon,authenticated;
grant select on public.product_remediation_policies,public.remediation_validation_queue,
  public.remediation_validation_attempts,public.remediation_preparation_queue to authenticated;
grant all on public.source_remediation_replacements,public.product_remediation_policies,
  public.remediation_validation_queue,public.remediation_validation_attempts,public.remediation_preparation_queue to service_role;

revoke all on function private.enqueue_remediation_patch_validation() from public,anon,authenticated;
revoke all on function public.set_product_remediation_policy(uuid,uuid,boolean,boolean,boolean,boolean,uuid[]) from public,anon;
revoke all on function public.list_remediation_validation_queue(integer) from public,anon,authenticated;
revoke all on function public.claim_remediation_validation_dispatch(uuid) from public,anon,authenticated;
revoke all on function public.mark_remediation_validation_dispatched(uuid,integer,text) from public,anon,authenticated;
revoke all on function public.claim_remediation_validation(uuid,integer) from public,anon,authenticated;
revoke all on function public.complete_remediation_validation(uuid,uuid,text,text,jsonb,text,integer) from public,anon,authenticated;
revoke all on function public.resolve_customer_risk(uuid,uuid,text) from public,anon;
revoke all on function public.finish_preflight_dispatch(uuid,integer,text,text) from public,anon,authenticated;
revoke all on function public.mark_preflight_dispatch_run(uuid,integer,text) from public,anon,authenticated;
revoke all on function private.enqueue_eligible_remediation_preparation() from public,anon,authenticated;
revoke all on function public.list_remediation_preparation_queue(integer) from public,anon,authenticated;
revoke all on function public.claim_remediation_preparation_dispatch(uuid) from public,anon,authenticated;
revoke all on function public.mark_remediation_preparation_dispatched(uuid,integer,text) from public,anon,authenticated;
revoke all on function public.claim_remediation_preparation(uuid,integer) from public,anon,authenticated;
revoke all on function public.complete_remediation_preparation(uuid,uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.set_product_remediation_policy(uuid,uuid,boolean,boolean,boolean,boolean,uuid[]) to authenticated;
grant execute on function public.list_remediation_validation_queue(integer) to service_role;
grant execute on function public.claim_remediation_validation_dispatch(uuid) to service_role;
grant execute on function public.mark_remediation_validation_dispatched(uuid,integer,text) to service_role;
grant execute on function public.claim_remediation_validation(uuid,integer) to service_role;
grant execute on function public.complete_remediation_validation(uuid,uuid,text,text,jsonb,text,integer) to service_role;
grant execute on function public.resolve_customer_risk(uuid,uuid,text) to authenticated;
grant execute on function public.finish_preflight_dispatch(uuid,integer,text,text) to service_role;
grant execute on function public.mark_preflight_dispatch_run(uuid,integer,text) to service_role;
grant execute on function public.list_preflight_dispatch_queue(integer) to service_role;
grant execute on function public.list_remediation_preparation_queue(integer) to service_role;
grant execute on function public.claim_remediation_preparation_dispatch(uuid) to service_role;
grant execute on function public.mark_remediation_preparation_dispatched(uuid,integer,text) to service_role;
grant execute on function public.claim_remediation_preparation(uuid,integer) to service_role;
grant execute on function public.complete_remediation_preparation(uuid,uuid,text,uuid,text) to service_role;
