-- Persist the Business-only, policy-controlled preparation of a validated
-- remediation handoff. This does not call GitHub or create a pull request.
create table public.business_handoff_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null,
  workspace_dependency_id uuid not null,
  repository_id uuid not null,
  preflight_run_id uuid not null,
  remediation_proposal_id uuid not null,
  patch_fingerprint text not null check (patch_fingerprint ~ '^[a-f0-9]{64}$'),
  policy_version integer not null check (policy_version > 0),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 128),
  requested_by uuid not null references auth.users(id) on delete restrict,
  status text not null default 'queued'
    check (status in ('queued','dispatched','running','prepared','denied','failed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  trigger_run_id text check (trigger_run_id is null or char_length(trigger_run_id) <= 255),
  claim_token uuid,
  lease_until timestamptz,
  dispatch_lease_until timestamptz,
  error_category text check (error_category is null or error_category ~ '^[a-z0-9_]{1,80}$'),
  prepared_branch text check (prepared_branch is null or prepared_branch ~ '^auterim/fix/[a-f0-9]{8,40}$'),
  approval_required boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint business_handoff_product_workspace_fkey
    foreign key (product_id,workspace_id) references public.workspace_products(id,workspace_id) on delete cascade,
  constraint business_handoff_dependency_product_fkey
    foreign key (workspace_dependency_id,workspace_id,product_id)
    references public.workspace_dependencies(id,workspace_id,protected_product_id) on delete cascade,
  constraint business_handoff_repository_workspace_fkey
    foreign key (repository_id,workspace_id) references public.repositories(id,workspace_id) on delete cascade,
  constraint business_handoff_preflight_workspace_fkey
    foreign key (preflight_run_id,workspace_id) references public.preflight_runs(id,workspace_id) on delete cascade,
  constraint business_handoff_proposal_workspace_fkey
    foreign key (remediation_proposal_id,workspace_id) references public.remediation_proposals(id,workspace_id) on delete cascade,
  constraint business_handoff_idempotency_key unique (workspace_id,idempotency_key),
  constraint business_handoff_logical_action_key unique (workspace_id,remediation_proposal_id,repository_id),
  constraint business_handoff_terminal_timestamp_check check (
    (status in ('prepared','denied','failed') and completed_at is not null)
    or (status not in ('prepared','denied','failed') and completed_at is null)
  ),
  constraint business_handoff_running_lease_check check (
    (status='running' and claim_token is not null and lease_until is not null)
    or (status<>'running' and claim_token is null and lease_until is null)
  ),
  constraint business_handoff_prepared_result_check check (
    (status='prepared' and prepared_branch is not null and approval_required is not null)
    or (status<>'prepared' and prepared_branch is null and approval_required is null)
  )
);

create index business_handoff_dispatch_idx
  on public.business_handoff_requests(status,created_at)
  where status in ('queued','dispatched','running');
create index business_handoff_workspace_recent_idx
  on public.business_handoff_requests(workspace_id,created_at desc);
alter table public.business_handoff_requests enable row level security;
create policy business_handoff_requests_select_member
  on public.business_handoff_requests for select to authenticated
  using (exists (
    select 1 from public.workspace_members member
    where member.workspace_id=business_handoff_requests.workspace_id
      and member.user_id=(select auth.uid())
  ));
revoke all on public.business_handoff_requests from public,anon,authenticated;
grant select (
  id,workspace_id,product_id,workspace_dependency_id,repository_id,preflight_run_id,
  remediation_proposal_id,patch_fingerprint,policy_version,idempotency_key,requested_by,
  status,attempt_count,trigger_run_id,error_category,prepared_branch,approval_required,
  created_at,updated_at,completed_at
) on public.business_handoff_requests to authenticated;
grant all on public.business_handoff_requests to service_role;

create function public.request_business_handoff(
  p_workspace_id uuid,
  p_preflight_run_id uuid,
  p_repository_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
  v_row public.business_handoff_requests%rowtype;
  v_existing public.business_handoff_requests%rowtype;
  v_product_id uuid;
  v_dependency_id uuid;
  v_proposal_id uuid;
  v_fingerprint text;
  v_policy_version integer;
  v_safe_result jsonb;
begin
  if v_user_id is null or not exists (
    select 1 from public.workspace_members member
    where member.workspace_id=p_workspace_id and member.user_id=v_user_id
      and member.role in ('owner','admin','member')
  ) then
    raise exception 'workspace_member_required' using errcode='42501';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 128
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]+$' then
    raise exception 'invalid_idempotency_key' using errcode='22023';
  end if;

  -- Serialize requests for a workspace and align with the lifecycle lock order.
  perform 1 from public.workspaces workspace where workspace.id=p_workspace_id for update;
  if not found then raise exception 'workspace_not_found' using errcode='P0002'; end if;
  select * into v_existing from public.business_handoff_requests request
  where request.workspace_id=p_workspace_id and request.idempotency_key=p_idempotency_key;
  if found then
    if v_existing.preflight_run_id<>p_preflight_run_id or v_existing.repository_id<>p_repository_id then
      raise exception 'business_handoff_idempotency_conflict' using errcode='23505';
    end if;
    return jsonb_build_object(
      'id',v_existing.id,'workspaceId',v_existing.workspace_id,'productId',v_existing.product_id,
      'workspaceDependencyId',v_existing.workspace_dependency_id,'repositoryId',v_existing.repository_id,
      'preflightRunId',v_existing.preflight_run_id,'remediationProposalId',v_existing.remediation_proposal_id,
      'patchFingerprint',v_existing.patch_fingerprint,'policyVersion',v_existing.policy_version,
      'status',v_existing.status,'attemptCount',v_existing.attempt_count,'triggerRunId',v_existing.trigger_run_id,
      'errorCategory',v_existing.error_category,'preparedBranch',v_existing.prepared_branch,
      'approvalRequired',v_existing.approval_required,'createdAt',v_existing.created_at,
      'updatedAt',v_existing.updated_at,'completedAt',v_existing.completed_at
    );
  end if;
  select proposal.product_id,proposal.workspace_dependency_id,proposal.id,proposal.patch_fingerprint,
    policy.policy_version
  into v_product_id,v_dependency_id,v_proposal_id,v_fingerprint,v_policy_version
  from public.remediation_proposals proposal
  join public.preflight_runs run
    on run.id=proposal.preflight_run_id and run.workspace_id=proposal.workspace_id
  join public.impact_assessments assessment
    on assessment.id=run.impact_assessment_id and assessment.workspace_id=run.workspace_id
  join public.workspace_dependencies dependency
    on dependency.id=proposal.workspace_dependency_id and dependency.workspace_id=proposal.workspace_id
  join public.workspace_products product
    on product.id=proposal.product_id and product.workspace_id=proposal.workspace_id
  join public.product_remediation_policies policy
    on policy.product_id=product.id and policy.workspace_id=product.workspace_id
  join public.repositories repository
    on repository.id=p_repository_id and repository.workspace_id=proposal.workspace_id
  join public.repository_connections connection
    on connection.id=repository.connection_id and connection.workspace_id=repository.workspace_id
  where proposal.workspace_id=p_workspace_id
    and run.id=p_preflight_run_id
    and run.status='completed' and run.verified_impact='verified'
    and not exists (
      select 1 from public.preflight_runs newer
      where newer.workspace_id=run.workspace_id
        and newer.impact_assessment_id=run.impact_assessment_id
        and (newer.created_at,newer.id)>(run.created_at,run.id)
        and newer.status in ('completed','partial')
    )
    and assessment.status='assessed' and assessment.relevant
    and product.status='protected'
    and dependency.protected_product_id=product.id and dependency.monitoring_enabled
    and proposal.proposal_kind='patch' and proposal.patch is not null
    and proposal.patch_fingerprint is not null
    and proposal.patch_validation_status='validated'
    and proposal.generation_metadata->'repository'->>'id'=p_repository_id::text
    and exists (
      select 1 from public.remediation_validation_queue queue
      join public.remediation_validation_attempts attempt on attempt.queue_id=queue.id
      where queue.workspace_id=proposal.workspace_id
        and queue.remediation_proposal_id=proposal.id
        and queue.patch_fingerprint=proposal.patch_fingerprint
        and queue.status='validated' and attempt.outcome='validated'
    )
    and policy.enabled and policy.draft_pr_preparation_allowed
    and policy.automatic_workflow_handoff_allowed
    and policy.allowed_repository_ids @> array[p_repository_id]
    and private.workspace_quota_plan(p_workspace_id)='business'
    and repository.status='available' and repository.selected_for_protection
    and connection.status='connected'
    and exists (
      select 1 from public.workspace_repository_access access
      where access.workspace_id=proposal.workspace_id
        and access.workspace_dependency_id=dependency.id
        and access.repository_id=p_repository_id
    )
    and exists (
      select 1 from public.preflight_findings finding
      where finding.workspace_id=run.workspace_id and finding.preflight_run_id=run.id
        and finding.repository_id=p_repository_id and finding.verification='verified'
    )
  order by proposal.created_at desc,proposal.id desc
  limit 1;
  if v_proposal_id is null then
    raise exception 'business_handoff_not_eligible' using errcode='42501';
  end if;

  insert into public.business_handoff_requests (
    workspace_id,product_id,workspace_dependency_id,repository_id,preflight_run_id,
    remediation_proposal_id,patch_fingerprint,policy_version,idempotency_key,requested_by
  ) values (
    p_workspace_id,v_product_id,v_dependency_id,p_repository_id,p_preflight_run_id,
    v_proposal_id,v_fingerprint,v_policy_version,p_idempotency_key,v_user_id
  ) returning * into v_row;
  v_safe_result:=jsonb_build_object(
    'id',v_row.id,'workspaceId',v_row.workspace_id,'productId',v_row.product_id,
    'workspaceDependencyId',v_row.workspace_dependency_id,'repositoryId',v_row.repository_id,
    'preflightRunId',v_row.preflight_run_id,'remediationProposalId',v_row.remediation_proposal_id,
    'patchFingerprint',v_row.patch_fingerprint,'policyVersion',v_row.policy_version,
    'status',v_row.status,'attemptCount',v_row.attempt_count,'triggerRunId',v_row.trigger_run_id,
    'errorCategory',v_row.error_category,'preparedBranch',v_row.prepared_branch,
    'approvalRequired',v_row.approval_required,'createdAt',v_row.created_at,
    'updatedAt',v_row.updated_at,'completedAt',v_row.completed_at
  );
  return v_safe_result;
exception when unique_violation then
  select * into v_existing from public.business_handoff_requests request
  where request.workspace_id=p_workspace_id
    and (request.idempotency_key=p_idempotency_key
      or (request.remediation_proposal_id=v_proposal_id and request.repository_id=p_repository_id));
  if found and v_existing.preflight_run_id=p_preflight_run_id
    and v_existing.repository_id=p_repository_id and v_existing.remediation_proposal_id=v_proposal_id then
    return jsonb_build_object(
      'id',v_existing.id,'workspaceId',v_existing.workspace_id,'productId',v_existing.product_id,
      'workspaceDependencyId',v_existing.workspace_dependency_id,'repositoryId',v_existing.repository_id,
      'preflightRunId',v_existing.preflight_run_id,'remediationProposalId',v_existing.remediation_proposal_id,
      'patchFingerprint',v_existing.patch_fingerprint,'policyVersion',v_existing.policy_version,
      'status',v_existing.status,'attemptCount',v_existing.attempt_count,'triggerRunId',v_existing.trigger_run_id,
      'errorCategory',v_existing.error_category,'preparedBranch',v_existing.prepared_branch,
      'approvalRequired',v_existing.approval_required,'createdAt',v_existing.created_at,
      'updatedAt',v_existing.updated_at,'completedAt',v_existing.completed_at
    );
  end if;
  raise exception 'business_handoff_already_requested' using errcode='23505';
end;
$$;

create function public.list_business_handoff_requests(p_limit integer default 20)
returns setof public.business_handoff_requests
language sql security definer set search_path = '' as $$
  select request.* from public.business_handoff_requests request
  where (request.status='queued' and request.attempt_count<5)
    or (request.status='dispatched' and request.dispatch_lease_until is not null and request.dispatch_lease_until<now())
    or (request.status='running' and request.lease_until<now())
  order by request.created_at,request.id
  limit greatest(1,least(coalesce(p_limit,20),100))
$$;

create function public.claim_business_handoff_dispatch(p_request_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_attempt integer;
begin
  update public.business_handoff_requests request
  set status='dispatched',attempt_count=request.attempt_count+1,
      claim_token=null,lease_until=null,dispatch_lease_until=now()+interval '5 minutes',error_category=null
  where request.id=p_request_id and request.attempt_count<5
    and (request.status='queued' or (request.status='dispatched' and request.dispatch_lease_until<now())
      or (request.status='running' and request.lease_until<now()))
  returning request.attempt_count into v_attempt;
  return v_attempt;
end;
$$;

create function public.mark_business_handoff_dispatched(
  p_request_id uuid,p_attempt integer,p_trigger_run_id text
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.business_handoff_requests
  set trigger_run_id=left(p_trigger_run_id,255)
  where id=p_request_id and status='dispatched' and attempt_count=p_attempt
    and (trigger_run_id is null or trigger_run_id=left(p_trigger_run_id,255));
  return found;
end;
$$;

create function public.claim_business_handoff_execution(p_request_id uuid,p_attempt integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_row public.business_handoff_requests%rowtype;
  v_policy public.product_remediation_policies%rowtype;
  v_token uuid := gen_random_uuid();
  v_eligible boolean;
begin
  select * into v_row from public.business_handoff_requests where id=p_request_id;
  if not found or v_row.attempt_count<>p_attempt then return null; end if;
  perform 1 from public.workspaces where id=v_row.workspace_id for update;
  perform 1 from public.workspace_products
    where id=v_row.product_id and workspace_id=v_row.workspace_id for update;
  perform 1 from public.workspace_dependencies
    where id=v_row.workspace_dependency_id and workspace_id=v_row.workspace_id for update;
  perform 1 from public.preflight_runs
    where id=v_row.preflight_run_id and workspace_id=v_row.workspace_id for update;
  perform 1 from public.remediation_proposals
    where id=v_row.remediation_proposal_id and workspace_id=v_row.workspace_id for update;
  select * into v_policy from public.product_remediation_policies
    where product_id=v_row.product_id and workspace_id=v_row.workspace_id for update;
  select * into v_row from public.business_handoff_requests
    where id=p_request_id and workspace_id=v_row.workspace_id for update;
  if not found or v_row.attempt_count<>p_attempt or v_row.status<>'dispatched' then return null; end if;

  select exists (
    select 1
    from public.workspace_products product
    join public.workspace_dependencies dependency
      on dependency.id=v_row.workspace_dependency_id and dependency.workspace_id=product.workspace_id
    join public.preflight_runs run
      on run.id=v_row.preflight_run_id and run.workspace_id=product.workspace_id
    join public.impact_assessments assessment
      on assessment.id=run.impact_assessment_id and assessment.workspace_id=run.workspace_id
    join public.remediation_proposals proposal
      on proposal.id=v_row.remediation_proposal_id and proposal.workspace_id=run.workspace_id
    join public.product_remediation_policies policy
      on policy.product_id=product.id and policy.workspace_id=product.workspace_id
    join public.repositories repository
      on repository.id=v_row.repository_id and repository.workspace_id=product.workspace_id
    join public.repository_connections connection
      on connection.id=repository.connection_id and connection.workspace_id=repository.workspace_id
    where product.id=v_row.product_id and product.workspace_id=v_row.workspace_id
      and product.status='protected'
      and dependency.protected_product_id=product.id and dependency.monitoring_enabled
      and run.status='completed' and run.verified_impact='verified'
      and not exists (
        select 1 from public.preflight_runs newer
        where newer.workspace_id=run.workspace_id
          and newer.impact_assessment_id=run.impact_assessment_id
          and (newer.created_at,newer.id)>(run.created_at,run.id)
          and newer.status in ('completed','partial')
      )
      and assessment.status='assessed' and assessment.relevant
      and proposal.product_id=product.id and proposal.workspace_dependency_id=dependency.id
      and proposal.preflight_run_id=run.id and proposal.proposal_kind='patch'
      and proposal.patch is not null and proposal.patch_fingerprint=v_row.patch_fingerprint
      and proposal.generation_metadata->'repository'->>'id'=v_row.repository_id::text
      and proposal.patch_validation_status='validated'
      and v_policy.policy_version=v_row.policy_version
      and policy.enabled and policy.draft_pr_preparation_allowed
      and policy.automatic_workflow_handoff_allowed
      and policy.allowed_repository_ids @> array[repository.id]
      and private.workspace_quota_plan(v_row.workspace_id)='business'
      and repository.status='available' and repository.selected_for_protection
      and connection.status='connected'
      and exists (
        select 1 from public.workspace_repository_access access
        where access.workspace_id=v_row.workspace_id
          and access.workspace_dependency_id=dependency.id
          and access.repository_id=repository.id
      )
      and exists (
        select 1 from public.remediation_validation_queue queue
        join public.remediation_validation_attempts attempt on attempt.queue_id=queue.id
        where queue.workspace_id=v_row.workspace_id
          and queue.remediation_proposal_id=proposal.id
          and queue.patch_fingerprint=proposal.patch_fingerprint
          and queue.status='validated' and attempt.outcome='validated'
      )
      and exists (
        select 1 from public.preflight_findings finding
        where finding.workspace_id=run.workspace_id and finding.preflight_run_id=run.id
          and finding.repository_id=repository.id and finding.verification='verified'
      )
  ) into v_eligible;

  if not v_eligible or v_policy.policy_version is distinct from v_row.policy_version then
    update public.business_handoff_requests
    set status='denied',claim_token=null,lease_until=null,error_category='execution_ineligible',completed_at=now()
    where id=p_request_id;
    return null;
  end if;
  update public.business_handoff_requests
  set status='running',claim_token=v_token,lease_until=now()+interval '10 minutes',
      dispatch_lease_until=null,error_category=null
  where id=p_request_id;
  return v_token;
end;
$$;

create function public.complete_business_handoff_preparation(
  p_request_id uuid,p_claim_token uuid,p_outcome text,p_prepared_branch text default null,
  p_approval_required boolean default null,p_error_category text default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_row public.business_handoff_requests%rowtype;
begin
  if p_outcome not in ('prepared','denied','failed') then
    raise exception 'invalid_business_handoff_outcome' using errcode='22023';
  end if;
  select * into v_row from public.business_handoff_requests request
  where request.id=p_request_id and request.status='running'
    and request.claim_token=p_claim_token and request.lease_until>now()
  for update;
  if not found then raise exception 'business_handoff_claim_lost' using errcode='40001'; end if;
  if p_outcome='prepared' and (p_prepared_branch !~ '^auterim/fix/[a-f0-9]{8,40}$' or p_approval_required is null) then
    raise exception 'invalid_business_handoff_result' using errcode='22023';
  end if;
  update public.business_handoff_requests
  set status=p_outcome,claim_token=null,lease_until=null,dispatch_lease_until=null,
      prepared_branch=case when p_outcome='prepared' then p_prepared_branch else null end,
      approval_required=case when p_outcome='prepared' then p_approval_required else null end,
      error_category=case when p_outcome='prepared' then null else left(coalesce(p_error_category,p_outcome),80) end,
      completed_at=now()
  where id=p_request_id;
  if p_outcome='prepared' then
    insert into public.protection_value_events
      (workspace_id,event_kind,impact_assessment_id,preflight_run_id,remediation_proposal_id,dedupe_key,metadata)
    select v_row.workspace_id,'draft_pr_prepared',run.impact_assessment_id,v_row.preflight_run_id,
      v_row.remediation_proposal_id,
      md5(v_row.id::text || ':draft-pr-prepared') || md5('m15-business-handoff:' || v_row.id::text),
      jsonb_build_object('handoffRequestId',v_row.id,'policyVersion',v_row.policy_version,
        'approvalRequired',p_approval_required,'externalPullRequestCreated',false)
    from public.preflight_runs run where run.id=v_row.preflight_run_id and run.workspace_id=v_row.workspace_id
    on conflict (workspace_id,event_kind,dedupe_key) do nothing;
  end if;
  return true;
end;
$$;

revoke all on function public.request_business_handoff(uuid,uuid,uuid,text) from public,anon;
revoke all on function public.list_business_handoff_requests(integer) from public,anon,authenticated;
revoke all on function public.claim_business_handoff_dispatch(uuid) from public,anon,authenticated;
revoke all on function public.mark_business_handoff_dispatched(uuid,integer,text) from public,anon,authenticated;
revoke all on function public.claim_business_handoff_execution(uuid,integer) from public,anon,authenticated;
revoke all on function public.complete_business_handoff_preparation(uuid,uuid,text,text,boolean,text) from public,anon,authenticated;
grant execute on function public.request_business_handoff(uuid,uuid,uuid,text) to authenticated;
grant execute on function public.list_business_handoff_requests(integer) to service_role;
grant execute on function public.claim_business_handoff_dispatch(uuid) to service_role;
grant execute on function public.mark_business_handoff_dispatched(uuid,integer,text) to service_role;
grant execute on function public.claim_business_handoff_execution(uuid,integer) to service_role;
grant execute on function public.complete_business_handoff_preparation(uuid,uuid,text,text,boolean,text) to service_role;
