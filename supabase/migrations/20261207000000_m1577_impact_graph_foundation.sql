-- M15.77: versioned, temporal and explainable Product Impact Graph foundation.
-- Graph evidence references canonical M15.75/M15.76 rows; it never stores source bodies.

create table public.impact_graph_builds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null,
  repository_id uuid not null,
  workspace_dependency_id uuid not null,
  source_change_id uuid not null references public.source_changes(id) on delete restrict,
  route_intent_id uuid not null references public.intelligence_route_intents(id) on delete restrict,
  intelligence_decision_id uuid not null references public.change_intelligence_decisions(id) on delete restrict,
  analysis_run_id uuid not null,
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{40,64}$'),
  analyzer_version text not null check (char_length(analyzer_version) between 1 and 80),
  analysis_profile text not null check (char_length(analysis_profile) between 1 and 80),
  graph_builder_version text not null check (char_length(graph_builder_version) between 1 and 80),
  policy_version text not null check (char_length(policy_version) between 1 and 80),
  coverage_state text not null check (coverage_state in ('complete','partial','unsupported','failed')),
  coverage_truth text not null check (coverage_truth in ('FULL_SUPPORTED_PROFILE','PARTIAL_SUPPORTED_PROFILE','UNSUPPORTED_LANGUAGE_PRESENT','DETERMINISTIC_BOUND_REACHED','FAILED')),
  assessment_state text not null default 'unknown_incomplete' check (assessment_state in ('evidence_present','absence_observed','unknown_incomplete','failed')),
  production_exposure_state text not null default 'unknown' check (production_exposure_state in ('proven','disproven','unknown')),
  production_evidence_id uuid,
  status text not null default 'queued' check (status in ('queued','building','completed','failed')),
  build_generation bigint generated always as identity unique,
  expected_node_count integer not null default 0 check (expected_node_count >= 0),
  expected_edge_count integer not null default 0 check (expected_edge_count >= 0),
  claim_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count between 0 and 8),
  failure_category text check (failure_category is null or failure_category ~ '^[a-z0-9_]{1,80}$'),
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 200),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint impact_graph_build_product_fkey foreign key(product_id,workspace_id)
    references public.workspace_products(id,workspace_id) on delete cascade,
  constraint impact_graph_build_repository_fkey foreign key(repository_id,workspace_id)
    references public.repositories(id,workspace_id) on delete cascade,
  constraint impact_graph_build_dependency_fkey foreign key(workspace_dependency_id,workspace_id,product_id)
    references public.workspace_dependencies(id,workspace_id,protected_product_id) on delete cascade,
  constraint impact_graph_build_analysis_fkey foreign key(analysis_run_id,workspace_id,repository_id,commit_sha)
    references public.code_analysis_runs(id,workspace_id,repository_id,commit_sha) on delete cascade,
  constraint impact_graph_build_handoff_fkey foreign key(route_intent_id,product_id,repository_id,commit_sha)
    references public.code_analysis_route_handoffs(route_intent_id,product_id,repository_id,commit_sha) on delete cascade,
  constraint impact_graph_build_identity_key unique
    (source_change_id,route_intent_id,analysis_run_id,product_id,repository_id,graph_builder_version),
  constraint impact_graph_build_id_analysis_key unique(id,analysis_run_id),
  constraint impact_graph_build_id_workspace_key unique(id,workspace_id),
  constraint impact_graph_build_scope_key unique(id,source_change_id,product_id,repository_id,commit_sha),
  constraint impact_graph_build_lease_pair check (
    (claim_token is null and lease_expires_at is null)
    or (claim_token is not null and lease_expires_at is not null)
  ),
  constraint impact_graph_build_terminal_time check (
    (status in ('completed','failed') and completed_at is not null)
    or (status in ('queued','building') and completed_at is null)
  ),
  constraint impact_graph_build_production_evidence check (
    production_exposure_state='unknown' and production_evidence_id is null
  )
);
create index impact_graph_builds_lookup_idx
  on public.impact_graph_builds(workspace_id,product_id,source_change_id,created_at desc);
