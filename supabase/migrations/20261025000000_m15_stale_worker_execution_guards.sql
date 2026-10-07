-- Reject persisted work whose Preflight/proposal is no longer the current
-- canonical basis for the same customer risk and repository.

create or replace function public.claim_remediation_preparation(p_queue_id uuid,p_attempt integer)
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
      and not exists (
        select 1 from public.preflight_runs newer
        where newer.workspace_id=run.workspace_id
          and newer.impact_assessment_id=run.impact_assessment_id
          and (newer.created_at,newer.id)>(run.created_at,run.id)
          and newer.status in ('completed','partial')
      )
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

create or replace function public.claim_remediation_validation(p_queue_id uuid,p_attempt integer)
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
      and not exists (
        select 1 from public.preflight_runs newer_run
        where newer_run.workspace_id=run.workspace_id
          and newer_run.impact_assessment_id=run.impact_assessment_id
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
