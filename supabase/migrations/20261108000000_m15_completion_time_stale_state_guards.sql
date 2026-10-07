-- Commit remediation output only while its authorization and evidence basis are current.
-- The provider/file work happens before this transaction; no candidate proposal or validation
-- queue row exists until the final locked currentness check succeeds.

-- Serialize repository selection with completion and lifecycle operations. The initial read only
-- discovers the owning workspace; after locking it, the repository row is re-read and locked so
-- access-row FK checks cannot invert repository/dependency lock order.
create or replace function public.set_repository_protection(
  p_repository_id uuid,p_selected boolean,p_dependency_ids uuid[]
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  repository_row public.repositories%rowtype;
  initial_workspace_id uuid;
  actor_id uuid := auth.uid();
  dependency_count integer;
begin
  if actor_id is null or p_selected is null or p_dependency_ids is null or cardinality(p_dependency_ids)>50
    or (p_selected and cardinality(p_dependency_ids)=0) or (not p_selected and cardinality(p_dependency_ids)>0) then
    raise exception 'invalid_repository_selection' using errcode='22023';
  end if;

  select workspace_id into initial_workspace_id
  from public.repositories where id=p_repository_id;
  if not found then raise exception 'repository_not_found' using errcode='P0002'; end if;

  perform 1 from public.workspaces where id=initial_workspace_id for update;
  select * into repository_row from public.repositories where id=p_repository_id for update;
  if not found or repository_row.workspace_id<>initial_workspace_id then
    raise exception 'repository_not_found' using errcode='P0002';
  end if;
  if not exists(
    select 1 from public.workspace_members
    where workspace_id=repository_row.workspace_id and user_id=actor_id and role in ('owner','admin')
  ) then
    raise exception 'forbidden' using errcode='42501';
  end if;
  if p_selected and not private.workspace_can_run_preflight(repository_row.workspace_id) then
    raise exception 'pro_plan_required' using errcode='42501';
  end if;
  if p_selected and (
    select count(*) from public.repositories existing
    where existing.workspace_id=repository_row.workspace_id
      and existing.selected_for_protection and existing.id<>p_repository_id
  ) >= private.workspace_repository_limit(repository_row.workspace_id) then
    raise exception 'repository_quota_exceeded' using errcode='22023';
  end if;
  if p_selected and (
    repository_row.status<>'available' or (
      select connection.status from public.repository_connections connection
      where connection.id=repository_row.connection_id
    )<>'connected'
  ) then
    raise exception 'repository_unavailable' using errcode='22023';
  end if;
  select count(distinct dependency_id)::integer into dependency_count
  from unnest(p_dependency_ids) dependency_id;
  if dependency_count<>cardinality(p_dependency_ids) then
    raise exception 'duplicate_dependency' using errcode='22023';
  end if;
  if dependency_count>0 and dependency_count<>(
    select count(*) from public.workspace_dependencies dependency
    where dependency.workspace_id=repository_row.workspace_id and dependency.id=any(p_dependency_ids)
  ) then
    raise exception 'dependency_not_found' using errcode='P0002';
  end if;

  delete from public.workspace_repository_access
  where repository_id=p_repository_id and workspace_id=repository_row.workspace_id;
  update public.repositories set selected_for_protection=p_selected where id=p_repository_id;
  if p_selected then
    insert into public.workspace_repository_access (workspace_id,workspace_dependency_id,repository_id)
    select repository_row.workspace_id,dependency_id,p_repository_id from unnest(p_dependency_ids) dependency_id;
  end if;
  return jsonb_build_object(
    'repositoryId',p_repository_id,
    'selectedForProtection',p_selected,
    'dependencyCount',dependency_count
  );
end;
$$;
revoke all on function public.set_repository_protection(uuid,boolean,uuid[]) from public,anon;
grant execute on function public.set_repository_protection(uuid,boolean,uuid[]) to authenticated;

-- Keep the persisted patch identity bound to its exact bytes and the evidence that justified it.
create function private.m15_patch_fingerprint_matches(
  p_base_commit_sha text,
  p_patch text,
  p_replacement_evidence_id uuid,
  p_patch_fingerprint text
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(
    p_base_commit_sha is not null
    and p_patch is not null
    and p_replacement_evidence_id is not null
    and p_patch_fingerprint is not null
    and encode(
      extensions.digest(
        encode(extensions.digest(p_base_commit_sha || E'\n' || p_patch, 'sha256'), 'hex')
          || E'\n' || p_replacement_evidence_id::text,
        'sha256'
      ),
      'hex'
    ) = p_patch_fingerprint,
    false
  );
$$;
revoke all on function private.m15_patch_fingerprint_matches(text,text,uuid,text) from public,anon,authenticated;
grant execute on function private.m15_patch_fingerprint_matches(text,text,uuid,text) to service_role;

create function private.m15_remediation_preparation_is_current(
  p_queue_id uuid,
  p_candidate jsonb
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_queue public.remediation_preparation_queue%rowtype;
  v_candidate public.remediation_proposals%rowtype;
  v_repository_id uuid;
  v_commit_sha text;
  v_replacement_id uuid;
  v_replacement_fingerprint text;
begin
  if jsonb_typeof(p_candidate) <> 'object' then return false; end if;
  select * into v_queue from public.remediation_preparation_queue where id=p_queue_id;
  if not found then return false; end if;
  select * into v_candidate
  from jsonb_populate_record(null::public.remediation_proposals,p_candidate);
  begin
    v_repository_id := (v_candidate.generation_metadata->'repository'->>'id')::uuid;
  exception when others then
    return false;
  end;
  v_commit_sha := v_candidate.generation_metadata->'repository'->>'commitSha';
  if v_candidate.proposal_kind='patch' then
    begin
      v_replacement_id := (v_candidate.generation_metadata->>'replacementEvidenceId')::uuid;
    exception when others then
      return false;
    end;
    v_replacement_fingerprint := v_candidate.generation_metadata->>'replacementEvidenceFingerprint';
    if not private.m15_patch_fingerprint_matches(
      v_candidate.base_commit_sha,v_candidate.patch,v_replacement_id,v_candidate.patch_fingerprint
    ) then
      return false;
    end if;
  end if;

  return exists (
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
      and classification.change_id=v_candidate.source_change_id
    join public.source_remediation_replacements replacement
      on replacement.source_change_id=classification.change_id
      and replacement.source_change_classification_id=classification.id
      and ((replacement.synthetic=false and replacement.internal_qa=false and replacement.public_eligible=true)
        or (replacement.synthetic=true and replacement.internal_qa=true and replacement.public_eligible=false))
      and (v_candidate.proposal_kind <> 'patch' or (
        replacement.id=v_replacement_id
        and replacement.evidence_fingerprint=v_replacement_fingerprint
      ))
    where run.id=v_queue.preflight_run_id and run.workspace_id=v_queue.workspace_id
      and run.impact_assessment_id=v_queue.impact_assessment_id
      and run.status='completed' and run.verified_impact='verified'
      and assessment.id=v_queue.impact_assessment_id and assessment.status='assessed' and assessment.relevant
      and dependency.id=v_candidate.workspace_dependency_id
      and dependency.protected_product_id=v_candidate.product_id
      and dependency.monitoring_enabled
      and product.status='protected'
      and classification.id=v_candidate.source_change_classification_id
      and classification.status='classified' and classification.material
      and v_candidate.workspace_id=v_queue.workspace_id
      and v_candidate.preflight_run_id=v_queue.preflight_run_id
      and v_candidate.source_change_id=classification.change_id
      and v_candidate.proposal_kind in ('patch','grounded_guidance')
      and v_candidate.proposal_fingerprint ~ '^[a-f0-9]{64}$'
      and v_candidate.base_commit_sha ~ '^[a-f0-9]{40,64}$'
      and v_commit_sha=v_candidate.base_commit_sha
      and private.workspace_quota_plan(v_queue.workspace_id) in ('pro','business')
      and exists (
        select 1 from public.preflight_findings finding
        where finding.preflight_run_id=run.id and finding.workspace_id=run.workspace_id
          and finding.repository_id=v_repository_id and finding.commit_sha=v_commit_sha
          and finding.commit_sha=v_candidate.base_commit_sha and finding.verification='verified'
      )
      and exists (
        select 1 from public.workspace_repository_access access
        join public.repositories repository
          on repository.id=access.repository_id and repository.workspace_id=access.workspace_id
        join public.repository_connections connection
          on connection.id=repository.connection_id and connection.workspace_id=repository.workspace_id
        where access.workspace_id=v_queue.workspace_id
          and access.workspace_dependency_id=dependency.id and access.repository_id=v_repository_id
          and repository.status='available' and repository.selected_for_protection
          and connection.status='connected'
      )
      and (v_candidate.proposal_kind <> 'patch' or (
        v_candidate.patch is not null
        and v_candidate.patch_fingerprint ~ '^[a-f0-9]{64}$'
        and exists (
          select 1 from public.product_remediation_policies policy
          where policy.workspace_id=v_queue.workspace_id and policy.product_id=product.id
            and policy.enabled and policy.draft_pr_preparation_allowed
            and policy.allowed_repository_ids @> array[v_repository_id]
        )
      ))
      and not exists (
        select 1 from public.preflight_runs newer
        where newer.workspace_id=run.workspace_id
          and newer.impact_assessment_id=run.impact_assessment_id
          and (newer.created_at,newer.id)>(run.created_at,run.id)
          and newer.status in ('completed','partial')
      )
  );
end;
$$;

revoke all on function private.m15_remediation_preparation_is_current(uuid,jsonb) from public,anon,authenticated;
grant execute on function private.m15_remediation_preparation_is_current(uuid,jsonb) to service_role;

drop function public.complete_remediation_preparation(uuid,uuid,text,uuid,text);
create function public.complete_remediation_preparation(
  p_queue_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_proposal jsonb default null,
  p_error_category text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_queue public.remediation_preparation_queue%rowtype;
  v_product_id uuid;
  v_dependency_id uuid;
  v_classification_id uuid;
  v_change_id uuid;
  v_repository_id uuid;
  v_connection_id uuid;
  v_proposal public.remediation_proposals%rowtype;
  v_proposal_id uuid;
  v_inserted boolean := false;
begin
  if p_outcome not in ('completed','denied','failed') then
    raise exception 'invalid_preparation_outcome' using errcode='22023';
  end if;
  select * into v_queue from public.remediation_preparation_queue where id=p_queue_id;
  if not found then return jsonb_build_object('status','claim_lost'); end if;

  select dependency.id,dependency.protected_product_id,classification.id,classification.change_id
    into v_dependency_id,v_product_id,v_classification_id,v_change_id
  from public.impact_assessments assessment
  join public.workspace_dependencies dependency
    on dependency.id=assessment.workspace_dependency_id and dependency.workspace_id=assessment.workspace_id
  left join public.source_change_classifications classification
    on classification.id=assessment.source_change_classification_id
  where assessment.id=v_queue.impact_assessment_id and assessment.workspace_id=v_queue.workspace_id;

  -- Parse the candidate repository before locking repository-selection rows. A NULL repository
  -- ID would make the later SELECT ... FOR UPDATE match nothing and reopen a revocation race.
  if p_outcome='completed' then
    if jsonb_typeof(p_proposal) <> 'object' then
      raise exception 'invalid_remediation_proposal_candidate' using errcode='22023';
    end if;
    select * into v_proposal from jsonb_populate_record(null::public.remediation_proposals,p_proposal);
    begin
      v_repository_id := (v_proposal.generation_metadata->'repository'->>'id')::uuid;
    exception when others then
      v_repository_id := null;
    end;
  end if;

  -- Stable lock order: workspace → subscription/onboarding → product → dependency/change →
  -- repository connection → repository → access → policy → Preflight → queue/proposal. GitHub
  -- installation revocation updates connection before repositories, so this order avoids inversion.
  perform 1 from public.workspaces where id=v_queue.workspace_id for update;
  perform 1 from public.workspace_subscriptions where workspace_id=v_queue.workspace_id for update;
  perform 1 from public.workspace_onboarding where workspace_id=v_queue.workspace_id for update;
  perform 1 from public.workspace_products
    where id=v_product_id and workspace_id=v_queue.workspace_id for update;
  perform 1 from public.workspace_dependencies
    where id=v_dependency_id and workspace_id=v_queue.workspace_id for update;
  perform 1 from public.impact_assessments
    where id=v_queue.impact_assessment_id and workspace_id=v_queue.workspace_id for update;
  perform 1 from public.source_change_classifications
    where id=v_classification_id and change_id=v_change_id for update;
  -- Resolve the connection before locking; revocation locks connection → repository → access.
  select repository.connection_id into v_connection_id from public.repositories repository
    where repository.id=v_repository_id and repository.workspace_id=v_queue.workspace_id;
  perform 1 from public.repository_connections connection
    where connection.id=v_connection_id and connection.workspace_id=v_queue.workspace_id for update;
  perform 1 from public.repositories repository
    where repository.id=v_repository_id and repository.workspace_id=v_queue.workspace_id
      and repository.connection_id=v_connection_id for update;
  perform 1 from public.workspace_repository_access access
    where access.workspace_id=v_queue.workspace_id
      and access.workspace_dependency_id=v_dependency_id and access.repository_id=v_repository_id
    for update;
  perform 1 from public.product_remediation_policies policy
    where policy.workspace_id=v_queue.workspace_id and policy.product_id=v_product_id for update;
  perform 1 from public.preflight_runs
    where id=v_queue.preflight_run_id and workspace_id=v_queue.workspace_id for update;
  select * into v_queue from public.remediation_preparation_queue
    where id=p_queue_id and workspace_id=v_queue.workspace_id
      and status='running' and claim_token=p_claim_token and lease_until>clock_timestamp()
  for update;
  if not found then return jsonb_build_object('status','claim_lost'); end if;

  if p_outcome <> 'completed' then
    update public.remediation_preparation_queue
    set status=p_outcome,claim_token=null,lease_until=null,
        error_category=case when p_outcome='denied' then left(coalesce(p_error_category,'execution_ineligible'),80)
          else left(coalesce(p_error_category,p_outcome),80) end
    where id=p_queue_id;
    return jsonb_build_object('status',p_outcome);
  end if;

  if not private.m15_remediation_preparation_is_current(p_queue_id,p_proposal) then
    update public.remediation_preparation_queue
    set status='denied',claim_token=null,lease_until=null,error_category='execution_ineligible'
    where id=p_queue_id;
    return jsonb_build_object('status','denied','errorCategory','execution_ineligible');
  end if;

  insert into public.remediation_proposals (
    workspace_id,preflight_run_id,proposal_kind,proposal_fingerprint,rationale,migration_notes,
    validation_requirements,affected_files,patch,base_commit_sha,created_by,product_id,
    workspace_dependency_id,source_change_id,source_change_classification_id,patch_fingerprint,generation_metadata
  ) values (
    v_proposal.workspace_id,v_proposal.preflight_run_id,v_proposal.proposal_kind,v_proposal.proposal_fingerprint,
    v_proposal.rationale,v_proposal.migration_notes,v_proposal.validation_requirements,v_proposal.affected_files,
    v_proposal.patch,v_proposal.base_commit_sha,null,v_proposal.product_id,v_proposal.workspace_dependency_id,
    v_proposal.source_change_id,v_proposal.source_change_classification_id,v_proposal.patch_fingerprint,
    v_proposal.generation_metadata
  ) on conflict (preflight_run_id,proposal_fingerprint) do nothing
  returning id into v_proposal_id;
  v_inserted := v_proposal_id is not null;
  if v_proposal_id is null then
    select proposal.id into v_proposal_id
    from public.remediation_proposals proposal
    where proposal.workspace_id=v_queue.workspace_id
      and proposal.preflight_run_id=v_queue.preflight_run_id
      and proposal.proposal_fingerprint=v_proposal.proposal_fingerprint
      and proposal.product_id=v_proposal.product_id
      and proposal.workspace_dependency_id=v_proposal.workspace_dependency_id
      and proposal.source_change_id=v_proposal.source_change_id
      and proposal.source_change_classification_id=v_proposal.source_change_classification_id
    for update;
    if v_proposal_id is null then
      raise exception 'remediation_proposal_identity_conflict' using errcode='23505';
    end if;
  end if;
  update public.remediation_preparation_queue
  set status='completed',claim_token=null,lease_until=null,remediation_proposal_id=v_proposal_id,error_category=null
  where id=p_queue_id;
  return jsonb_build_object('status','completed','proposalId',v_proposal_id,'replayed',not v_inserted);
end;
$$;

revoke all on function public.complete_remediation_preparation(uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.complete_remediation_preparation(uuid,uuid,text,jsonb,text) to service_role;

create function private.m15_remediation_validation_is_current(p_queue_id uuid,p_proposal_id uuid)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_queue public.remediation_validation_queue%rowtype;
  v_proposal public.remediation_proposals%rowtype;
  v_repository_id uuid;
  v_replacement_id uuid;
  v_replacement_fingerprint text;
begin
  select * into v_queue from public.remediation_validation_queue where id=p_queue_id;
  if not found then return false; end if;
  select * into v_proposal from public.remediation_proposals
    where id=p_proposal_id and workspace_id=v_queue.workspace_id;
  if not found then return false; end if;
  begin
    v_repository_id := (v_proposal.generation_metadata->'repository'->>'id')::uuid;
  exception when others then
    return false;
  end;
  begin
    v_replacement_id := (v_proposal.generation_metadata->>'replacementEvidenceId')::uuid;
  exception when others then
    return false;
  end;
  v_replacement_fingerprint := v_proposal.generation_metadata->>'replacementEvidenceFingerprint';
  if not private.m15_patch_fingerprint_matches(
    v_proposal.base_commit_sha,v_proposal.patch,v_replacement_id,v_proposal.patch_fingerprint
  ) then
    return false;
  end if;
  return exists (
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
    where product.id=v_proposal.product_id and product.workspace_id=v_queue.workspace_id and product.status='protected'
      and v_queue.remediation_proposal_id=v_proposal.id
      and v_queue.patch_fingerprint=v_proposal.patch_fingerprint
      and dependency.protected_product_id=product.id and dependency.monitoring_enabled
      and assessment.id=run.impact_assessment_id and assessment.status='assessed' and assessment.relevant
      and assessment.source_change_classification_id=v_proposal.source_change_classification_id
      and run.status='completed' and run.verified_impact='verified'
      and classification.status='classified' and classification.material
      and v_proposal.status='prepared' and v_proposal.proposal_kind='patch' and v_proposal.patch is not null
      and v_proposal.patch_fingerprint=v_queue.patch_fingerprint
      and v_proposal.generation_metadata->'repository'->>'commitSha'=v_proposal.base_commit_sha
      and v_proposal.patch_validation_status='validating'
      and policy.enabled and policy.draft_pr_preparation_allowed
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
          and repository.status='available' and repository.selected_for_protection
          and connection.status='connected'
      )
      and exists (
        select 1 from public.source_remediation_replacements replacement
        where replacement.id=(v_proposal.generation_metadata->>'replacementEvidenceId')::uuid
          and replacement.source_change_id=v_proposal.source_change_id
          and replacement.source_change_classification_id=v_proposal.source_change_classification_id
          and replacement.evidence_fingerprint=v_replacement_fingerprint
          and ((replacement.synthetic=false and replacement.internal_qa=false and replacement.public_eligible=true)
            or (v_proposal.generation_metadata->>'internalQaOnly'='true'
              and replacement.synthetic=true and replacement.internal_qa=true and replacement.public_eligible=false))
      )
      and not exists (
        select 1 from public.preflight_runs newer_run
        where newer_run.workspace_id=run.workspace_id and newer_run.impact_assessment_id=run.impact_assessment_id
          and (newer_run.created_at,newer_run.id)>(run.created_at,run.id)
          and newer_run.status in ('completed','partial')
      )
      and not exists (
        select 1 from public.remediation_proposals newer_proposal
        where newer_proposal.workspace_id=v_proposal.workspace_id
          and newer_proposal.workspace_dependency_id=v_proposal.workspace_dependency_id
          and newer_proposal.source_change_id=v_proposal.source_change_id
          and newer_proposal.proposal_kind='patch'
          and newer_proposal.generation_metadata->'repository'->>'id'=v_repository_id::text
          and (newer_proposal.created_at,newer_proposal.id)>(v_proposal.created_at,v_proposal.id)
      )
  );
end;
$$;

revoke all on function private.m15_remediation_validation_is_current(uuid,uuid) from public,anon,authenticated;
grant execute on function private.m15_remediation_validation_is_current(uuid,uuid) to service_role;

create or replace function public.complete_remediation_validation(
  p_queue_id uuid,p_claim_token uuid,p_outcome text,p_error_category text,
  p_commands jsonb,p_diagnostics text,p_duration_ms integer
)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_queue public.remediation_validation_queue%rowtype;
  v_proposal public.remediation_proposals%rowtype;
  v_impact_assessment_id uuid;
  v_repository_id uuid;
  v_connection_id uuid;
  v_outcome text := p_outcome;
  v_error_category text := p_error_category;
  v_diagnostics text := p_diagnostics;
begin
  select * into v_queue from public.remediation_validation_queue where id=p_queue_id;
  if not found then raise exception 'remediation_validation_claim_lost' using errcode = '40001'; end if;
  select * into v_proposal from public.remediation_proposals
    where id=v_queue.remediation_proposal_id and workspace_id=v_queue.workspace_id;
  if not found then raise exception 'remediation_validation_claim_lost' using errcode = '40001'; end if;
  begin
    v_repository_id := (v_proposal.generation_metadata->'repository'->>'id')::uuid;
  exception when others then
    v_repository_id := null;
  end;
  select run.impact_assessment_id into v_impact_assessment_id
    from public.preflight_runs run
    where run.id=v_proposal.preflight_run_id and run.workspace_id=v_queue.workspace_id;

  -- Match preparation's connection → repository → access order after the workspace lock.
  perform 1 from public.workspaces where id=v_queue.workspace_id for update;
  perform 1 from public.workspace_subscriptions where workspace_id=v_queue.workspace_id for update;
  perform 1 from public.workspace_onboarding where workspace_id=v_queue.workspace_id for update;
  perform 1 from public.workspace_products
    where id=v_proposal.product_id and workspace_id=v_queue.workspace_id for update;
  perform 1 from public.workspace_dependencies
    where id=v_proposal.workspace_dependency_id and workspace_id=v_queue.workspace_id for update;
  perform 1 from public.impact_assessments
    where id=v_impact_assessment_id and workspace_id=v_queue.workspace_id for update;
  perform 1 from public.source_change_classifications
    where id=v_proposal.source_change_classification_id and change_id=v_proposal.source_change_id for update;
  -- GitHub revocation updates connection before repositories; take the same row order here.
  select repository.connection_id into v_connection_id from public.repositories repository
    where repository.id=v_repository_id and repository.workspace_id=v_queue.workspace_id;
  perform 1 from public.repository_connections connection
    where connection.id=v_connection_id and connection.workspace_id=v_queue.workspace_id for update;
  perform 1 from public.repositories repository
    where repository.id=v_repository_id and repository.workspace_id=v_queue.workspace_id
      and repository.connection_id=v_connection_id for update;
  perform 1 from public.workspace_repository_access access
    where access.workspace_id=v_queue.workspace_id
      and access.workspace_dependency_id=v_proposal.workspace_dependency_id
      and access.repository_id=v_repository_id
    for update;
  perform 1 from public.product_remediation_policies policy
    where policy.workspace_id=v_queue.workspace_id and policy.product_id=v_proposal.product_id for update;
  perform 1 from public.preflight_runs
    where id=v_proposal.preflight_run_id and workspace_id=v_queue.workspace_id for update;
  select * into v_proposal from public.remediation_proposals
    where id=v_queue.remediation_proposal_id and workspace_id=v_queue.workspace_id for update;
  select * into v_queue from public.remediation_validation_queue queue
  where queue.id=p_queue_id and queue.workspace_id=v_queue.workspace_id
    and queue.status='running' and queue.claim_token=p_claim_token and queue.lease_until>clock_timestamp()
  for update;
  if not found then raise exception 'remediation_validation_claim_lost' using errcode = '40001'; end if;
  if p_outcome not in ('validated','validation_failed','denied')
    or p_commands is null or jsonb_typeof(p_commands) <> 'array'
    or p_diagnostics is null or octet_length(p_diagnostics) > 4000
    or p_duration_ms is null or p_duration_ms not between 0 and 120000 then
    raise exception 'invalid_remediation_validation_result' using errcode = '22023';
  end if;

  if p_outcome in ('validated','validation_failed') and not private.m15_remediation_validation_is_current(p_queue_id,v_proposal.id) then
    v_outcome := 'denied';
    v_error_category := 'execution_ineligible';
    v_diagnostics := left(
      v_diagnostics || E'\nValidation result was not accepted because persisted authorization or evidence changed before completion.',
      4000
    );
  end if;

  insert into public.remediation_validation_attempts (
    workspace_id,queue_id,attempt_number,patch_fingerprint,outcome,error_category,commands,diagnostics,duration_ms
  ) values (
    v_queue.workspace_id,v_queue.id,v_queue.attempt_count,v_queue.patch_fingerprint,v_outcome,
    left(v_error_category,80),p_commands,v_diagnostics,p_duration_ms
  ) on conflict (queue_id,attempt_number) do nothing;
  update public.remediation_validation_queue
  set status=v_outcome,claim_token=null,lease_until=null,
      error_category=case when v_outcome='validated' then null else left(coalesce(v_error_category,v_outcome),80) end
  where id=v_queue.id;
  update public.remediation_proposals proposal
  set patch_validation_status=case when v_outcome='validated' then 'validated' else 'validation_failed' end
  where proposal.id=v_queue.remediation_proposal_id and proposal.workspace_id=v_queue.workspace_id
    and proposal.status='prepared'
    and proposal.patch_fingerprint=v_queue.patch_fingerprint
    and proposal.patch_validation_status='validating';
  if v_outcome in ('validated','validation_failed') then
    insert into public.protection_value_events
      (workspace_id,event_kind,impact_assessment_id,preflight_run_id,remediation_proposal_id,dedupe_key,metadata)
    select proposal.workspace_id,
      case v_outcome when 'validated' then 'remediation_validated' else 'remediation_validation_failed' end,
      run.impact_assessment_id,proposal.preflight_run_id,proposal.id,
      md5(v_queue.id::text || ':' || v_queue.patch_fingerprint || ':' || v_outcome) ||
        md5('m15-validation:' || v_queue.id::text || ':' || v_queue.patch_fingerprint || ':' || v_outcome),
      jsonb_build_object('outcome',v_outcome,'attempt',v_queue.attempt_count)
    from public.remediation_proposals proposal
    join public.preflight_runs run on run.id=proposal.preflight_run_id and run.workspace_id=proposal.workspace_id
    where proposal.id=v_queue.remediation_proposal_id and proposal.workspace_id=v_queue.workspace_id
    on conflict (workspace_id,event_kind,dedupe_key) do nothing;
  end if;
end;
$$;