create index impact_graph_builds_recovery_idx
  on public.impact_graph_builds(status,lease_expires_at,created_at)
  where status in ('queued','building');

create unique index code_relations_id_analysis_key
  on public.code_relations(id,analysis_run_id);
create unique index code_external_references_id_analysis_key
  on public.code_external_references(id,analysis_run_id);

create table public.impact_graph_nodes (
  id uuid primary key default gen_random_uuid(),
  graph_build_id uuid not null references public.impact_graph_builds(id) on delete cascade,
  workspace_id uuid not null,
  node_type text not null check (node_type in (
    'provider','provider_change','dependency','api','endpoint','sdk_package','sdk_symbol','event',
    'schema','auth_scope','product','repository','commit','file','module','code_symbol','environment_variable','workflow'
  )),
  identity_key text not null check (identity_key ~ '^[a-f0-9]{64}$'),
  normalized_label text not null check (char_length(normalized_label) between 1 and 512),
  repository_id uuid,
  commit_sha text check (commit_sha is null or commit_sha ~ '^[a-f0-9]{40,64}$'),
  path text check (path is null or (char_length(path) between 1 and 1024 and path !~ '(^/|(^|/)\.\.(/|$))')),
  analysis_run_id uuid not null,
  code_entity_id uuid,
  code_reference_id uuid,
  created_at timestamptz not null default now(),
  constraint impact_graph_nodes_workspace_fkey foreign key(graph_build_id,workspace_id)
    references public.impact_graph_builds(id,workspace_id) on delete cascade,
  constraint impact_graph_nodes_repository_fkey foreign key(repository_id,workspace_id)
    references public.repositories(id,workspace_id) on delete cascade,
  constraint impact_graph_nodes_build_fkey foreign key(graph_build_id,analysis_run_id)
    references public.impact_graph_builds(id,analysis_run_id) on delete cascade,
  constraint impact_graph_nodes_entity_fkey foreign key(code_entity_id,analysis_run_id)
    references public.code_entities(id,analysis_run_id) on delete cascade,
  constraint impact_graph_nodes_reference_fkey foreign key(code_reference_id,analysis_run_id)
    references public.code_external_references(id,analysis_run_id) on delete cascade,
  constraint impact_graph_nodes_identity_key unique(graph_build_id,node_type,identity_key),
  constraint impact_graph_nodes_id_build_key unique(id,graph_build_id),
  constraint impact_graph_nodes_commit_pair check ((repository_id is null)=(commit_sha is null))
);

create table public.impact_graph_edges (
  id uuid primary key default gen_random_uuid(),
  graph_build_id uuid not null,
  workspace_id uuid not null,
  analysis_run_id uuid not null,
  source_change_id uuid not null references public.source_changes(id) on delete restrict,
  product_id uuid not null,
  repository_id uuid not null,
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{40,64}$'),
  from_node_id uuid not null,
  to_node_id uuid not null,
  edge_type text not null check (edge_type in (
    'CHANGE_AFFECTS_DEPENDENCY','CHANGE_AFFECTS_API','CHANGE_AFFECTS_ENDPOINT',
    'CHANGE_AFFECTS_SDK','CHANGE_AFFECTS_EVENT','CHANGE_AFFECTS_SCHEMA','REFERENCES_EXTERNAL','PROVIDER_HAS_DEPENDENCY',
    'PRODUCT_PROTECTS_DEPENDENCY','PRODUCT_USES_REPOSITORY','REPOSITORY_CONTAINS_COMMIT',
    'COMMIT_CONTAINS_FILE','FILE_CONTAINS_SYMBOL','IMPORTS_PACKAGE','IMPORTS_SYMBOL',
    'CALLS_SYMBOL','CALLS_ENDPOINT','HANDLES_EVENT','USES_ENV_NAME','REFERENCES_SCHEMA',
    'CODE_EXPOSED_TO_CHANGE','PRODUCT_POTENTIALLY_AFFECTED_BY_CHANGE'
  )),
  edge_kind text not null check (edge_kind in ('observed','inferred')),
  evidence_type text not null check (evidence_type in (
    'code_relation','external_reference','dependency_mapping','intelligence_decision','coverage','code_entity','analysis_identity'
  )),
  code_relation_id uuid,
  code_reference_id uuid,
  evidence_chain jsonb not null default '[]'::jsonb check (
    jsonb_typeof(evidence_chain)='array' and octet_length(evidence_chain::text)<=4096
  ),
  evidence_path text check (evidence_path is null or (char_length(evidence_path) between 1 and 1024 and evidence_path !~ '(^/|(^|/)\.\.(/|$))')),
  evidence_start_line integer check (evidence_start_line is null or evidence_start_line>0),
  evidence_start_column integer check (evidence_start_column is null or evidence_start_column>0),
  evidence_end_line integer check (evidence_end_line is null or evidence_end_line>0),
  evidence_end_column integer check (evidence_end_column is null or evidence_end_column>0),
  classifier_decision_id uuid references public.change_intelligence_decisions(id) on delete restrict,
  policy_version text not null check (char_length(policy_version) between 1 and 80),
  graph_builder_version text not null check (char_length(graph_builder_version) between 1 and 80),
  confidence_class text not null check (confidence_class in ('exact','structural','heuristic')),
  edge_fingerprint text not null check (edge_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  constraint impact_graph_edges_build_fkey foreign key(graph_build_id,workspace_id)
    references public.impact_graph_builds(id,workspace_id) on delete cascade,
  constraint impact_graph_edges_analysis_fkey foreign key(graph_build_id,analysis_run_id)
    references public.impact_graph_builds(id,analysis_run_id) on delete cascade,
  constraint impact_graph_edges_scope_fkey foreign key(graph_build_id,source_change_id,product_id,repository_id,commit_sha)
    references public.impact_graph_builds(id,source_change_id,product_id,repository_id,commit_sha) on delete cascade,
  constraint impact_graph_edges_from_node_fkey foreign key(from_node_id,graph_build_id)
    references public.impact_graph_nodes(id,graph_build_id) on delete cascade,
  constraint impact_graph_edges_to_node_fkey foreign key(to_node_id,graph_build_id)
    references public.impact_graph_nodes(id,graph_build_id) on delete cascade,
  constraint impact_graph_edges_relation_fkey foreign key(code_relation_id,analysis_run_id)
    references public.code_relations(id,analysis_run_id) on delete cascade,
  constraint impact_graph_edges_reference_fkey foreign key(code_reference_id,analysis_run_id)
    references public.code_external_references(id,analysis_run_id) on delete cascade,
  constraint impact_graph_edges_evidence_shape check (
    (edge_kind='observed' and evidence_type='code_relation' and code_relation_id is not null)
    or (edge_kind='observed' and evidence_type='external_reference' and code_reference_id is not null)
    or (edge_kind='observed' and evidence_type in ('dependency_mapping','code_entity','analysis_identity')
      and jsonb_array_length(evidence_chain)>0)
    or (edge_kind='inferred' and evidence_type in ('dependency_mapping','intelligence_decision','coverage')
      and jsonb_array_length(evidence_chain)>0)
  ),
  constraint impact_graph_edges_span_pair check (
    (evidence_start_line is null and evidence_start_column is null and evidence_end_line is null and evidence_end_column is null)
    or (evidence_path is not null and evidence_start_line is not null and evidence_end_line is not null
      and evidence_end_line>=evidence_start_line)
  ),
  constraint impact_graph_edges_temporal_check check (valid_until is null or valid_until>=valid_from),
  constraint impact_graph_edges_identity_key unique(graph_build_id,edge_type,edge_fingerprint)
);
create index impact_graph_edges_history_idx
  on public.impact_graph_edges(workspace_id,source_change_id,product_id,repository_id,valid_from desc);

create function private.set_impact_graph_edge_valid_from()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  select build.created_at into new.valid_from
    from public.impact_graph_builds build
    where build.id=new.graph_build_id and build.workspace_id=new.workspace_id;
  if not found then raise exception 'Impact graph build scope missing' using errcode='23503'; end if;
  return new;
end;
$$;
revoke all on function private.set_impact_graph_edge_valid_from() from public,anon,authenticated;
create trigger impact_graph_edges_set_valid_from
  before insert or update on public.impact_graph_edges
  for each row execute function private.set_impact_graph_edge_valid_from();

create function public.claim_impact_graph_build(
  p_route_intent_id uuid,p_analysis_run_id uuid,p_product_id uuid,p_repository_id uuid,
  p_graph_builder_version text default 'impact-graph-v1'
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_handoff public.code_analysis_route_handoffs%rowtype;
  v_intent public.intelligence_route_intents%rowtype;
  v_run public.code_analysis_runs%rowtype;
  v_product public.workspace_products%rowtype;
  v_build public.impact_graph_builds%rowtype;
  v_workspace_dependency_id uuid;
  v_token uuid:=gen_random_uuid();
  v_key text;
begin
  if p_graph_builder_version is null or char_length(p_graph_builder_version) not between 1 and 80 then
    raise exception 'Impact graph builder version is invalid' using errcode='22023';
  end if;
  select * into v_intent from public.intelligence_route_intents where id=p_route_intent_id;
  if not found or v_intent.policy_state not in ('continue_candidate','escalate','insufficient_evidence') or not (
    (v_intent.route='deprecation' and v_intent.route_target='dependency_product_impact') or
    (v_intent.route='breaking_api_change' and v_intent.route_target='dependency_impact_repository_exposure_candidate') or
    (v_intent.route='auth_or_security_change' and v_intent.route_target='integration_auth_risk_analysis') or
    (v_intent.route='schema_or_contract_change' and v_intent.route_target='contract_exposure_analysis') or
    (v_intent.route='sdk_change' and v_intent.route_target='repository_dependency_exposure_analysis') or
    (v_intent.route='webhook_or_event_change' and v_intent.route_target='contract_repository_exposure_analysis')
  ) then
    raise exception 'Impact graph route is not eligible' using errcode='22023';
  end if;
  select * into v_handoff from public.code_analysis_route_handoffs
    where route_intent_id=p_route_intent_id and analysis_run_id=p_analysis_run_id
      and product_id=p_product_id and repository_id=p_repository_id and status='completed';
  if not found then raise exception 'Completed code analysis handoff required' using errcode='22023'; end if;
  select * into v_run from public.code_analysis_runs
    where id=p_analysis_run_id and workspace_id=v_handoff.workspace_id
      and repository_id=p_repository_id and commit_sha=v_handoff.commit_sha and status='completed';
  if not found then raise exception 'Completed exact-commit analysis required' using errcode='22023'; end if;
  select * into v_product from public.workspace_products
    where id=p_product_id and workspace_id=v_handoff.workspace_id and status='protected';
  if not found or not exists (
    select 1 from public.workspace_product_repositories mapping
    where mapping.workspace_id=v_handoff.workspace_id and mapping.protected_product_id=p_product_id
      and mapping.repository_id=p_repository_id and mapping.status='active'
  ) then raise exception 'Protected Product repository mapping required' using errcode='42501'; end if;
  select dependency.id into v_workspace_dependency_id
    from public.source_changes change
    join public.source_catalog source on source.id=change.source_id
    join public.workspace_dependencies dependency on dependency.dependency_id=source.dependency_id
      and dependency.workspace_id=v_handoff.workspace_id and dependency.protected_product_id=p_product_id
      and dependency.monitoring_enabled=true
    where change.id=v_intent.source_change_id;
  if v_workspace_dependency_id is null then
    raise exception 'Active Product dependency mapping required' using errcode='42501';
  end if;
  if v_intent.workspace_id is not null and v_intent.workspace_id<>v_handoff.workspace_id then
    raise exception 'Route workspace does not match handoff' using errcode='42501';
  end if;
  v_key := 'impact-graph-v1:' || md5(concat_ws('|',v_intent.source_change_id,p_route_intent_id,
    v_intent.intelligence_decision_id,v_intent.policy_version,p_analysis_run_id,p_product_id,p_repository_id,p_graph_builder_version));
  insert into public.impact_graph_builds(
    workspace_id,product_id,repository_id,source_change_id,route_intent_id,intelligence_decision_id,
    analysis_run_id,commit_sha,analyzer_version,analysis_profile,graph_builder_version,policy_version,
    workspace_dependency_id,coverage_state,coverage_truth,assessment_state,idempotency_key
  ) values (
    v_handoff.workspace_id,p_product_id,p_repository_id,v_intent.source_change_id,p_route_intent_id,
    v_intent.intelligence_decision_id,p_analysis_run_id,v_run.commit_sha,v_run.analyzer_version,
    v_run.analysis_profile,p_graph_builder_version,v_intent.policy_version,v_workspace_dependency_id,v_run.coverage_state,
    case when v_run.status='failed' or v_run.coverage_state='failed' then 'FAILED'
      when coalesce((select v_run.supported_files_skipped_by_bound),0)>0 then 'DETERMINISTIC_BOUND_REACHED'
      when coalesce((select v_run.unsupported_language_files),0)>0 or v_run.coverage_state='unsupported' then 'UNSUPPORTED_LANGUAGE_PRESENT'
      -- Older profiles did not classify every common source extension as
      -- unsupported. They remain reusable positive evidence, but cannot assert
      -- a complete negative scan under the expanded M15.77 coverage contract.
      when v_run.coverage_state='complete' and v_run.analysis_profile='javascript-typescript-v2.3' then 'FULL_SUPPORTED_PROFILE'
      else 'PARTIAL_SUPPORTED_PROFILE' end,
    'unknown_incomplete',v_key
  ) on conflict (source_change_id,route_intent_id,analysis_run_id,product_id,repository_id,graph_builder_version) do nothing;
  select * into v_build from public.impact_graph_builds where idempotency_key=v_key for update;
  if v_build.status='completed' then
    return jsonb_build_object('status','completed','replayed',true,'graphBuildId',v_build.id);
  end if;
  if v_build.status='building' and v_build.lease_expires_at>now() then
    return jsonb_build_object('status','busy','replayed',true,'graphBuildId',v_build.id);
  end if;
  if v_build.attempt_count>=8 then raise exception 'Impact graph build attempts exhausted' using errcode='54000'; end if;
  update public.impact_graph_builds set status='building',claim_token=v_token,
    lease_expires_at=now()+interval '10 minutes',attempt_count=attempt_count+1,completed_at=null
    where id=v_build.id returning * into v_build;
  return jsonb_build_object('status','claimed','replayed',false,'graphBuildId',v_build.id,
    'claimToken',v_token,'workspaceId',v_build.workspace_id,'productId',v_build.product_id,
    'repositoryId',v_build.repository_id,'sourceChangeId',v_build.source_change_id,
    'workspaceDependencyId',v_build.workspace_dependency_id,
    'decisionId',v_build.intelligence_decision_id,'analysisRunId',v_build.analysis_run_id,
    'commitSha',v_build.commit_sha,'coverageState',v_build.coverage_state,
    'graphBuilderVersion',v_build.graph_builder_version,
    'coverageTruth',v_build.coverage_truth,'policyVersion',v_build.policy_version,
    'route',v_intent.route,'routeTarget',v_intent.route_target);
end;
$$;

create function public.complete_impact_graph_build(
  p_graph_build_id uuid,p_claim_token uuid,p_expected_nodes integer,p_expected_edges integer,
  p_assessment_state text
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_build public.impact_graph_builds%rowtype;
  v_nodes integer;
  v_edges integer;
  v_completed_at timestamptz;
  v_newer_completed_at timestamptz;
begin
  if p_expected_nodes<0 or p_expected_edges<0 or p_assessment_state not in
    ('evidence_present','absence_observed','unknown_incomplete') then
    raise exception 'Impact graph completion input invalid' using errcode='22023';
  end if;
  select * into v_build from public.impact_graph_builds where id=p_graph_build_id for update;
  if not found then raise exception 'Impact graph build missing' using errcode='P0002'; end if;
  if v_build.status='completed' then
    return v_build.expected_node_count=p_expected_nodes and v_build.expected_edge_count=p_expected_edges;
  end if;
  if v_build.status<>'building' or v_build.claim_token<>p_claim_token then
    raise exception 'Impact graph claim is no longer current' using errcode='40001';
  end if;
  -- Serialize completion for a source change. A stale build may finish after a
  -- newer generation; the row lock makes the latest completed generation
  -- authoritative regardless of worker timing.
  perform 1 from public.source_changes where id=v_build.source_change_id for update;
  select count(*)::integer into v_nodes from public.impact_graph_nodes where graph_build_id=p_graph_build_id;
  select count(*)::integer into v_edges from public.impact_graph_edges where graph_build_id=p_graph_build_id;
  if v_nodes<>p_expected_nodes or v_edges<>p_expected_edges then
    raise exception 'Impact graph persistence integrity failed' using errcode='23514';
  end if;
  if p_assessment_state='absence_observed' and v_build.coverage_truth<>'FULL_SUPPORTED_PROFILE' then
    raise exception 'Incomplete graph coverage cannot assert absence' using errcode='23514';
  end if;
  select newer.completed_at into v_newer_completed_at
    from public.impact_graph_builds newer
    where newer.workspace_id=v_build.workspace_id and newer.product_id=v_build.product_id
      and newer.repository_id=v_build.repository_id and newer.source_change_id=v_build.source_change_id
      and newer.status='completed' and newer.build_generation>v_build.build_generation
    order by newer.build_generation desc limit 1;
  v_completed_at := clock_timestamp();
  if v_newer_completed_at is not null then
    update public.impact_graph_edges current_edges set valid_until=v_newer_completed_at
      where current_edges.graph_build_id=p_graph_build_id and current_edges.valid_until is null;
  else
    update public.impact_graph_edges previous set valid_until=v_completed_at
      where previous.workspace_id=v_build.workspace_id and previous.product_id=v_build.product_id
        and previous.repository_id=v_build.repository_id and previous.source_change_id=v_build.source_change_id
        and previous.graph_build_id<>p_graph_build_id and previous.valid_until is null
        and exists (
          select 1 from public.impact_graph_builds previous_build
          where previous_build.id=previous.graph_build_id
            and previous_build.build_generation<v_build.build_generation
        );
  end if;
  update public.impact_graph_builds set status='completed',assessment_state=p_assessment_state,
    expected_node_count=p_expected_nodes,expected_edge_count=p_expected_edges,
    claim_token=null,lease_expires_at=null,completed_at=v_completed_at
    where id=p_graph_build_id;
  return true;
end;
$$;

create function public.release_impact_graph_build(p_graph_build_id uuid,p_claim_token uuid,p_failure_category text)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_failure_category is null or p_failure_category !~ '^[a-z0-9_]{1,80}$' then
    raise exception 'Impact graph failure category invalid' using errcode='22023';
  end if;
  update public.impact_graph_builds set status='queued',claim_token=null,lease_expires_at=null,
    failure_category=p_failure_category
  where id=p_graph_build_id and status='building' and claim_token=p_claim_token;
  return found;
end;
$$;

alter table public.impact_graph_builds enable row level security;
alter table public.impact_graph_nodes enable row level security;
alter table public.impact_graph_edges enable row level security;
revoke all on public.impact_graph_builds,public.impact_graph_nodes,public.impact_graph_edges
  from public,anon,authenticated;
grant select,insert,update,delete on public.impact_graph_builds,public.impact_graph_nodes,public.impact_graph_edges to service_role;
revoke all on function public.claim_impact_graph_build(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.complete_impact_graph_build(uuid,uuid,integer,integer,text) from public,anon,authenticated;
revoke all on function public.release_impact_graph_build(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_impact_graph_build(uuid,uuid,uuid,uuid,text) to service_role;
grant execute on function public.complete_impact_graph_build(uuid,uuid,integer,integer,text) to service_role;
grant execute on function public.release_impact_graph_build(uuid,uuid,text) to service_role;
