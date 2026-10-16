-- M15.78 Fix Engine V1. Canonical records contain bounded metadata only;
-- patch/source bodies live in the private fix-engine-artifacts Storage bucket.

create extension if not exists pgcrypto with schema extensions;

create unique index workspace_product_repositories_fix_scope_key
  on public.workspace_product_repositories(id,workspace_id,protected_product_id,repository_id);

create table public.fix_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null,
  repository_id uuid not null,
  workspace_dependency_id uuid not null,
  product_repository_mapping_id uuid not null,
  provider_repository_identity text not null check (char_length(provider_repository_identity) between 3 and 511),
  source_change_id uuid not null references public.source_changes(id) on delete restrict,
  classification_id uuid not null references public.source_change_classifications(id) on delete restrict,
  source_mode text not null check (source_mode in ('provider','internal_test')),
  processing_mode text not null check (processing_mode in ('customer','evidence_only')),
  intelligence_decision_id uuid not null references public.change_intelligence_decisions(id) on delete restrict,
  route_intent_id uuid not null references public.intelligence_route_intents(id) on delete restrict,
  semantic_route text not null check (char_length(semantic_route) between 1 and 80),
  route_target text not null check (char_length(route_target) between 1 and 120),
  analysis_run_id uuid not null,
  graph_build_id uuid not null,
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{40,64}$'),
  analyzer_version text not null check (char_length(analyzer_version) between 1 and 80),
  analysis_profile text not null check (char_length(analysis_profile) between 1 and 80),
  graph_builder_version text not null check (char_length(graph_builder_version) between 1 and 80),
  policy_version text not null check (char_length(policy_version) between 1 and 80),
  review_disposition text not null check (review_disposition in ('none','review_required')),
  review_reason text check (review_reason is null or char_length(review_reason) between 1 and 80),
  provenance_mode text not null check (provenance_mode in ('customer','evidence_only')),
  positive_graph_evidence_ids uuid[] not null check (cardinality(positive_graph_evidence_ids) > 0),
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[a-f0-9]{64}$'),
  identity_document jsonb not null check (jsonb_typeof(identity_document)='object' and octet_length(identity_document::text)<=32768),
  identity_fingerprint text not null check (identity_fingerprint ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null unique check (idempotency_key ~ '^[a-f0-9]{64}$'),
  contract_version text not null check (char_length(contract_version) between 1 and 80),
  eligibility_rules_version text not null check (char_length(eligibility_rules_version) between 1 and 80),
  draft_pr_policy_allowed boolean not null default false,
  preflight_required boolean not null default false,
  status text not null default 'queued' check (status in (
    'queued','diagnosing','planning','generating_patch','applying_patch','validating',
    'preflight_pending','risk_assessing','ready_for_pr','creating_pr','pr_created',
    'candidate_validated','diagnosis_failed','plan_failed','patch_failed','patch_conflict',
    'validation_failed','preflight_failed','risk_blocked','stale_base','cancelled','failed','completed'
  )),
  current_stage text not null default 'diagnose' check (current_stage in (
    'diagnose','plan','generate_patch','apply_patch','verify_patch','preflight','risk_assess','create_draft_pr'
  )),
  risk_level text check (risk_level is null or risk_level in ('LOW','MEDIUM','HIGH','BLOCKED')),
  production_exposure_state text not null default 'unknown' check (production_exposure_state='unknown'),
  failure_category text check (failure_category is null or failure_category ~ '^[a-z0-9_]{1,100}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint fix_run_provenance_pair check (
    (source_mode='provider' and processing_mode='customer' and provenance_mode='customer') or
    (source_mode='internal_test' and processing_mode='evidence_only' and provenance_mode='evidence_only')
  ),
  constraint fix_run_product_scope_fkey foreign key(product_id,workspace_id)
    references public.workspace_products(id,workspace_id) on delete cascade,
  constraint fix_run_repository_scope_fkey foreign key(repository_id,workspace_id)
    references public.repositories(id,workspace_id) on delete cascade,
  constraint fix_run_dependency_scope_fkey foreign key(workspace_dependency_id,workspace_id,product_id)
    references public.workspace_dependencies(id,workspace_id,protected_product_id) on delete restrict,
  constraint fix_run_mapping_scope_fkey foreign key(product_repository_mapping_id,workspace_id,product_id,repository_id)
    references public.workspace_product_repositories(id,workspace_id,protected_product_id,repository_id) on delete restrict,
  constraint fix_run_graph_scope_fkey foreign key(graph_build_id,source_change_id,product_id,repository_id,commit_sha)
    references public.impact_graph_builds(id,source_change_id,product_id,repository_id,commit_sha) on delete restrict,
  constraint fix_run_graph_workspace_fkey foreign key(graph_build_id,workspace_id)
    references public.impact_graph_builds(id,workspace_id) on delete restrict,
  constraint fix_run_analysis_scope_fkey foreign key(analysis_run_id,workspace_id,repository_id,commit_sha)
    references public.code_analysis_runs(id,workspace_id,repository_id,commit_sha) on delete restrict,
  constraint fix_run_review_pair check ((review_disposition='none' and review_reason is null) or review_disposition='review_required')
);
alter table public.fix_runs add constraint fix_run_id_workspace_key unique(id,workspace_id);
alter table public.fix_runs add constraint fix_run_frozen_input_key unique(id,graph_build_id,analysis_run_id,repository_id,commit_sha);
alter table public.fix_runs add constraint fix_run_classification_source_fkey
  foreign key(classification_id,source_change_id) references public.source_change_classifications(id,change_id) on delete restrict;
create index fix_runs_workspace_recent_idx on public.fix_runs(workspace_id,created_at desc);
create index fix_runs_graph_idx on public.fix_runs(graph_build_id,created_at desc);

create table public.fix_model_attempts (
  id uuid primary key default gen_random_uuid(),
  fix_run_id uuid not null,
  workspace_id uuid not null,
  stage text not null check (stage in ('diagnose','plan','generate_patch')),
  attempt_number integer not null check (attempt_number between 1 and 3),
  provider text not null check (provider ~ '^[a-zA-Z0-9._:-]{1,80}$'),
  model text not null check (char_length(model) between 1 and 160),
  model_version text check (model_version is null or char_length(model_version)<=160),
  schema_version text not null check (char_length(schema_version) between 1 and 80),
  prompt_contract_version text not null check (char_length(prompt_contract_version) between 1 and 80),
  status text not null check (status in ('started','succeeded','failed','ambiguous')),
  input_fingerprint text not null check (input_fingerprint ~ '^[a-f0-9]{64}$'),
  output_fingerprint text check (output_fingerprint is null or output_fingerprint ~ '^[a-f0-9]{64}$'),
  latency_ms integer check (latency_ms is null or latency_ms between 0 and 3600000),
  input_tokens integer check (input_tokens is null or input_tokens>=0),
  output_tokens integer check (output_tokens is null or output_tokens>=0),
  cost_microusd bigint check (cost_microusd is null or cost_microusd>=0),
  failure_category text check (failure_category is null or failure_category ~ '^[a-z0-9_]{1,100}$'),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint fix_model_attempt_run_scope_fkey foreign key(fix_run_id,workspace_id)
    references public.fix_runs(id,workspace_id) on delete cascade,
  constraint fix_model_attempt_identity unique(fix_run_id,stage,attempt_number),
  constraint fix_model_attempt_terminal_time check ((status='started')=(completed_at is null))
);
create index fix_model_attempt_run_idx on public.fix_model_attempts(fix_run_id,created_at);

create table public.fix_stage_queue (
  id uuid primary key default gen_random_uuid(),
  fix_run_id uuid not null,
  workspace_id uuid not null,
  stage text not null check (stage in ('diagnose','plan','generate_patch','apply_patch','verify_patch','preflight','risk_assess','create_draft_pr')),
  status text not null default 'queued' check (status in ('queued','claimed','completed','failed','cancelled')),
  idempotency_key text not null unique check (idempotency_key ~ '^[a-f0-9]{64}$'),
  attempt_count integer not null default 0 check (attempt_count between 0 and 3),
  claim_token uuid,
  lease_expires_at timestamptz,
  failure_category text check (failure_category is null or failure_category ~ '^[a-z0-9_]{1,100}$'),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint fix_stage_run_scope_fkey foreign key(fix_run_id,workspace_id)
    references public.fix_runs(id,workspace_id) on delete cascade,
  constraint fix_stage_identity unique(fix_run_id,stage),
  constraint fix_stage_claim_pair check ((claim_token is null)=(lease_expires_at is null)),
  constraint fix_stage_terminal_time check ((status in ('completed','failed','cancelled'))=(completed_at is not null))
);
create index fix_stage_queue_ready_idx on public.fix_stage_queue(status,lease_expires_at,created_at) where status in ('queued','claimed');

create table public.fix_diagnoses (
  id uuid primary key default gen_random_uuid(), fix_run_id uuid not null, workspace_id uuid not null,
  graph_build_id uuid not null, analysis_run_id uuid not null, repository_id uuid not null,
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{40,64}$'), semantic_route text not null,
  change_family text not null, diagnosis jsonb not null check (jsonb_typeof(diagnosis)='object' and octet_length(diagnosis::text)<=24000),
  evidence_ids uuid[] not null check (cardinality(evidence_ids)>0),
  provider text not null, model text not null, model_version text, schema_version text not null,
  prompt_contract_version text not null, input_fingerprint text not null check (input_fingerprint ~ '^[a-f0-9]{64}$'),
  output_fingerprint text not null check (output_fingerprint ~ '^[a-f0-9]{64}$'),
  latency_ms integer check (latency_ms is null or latency_ms between 0 and 3600000),
  input_tokens integer check (input_tokens is null or input_tokens>=0), output_tokens integer check (output_tokens is null or output_tokens>=0),
  cost_microusd bigint check (cost_microusd is null or cost_microusd>=0), created_at timestamptz not null default now(),
  constraint fix_diagnosis_run_unique unique(fix_run_id),
  constraint fix_diagnosis_run_scope_fkey foreign key(fix_run_id,workspace_id) references public.fix_runs(id,workspace_id) on delete cascade,
  constraint fix_diagnosis_graph_scope_fkey foreign key(graph_build_id,workspace_id) references public.impact_graph_builds(id,workspace_id) on delete restrict,
  constraint fix_diagnosis_frozen_input_fkey foreign key(fix_run_id,graph_build_id,analysis_run_id,repository_id,commit_sha)
    references public.fix_runs(id,graph_build_id,analysis_run_id,repository_id,commit_sha) on delete cascade,
  constraint fix_diagnosis_analysis_scope_fkey foreign key(analysis_run_id,workspace_id,repository_id,commit_sha) references public.code_analysis_runs(id,workspace_id,repository_id,commit_sha) on delete restrict
);

create table public.fix_plans (
  id uuid primary key default gen_random_uuid(), fix_run_id uuid not null, workspace_id uuid not null,
  plan_version integer not null check (plan_version>0), plan jsonb not null check (jsonb_typeof(plan)='object' and octet_length(plan::text)<=32000),
  plan_fingerprint text not null check (plan_fingerprint ~ '^[a-f0-9]{64}$'), provider text not null, model text not null,
  schema_version text not null, prompt_contract_version text not null, created_at timestamptz not null default now(),
  constraint fix_plan_version_unique unique(fix_run_id,plan_version), constraint fix_plan_run_fingerprint_unique unique(fix_run_id,plan_fingerprint),
  constraint fix_plan_id_run_key unique(id,fix_run_id),
  constraint fix_plan_run_scope_fkey foreign key(fix_run_id,workspace_id) references public.fix_runs(id,workspace_id) on delete cascade
);

create table public.fix_patches (
  id uuid primary key default gen_random_uuid(), fix_run_id uuid not null, workspace_id uuid not null,
  plan_id uuid not null, attempt_number integer not null check (attempt_number between 1 and 3),
  base_sha text not null check (base_sha ~ '^[a-f0-9]{40,64}$'), patch_fingerprint text not null check (patch_fingerprint ~ '^[a-f0-9]{64}$'),
  artifact_bucket text not null default 'fix-engine-artifacts' check (artifact_bucket='fix-engine-artifacts'),
  artifact_path text not null check (artifact_path ~ ('^'||fix_run_id::text||'/[0-9a-f-]{36}\.diff$')),
  changed_paths text[] not null check (cardinality(changed_paths) between 1 and 25), line_count integer not null check (line_count between 1 and 2000),
  byte_count integer not null check (byte_count between 1 and 131072), status text not null check (status in ('proposed','validated','applied','rejected','conflict')),
  provider text not null, model text not null, created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '30 days',
  artifact_purge_claimed_until timestamptz, artifact_purged_at timestamptz,
  constraint fix_patch_attempt_unique unique(fix_run_id,attempt_number), constraint fix_patch_fingerprint_unique unique(fix_run_id,patch_fingerprint),
  constraint fix_patch_id_run_key unique(id,fix_run_id),
  constraint fix_patch_run_scope_fkey foreign key(fix_run_id,workspace_id) references public.fix_runs(id,workspace_id) on delete cascade,
  constraint fix_patch_plan_scope_fkey foreign key(plan_id,fix_run_id) references public.fix_plans(id,fix_run_id) on delete restrict
);

create table public.fix_verification_runs (
  id uuid primary key default gen_random_uuid(), fix_run_id uuid not null, workspace_id uuid not null, patch_id uuid not null,
  profile_id text not null check (char_length(profile_id) between 1 and 80), status text not null check (status in ('passed','failed','unsupported')),
  checks jsonb not null check (jsonb_typeof(checks)='array' and octet_length(checks::text)<=24000),
  diagnostic_summary text not null default '' check (octet_length(diagnostic_summary)<=4000), duration_ms integer not null check (duration_ms between 0 and 3600000),
  patch_fingerprint text not null check (patch_fingerprint ~ '^[a-f0-9]{64}$'),
  attempt_number integer not null check (attempt_number between 1 and 3),
  idempotency_key text not null unique check (idempotency_key ~ '^[a-f0-9]{64}$'), created_at timestamptz not null default now(),
  constraint fix_verification_run_scope_fkey foreign key(fix_run_id,workspace_id) references public.fix_runs(id,workspace_id) on delete cascade,
  constraint fix_verification_patch_fkey foreign key(patch_id,fix_run_id) references public.fix_patches(id,fix_run_id) on delete restrict
);

create table public.fix_preflight_results (
  id uuid primary key default gen_random_uuid(), fix_run_id uuid not null, workspace_id uuid not null,
  status text not null check (status in ('passed','failed','ineligible')),
  patch_id uuid not null,
  patch_fingerprint text not null check (patch_fingerprint ~ '^[a-f0-9]{64}$'),
  preflight_run_id uuid,
  failure_category text check (failure_category is null or failure_category ~ '^[a-z0-9_]{1,100}$'),
  created_at timestamptz not null default now(),
  constraint fix_preflight_one_per_run unique(fix_run_id),
  constraint fix_preflight_run_scope_fkey foreign key(fix_run_id,workspace_id) references public.fix_runs(id,workspace_id) on delete cascade,
  constraint fix_preflight_patch_scope_fkey foreign key(patch_id,fix_run_id) references public.fix_patches(id,fix_run_id) on delete restrict,
  constraint fix_preflight_evidence_scope_fkey foreign key(preflight_run_id,workspace_id) references public.preflight_runs(id,workspace_id) on delete restrict
);

create table public.fix_risk_assessments (
  id uuid primary key default gen_random_uuid(), fix_run_id uuid not null, workspace_id uuid not null,
  risk_version text not null, risk_level text not null check (risk_level in ('LOW','MEDIUM','HIGH','BLOCKED')),
  factors jsonb not null check (jsonb_typeof(factors)='array' and octet_length(factors::text)<=16000),
  review_required boolean not null, review_reason text, input_fingerprint text not null check (input_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(), constraint fix_risk_run_unique unique(fix_run_id),
  constraint fix_risk_run_scope_fkey foreign key(fix_run_id,workspace_id) references public.fix_runs(id,workspace_id) on delete cascade
);

create table public.fix_external_operations (
  id uuid primary key default gen_random_uuid(), fix_run_id uuid not null, workspace_id uuid not null,
  operation_kind text not null check (operation_kind in ('github_branch','github_commit','github_draft_pr')),
  idempotency_key text not null unique check (idempotency_key ~ '^[a-f0-9]{64}$'), status text not null check (status in ('pending','succeeded','failed','ambiguous')),
  external_id text, external_url text, request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint fix_external_op_run_scope_fkey foreign key(fix_run_id,workspace_id) references public.fix_runs(id,workspace_id) on delete cascade,
  constraint fix_external_op_scope_key unique(id,fix_run_id,workspace_id)
);

create table public.fix_pr_outcomes (
  id uuid primary key default gen_random_uuid(), fix_run_id uuid not null, workspace_id uuid not null,
  external_operation_id uuid not null unique,
  status text not null check (status in ('draft_created','reconciled_existing','failed','ambiguous')),
  branch_name text not null check (branch_name ~ '^auterim/fix/[a-f0-9]{12}$'), pull_request_url text,
  base_sha text not null check (base_sha ~ '^[a-f0-9]{40,64}$'), head_sha text check (head_sha is null or head_sha ~ '^[a-f0-9]{40,64}$'),
  merged boolean not null default false check (not merged), deployed boolean not null default false check (not deployed),
  created_at timestamptz not null default now(),
  constraint fix_pr_run_unique unique(fix_run_id),
  constraint fix_pr_run_scope_fkey foreign key(fix_run_id,workspace_id) references public.fix_runs(id,workspace_id) on delete cascade,
  constraint fix_pr_operation_scope_fkey foreign key(external_operation_id,fix_run_id,workspace_id) references public.fix_external_operations(id,fix_run_id,workspace_id) on delete restrict
);

create function private.guard_fix_run_identity()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_source public.source_changes%rowtype; v_repository public.repositories%rowtype;
begin
  if tg_op='UPDATE' then
    if row(new.workspace_id,new.product_id,new.repository_id,new.workspace_dependency_id,new.product_repository_mapping_id,
      new.provider_repository_identity,new.source_change_id,new.source_mode,new.processing_mode,new.intelligence_decision_id,
      new.classification_id,new.route_intent_id,new.semantic_route,new.route_target,new.analysis_run_id,new.graph_build_id,new.commit_sha,new.analyzer_version,new.analysis_profile,
      new.graph_builder_version,new.policy_version,new.review_disposition,new.review_reason,new.provenance_mode,
      new.positive_graph_evidence_ids,new.evidence_fingerprint,new.identity_document,new.identity_fingerprint,new.idempotency_key,
      new.contract_version,new.eligibility_rules_version,new.draft_pr_policy_allowed,new.preflight_required)
      is distinct from
      row(old.workspace_id,old.product_id,old.repository_id,old.workspace_dependency_id,old.product_repository_mapping_id,
      old.provider_repository_identity,old.source_change_id,old.source_mode,old.processing_mode,old.intelligence_decision_id,
      old.classification_id,old.route_intent_id,old.semantic_route,old.route_target,old.analysis_run_id,old.graph_build_id,old.commit_sha,old.analyzer_version,old.analysis_profile,
      old.graph_builder_version,old.policy_version,old.review_disposition,old.review_reason,old.provenance_mode,
      old.positive_graph_evidence_ids,old.evidence_fingerprint,old.identity_document,old.identity_fingerprint,old.idempotency_key,
      old.contract_version,old.eligibility_rules_version,old.draft_pr_policy_allowed,old.preflight_required)
    then raise exception 'fix_run_identity_immutable' using errcode='23514'; end if;
    return new;
  end if;
  select * into v_source from public.source_changes s where s.id=new.source_change_id
    and s.source_mode=new.source_mode and s.processing_mode=new.processing_mode
    and ((s.source_mode='provider' and s.workspace_id is null and s.scope_product_id is null)
      or (s.source_mode='internal_test' and s.workspace_id=new.workspace_id and s.scope_product_id=new.product_id));
  if not found then
    raise exception 'fix_run_source_scope_mismatch' using errcode='23514';
  end if;
  if not ((new.source_mode='provider' and new.processing_mode='customer' and new.provenance_mode='customer') or
          (new.source_mode='internal_test' and new.processing_mode='evidence_only' and new.provenance_mode='evidence_only')) then
    raise exception 'fix_run_provenance_mismatch' using errcode='23514';
  end if;
  select * into v_repository from public.repositories r where r.id=new.repository_id and r.workspace_id=new.workspace_id;
  if not found or lower(new.provider_repository_identity)<>lower(v_repository.owner||'/'||v_repository.name) then
    raise exception 'fix_run_repository_identity_mismatch' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_fix_run_identity() from public,anon,authenticated;
create trigger fix_runs_identity_guard before insert or update on public.fix_runs
  for each row execute function private.guard_fix_run_identity();

create function private.guard_fix_stage_scope()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_run public.fix_runs%rowtype;
begin
  select * into v_run from public.fix_runs r where r.id=new.fix_run_id and r.workspace_id=new.workspace_id;
  if not found then raise exception 'fix_stage_scope_mismatch' using errcode='23503'; end if;
  if v_run.provenance_mode='evidence_only' and new.stage in ('preflight','create_draft_pr') then
    raise exception 'evidence_only_stage_forbidden' using errcode='42501';
  end if;
  if new.stage in ('customer_impact','notification','remediation','deployment','billing') then
    raise exception 'fix_engine_stage_out_of_scope' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_fix_stage_scope() from public,anon,authenticated;
create trigger fix_stage_scope_guard before insert or update of fix_run_id,workspace_id,stage on public.fix_stage_queue
  for each row execute function private.guard_fix_stage_scope();

create function private.guard_fix_plan_immutable()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin raise exception 'fix_plan_immutable' using errcode='23514'; end;
$$;
revoke all on function private.guard_fix_plan_immutable() from public,anon,authenticated;
create trigger fix_plans_immutable before update or delete on public.fix_plans
  for each row execute function private.guard_fix_plan_immutable();

create function private.guard_fix_external_operation()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_run public.fix_runs%rowtype;
begin
  select * into v_run from public.fix_runs r where r.id=new.fix_run_id and r.workspace_id=new.workspace_id;
  if not found then raise exception 'fix_external_operation_scope_mismatch' using errcode='23503'; end if;
  if v_run.provenance_mode='evidence_only' then raise exception 'evidence_only_external_write_forbidden' using errcode='42501'; end if;
  if v_run.status not in ('creating_pr','ready_for_pr') or coalesce(v_run.risk_level,'BLOCKED') not in ('LOW','MEDIUM') then
    raise exception 'fix_external_operation_not_eligible' using errcode='42501';
  end if;
  if not exists(select 1 from public.workspace_products p where p.id=v_run.product_id and p.workspace_id=v_run.workspace_id and p.status='protected')
    or not exists(select 1 from public.workspace_dependencies d where d.id=v_run.workspace_dependency_id and d.workspace_id=v_run.workspace_id
      and d.protected_product_id=v_run.product_id and d.monitoring_enabled)
    or not exists(select 1 from public.workspace_product_repositories m where m.id=v_run.product_repository_mapping_id
      and m.workspace_id=v_run.workspace_id and m.protected_product_id=v_run.product_id and m.repository_id=v_run.repository_id and m.status='active')
    or not exists(select 1 from public.product_remediation_policies p where p.workspace_id=v_run.workspace_id and p.product_id=v_run.product_id
      and p.enabled and p.draft_pr_preparation_allowed and v_run.repository_id=any(p.allowed_repository_ids)) then
    raise exception 'fix_current_policy_or_scope_stale' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_fix_external_operation() from public,anon,authenticated;
create trigger fix_external_operation_guard before insert or update on public.fix_external_operations
  for each row execute function private.guard_fix_external_operation();

create function private.guard_fix_pr_outcome()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_run public.fix_runs%rowtype; v_repository public.repositories%rowtype;
begin
  select * into v_run from public.fix_runs r where r.id=new.fix_run_id and r.workspace_id=new.workspace_id;
  if not found or v_run.provenance_mode='evidence_only' then raise exception 'fix_pr_outcome_forbidden' using errcode='42501'; end if;
  if v_run.risk_level not in ('LOW','MEDIUM') or not v_run.draft_pr_policy_allowed or v_run.status not in ('creating_pr','pr_created') then
    raise exception 'fix_pr_outcome_not_eligible' using errcode='42501';
  end if;
  if not exists(select 1 from public.product_remediation_policies p where p.workspace_id=v_run.workspace_id and p.product_id=v_run.product_id
      and p.enabled and p.draft_pr_preparation_allowed and v_run.repository_id=any(p.allowed_repository_ids)) then
    raise exception 'fix_current_policy_stale' using errcode='42501';
  end if;
  select * into v_repository from public.repositories r where r.id=v_run.repository_id and r.workspace_id=v_run.workspace_id;
  if new.base_sha<>v_run.commit_sha or new.branch_name<>'auterim/fix/'||left(v_run.idempotency_key,12)
    or (new.pull_request_url is not null and (
      left(new.pull_request_url,char_length('https://github.com/'||v_repository.owner||'/'||v_repository.name||'/pull/'))
        <>'https://github.com/'||v_repository.owner||'/'||v_repository.name||'/pull/'
      or substring(new.pull_request_url from char_length('https://github.com/'||v_repository.owner||'/'||v_repository.name||'/pull/')+1) !~ '^[0-9]+$'
    )) then
    raise exception 'fix_pr_identity_mismatch' using errcode='23514';
  end if;
  if not exists(select 1 from public.fix_verification_runs v where v.fix_run_id=v_run.id and v.status='passed')
    or (v_run.preflight_required and not exists(select 1 from public.fix_preflight_results f where f.fix_run_id=v_run.id and f.status='passed')) then
    raise exception 'fix_pr_verification_incomplete' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_fix_pr_outcome() from public,anon,authenticated;
create trigger fix_pr_outcome_guard before insert or update on public.fix_pr_outcomes
  for each row execute function private.guard_fix_pr_outcome();

create function public.create_fix_run_from_graph(p_graph_build_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  g public.impact_graph_builds%rowtype; s public.source_changes%rowtype; c public.source_change_classifications%rowtype;
  r public.repositories%rowtype; p public.workspace_products%rowtype;
  d public.workspace_dependencies%rowtype; m public.workspace_product_repositories%rowtype;
  pol public.product_remediation_policies%rowtype; v_has_policy boolean:=false;
  v_evidence_ids uuid[]; v_evidence_fingerprint text; v_identity jsonb; v_hash text; v_inserted_id uuid;
  v_fix public.fix_runs%rowtype;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  select * into g from public.impact_graph_builds b where b.id=p_graph_build_id;
  if not found or g.status<>'completed' or g.assessment_state<>'evidence_present' then
    raise exception 'fix_requires_completed_positive_graph' using errcode='22023';
  end if;
  select * into s from public.source_changes x where x.id=g.source_change_id
    and ((x.source_mode='provider' and x.processing_mode='customer' and x.workspace_id is null and x.scope_product_id is null)
      or (x.source_mode='internal_test' and x.processing_mode='evidence_only' and x.workspace_id=g.workspace_id and x.scope_product_id=g.product_id));
  select * into c from public.source_change_classifications x where x.change_id=g.source_change_id and x.status='classified'
    order by x.created_at desc,x.id desc limit 1;
  select * into r from public.repositories x where x.id=g.repository_id and x.workspace_id=g.workspace_id and x.status='available' and not x.archived;
  select * into p from public.workspace_products x where x.id=g.product_id and x.workspace_id=g.workspace_id and x.status='protected';
  select * into d from public.workspace_dependencies x where x.id=g.workspace_dependency_id and x.workspace_id=g.workspace_id
    and x.protected_product_id=g.product_id and x.monitoring_enabled;
  select * into m from public.workspace_product_repositories x where x.workspace_id=g.workspace_id and x.protected_product_id=g.product_id
    and x.repository_id=g.repository_id and x.status='active';
  if not found then raise exception 'fix_protection_scope_not_active' using errcode='42501'; end if;
  select * into pol from public.product_remediation_policies x where x.workspace_id=g.workspace_id and x.product_id=g.product_id;
  v_has_policy:=found;
  if s.id is null or c.id is null or r.id is null or p.id is null or d.id is null or m.id is null then
    raise exception 'fix_evidence_scope_not_eligible' using errcode='42501';
  end if;
  if not ((s.source_mode='provider' and s.processing_mode='customer') or
          (s.source_mode='internal_test' and s.processing_mode='evidence_only' and s.workspace_id is not null and s.scope_product_id is not null)) then
    raise exception 'fix_source_provenance_invalid' using errcode='23514';
  end if;
  if g.coverage_state not in ('complete','partial') then raise exception 'fix_analysis_coverage_unsupported' using errcode='22023'; end if;
  if not exists (select 1 from public.impact_graph_edges e where e.graph_build_id=g.id and e.workspace_id=g.workspace_id
      and e.repository_id=g.repository_id and e.commit_sha=g.commit_sha and e.edge_kind='observed'
      and e.evidence_path is not null and e.evidence_start_line is not null and e.evidence_start_column is not null
      and e.evidence_end_line is not null and e.evidence_end_column is not null) then
    raise exception 'fix_requires_exact_observed_code_evidence' using errcode='22023';
  end if;
  select array_agg(e.id order by e.edge_fingerprint),
         encode(extensions.digest(convert_to(string_agg(e.edge_fingerprint,'|' order by e.edge_fingerprint),'UTF8'),'sha256'),'hex')
    into v_evidence_ids,v_evidence_fingerprint
    from public.impact_graph_edges e where e.graph_build_id=g.id and e.edge_kind='observed'
      and e.evidence_path is not null and e.evidence_start_line is not null and e.evidence_start_column is not null
      and e.evidence_end_line is not null and e.evidence_end_column is not null;
  v_identity:=jsonb_build_object(
    'workspace_id',g.workspace_id,'product_id',g.product_id,'repository_id',g.repository_id,
    'provider_repository_identity',r.owner||'/'||r.name,'workspace_dependency_id',g.workspace_dependency_id,
    'product_repository_mapping_id',m.id,'source_change_id',g.source_change_id,'classification_id',c.id,
    'source_mode',s.source_mode,'processing_mode',s.processing_mode,
    'intelligence_decision_id',g.intelligence_decision_id,'route_intent_id',g.route_intent_id,
    'semantic_route',(select i.route from public.intelligence_route_intents i where i.id=g.route_intent_id),
    'route_target',(select i.route_target from public.intelligence_route_intents i where i.id=g.route_intent_id),
    'analysis_run_id',g.analysis_run_id,'graph_build_id',g.id,'commit_sha',g.commit_sha,
    'analyzer_version',g.analyzer_version,'analysis_profile',g.analysis_profile,
    'graph_builder_version',g.graph_builder_version,'policy_version',g.policy_version,
    'review_disposition',g.review_disposition,'review_reason',g.review_reason,
    'positive_graph_evidence_ids',to_jsonb(v_evidence_ids),'evidence_fingerprint',v_evidence_fingerprint,
    'preflight_required',s.source_mode='provider',
    'contract_version','fix-engine-v1','eligibility_rules_version','fix-eligibility-v1');
  v_hash:=encode(extensions.digest(convert_to(v_identity::text,'UTF8'),'sha256'),'hex');
  insert into public.fix_runs(workspace_id,product_id,repository_id,workspace_dependency_id,product_repository_mapping_id,
    provider_repository_identity,source_change_id,classification_id,source_mode,processing_mode,intelligence_decision_id,route_intent_id,
    semantic_route,route_target,analysis_run_id,graph_build_id,commit_sha,analyzer_version,analysis_profile,graph_builder_version,policy_version,
    review_disposition,review_reason,provenance_mode,positive_graph_evidence_ids,evidence_fingerprint,identity_document,
    identity_fingerprint,idempotency_key,contract_version,eligibility_rules_version,draft_pr_policy_allowed,preflight_required)
  values(g.workspace_id,g.product_id,g.repository_id,g.workspace_dependency_id,m.id,r.owner||'/'||r.name,g.source_change_id,c.id,
    s.source_mode,s.processing_mode,g.intelligence_decision_id,g.route_intent_id,
    (select i.route from public.intelligence_route_intents i where i.id=g.route_intent_id),
    (select i.route_target from public.intelligence_route_intents i where i.id=g.route_intent_id),g.analysis_run_id,g.id,g.commit_sha,
    g.analyzer_version,g.analysis_profile,g.graph_builder_version,g.policy_version,g.review_disposition,g.review_reason,
    case when s.source_mode='internal_test' then 'evidence_only' else 'customer' end,v_evidence_ids,v_evidence_fingerprint,
    v_identity,v_hash,v_hash,'fix-engine-v1','fix-eligibility-v1',
    coalesce(v_has_policy and pol.enabled and pol.draft_pr_preparation_allowed and g.repository_id=any(pol.allowed_repository_ids),false),
     s.source_mode='provider')
  on conflict(idempotency_key) do nothing returning id into v_inserted_id;
  select * into v_fix from public.fix_runs f where f.idempotency_key=v_hash;
  if not found then raise exception 'fix_run_persist_failed' using errcode='P0001'; end if;
  insert into public.fix_stage_queue(fix_run_id,workspace_id,stage,idempotency_key)
    values(v_fix.id,v_fix.workspace_id,'diagnose',encode(extensions.digest(convert_to(v_fix.id::text||':diagnose','UTF8'),'sha256'),'hex'))
    on conflict(fix_run_id,stage) do nothing;
  return jsonb_build_object('fixRunId',v_fix.id,'idempotencyKey',v_fix.idempotency_key,'status',v_fix.status,'replayed',v_inserted_id is null);
end;
$$;
revoke all on function public.create_fix_run_from_graph(uuid) from public,anon,authenticated;
grant execute on function public.create_fix_run_from_graph(uuid) to service_role;

create function public.claim_fix_stage(p_stage_id uuid,p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare q public.fix_stage_queue%rowtype; v_run public.fix_runs%rowtype; v_token uuid:=gen_random_uuid(); v_next text; v_status text;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if p_lease_seconds not between 15 and 300 then raise exception 'invalid_fix_stage_lease' using errcode='22023'; end if;
  select * into q from public.fix_stage_queue where id=p_stage_id;
  if found and q.status='completed' then
    select stage into v_next from public.fix_stage_queue where fix_run_id=q.fix_run_id and status='queued'
      order by created_at limit 1;
    return jsonb_build_object('status','completed','stageId',q.id,'fixRunId',q.fix_run_id,'replayed',true,'nextStage',v_next);
  end if;
  if found and q.status='claimed' and q.lease_expires_at<now() and q.attempt_count>=3 then
    select * into v_run from public.fix_runs where id=q.fix_run_id and workspace_id=q.workspace_id for update;
    v_status:=case q.stage when 'diagnose' then 'diagnosis_failed' when 'plan' then 'plan_failed'
      when 'generate_patch' then 'patch_failed' when 'apply_patch' then 'patch_conflict'
      when 'verify_patch' then 'validation_failed' when 'preflight' then 'preflight_failed'
      when 'risk_assess' then 'risk_blocked' else 'failed' end;
    update public.fix_stage_queue set status='failed',claim_token=null,lease_expires_at=null,
      failure_category='fix_stage_lease_retry_limit',completed_at=now() where id=q.id;
    update public.fix_runs set status=v_status,failure_category='fix_stage_lease_retry_limit',updated_at=now(),completed_at=now() where id=v_run.id;
    return jsonb_build_object('status',v_status,'stageId',q.id,'fixRunId',q.fix_run_id,'retryExhausted',true);
  end if;
  update public.fix_stage_queue set status='claimed',claim_token=v_token,lease_expires_at=now()+make_interval(secs=>p_lease_seconds),attempt_count=attempt_count+1
    where id=p_stage_id and attempt_count<3 and (status='queued' or (status='claimed' and lease_expires_at<now())) returning * into q;
  if not found then return jsonb_build_object('status','busy'); end if;
  select * into v_run from public.fix_runs where id=q.fix_run_id and workspace_id=q.workspace_id;
  if not exists(select 1 from public.workspace_products p where p.id=v_run.product_id and p.workspace_id=v_run.workspace_id and p.status='protected')
    or not exists(select 1 from public.repositories r where r.id=v_run.repository_id and r.workspace_id=v_run.workspace_id and r.status='available' and not r.archived)
    or not exists(select 1 from public.workspace_dependencies d where d.id=v_run.workspace_dependency_id and d.workspace_id=v_run.workspace_id
      and d.protected_product_id=v_run.product_id and d.monitoring_enabled)
    or not exists(select 1 from public.workspace_product_repositories m where m.id=v_run.product_repository_mapping_id
      and m.workspace_id=v_run.workspace_id and m.protected_product_id=v_run.product_id and m.repository_id=v_run.repository_id and m.status='active') then
    update public.fix_stage_queue set status='failed',claim_token=null,lease_expires_at=null,failure_category='fix_scope_stale',completed_at=now() where id=q.id;
    update public.fix_runs set status='failed',failure_category='fix_scope_stale',updated_at=now(),completed_at=now() where id=v_run.id;
    return jsonb_build_object('status','stale_scope','stageId',q.id,'fixRunId',q.fix_run_id);
  end if;
  update public.fix_runs set current_stage=q.stage,status=case q.stage when 'diagnose' then 'diagnosing' when 'plan' then 'planning'
    when 'generate_patch' then 'generating_patch' when 'apply_patch' then 'applying_patch' when 'verify_patch' then 'validating'
    when 'preflight' then 'preflight_pending' when 'risk_assess' then 'risk_assessing' else 'creating_pr' end,updated_at=now()
    where id=v_run.id;
  return jsonb_build_object('status','claimed','stageId',q.id,'fixRunId',q.fix_run_id,'claimToken',v_token,'stage',q.stage,
    'attemptNumber',q.attempt_count,'workspaceId',v_run.workspace_id,'productId',v_run.product_id,'repositoryId',v_run.repository_id,'commitSha',v_run.commit_sha,
    'provenanceMode',v_run.provenance_mode,'reviewDisposition',v_run.review_disposition,'reviewReason',v_run.review_reason);
end;
$$;
revoke all on function public.claim_fix_stage(uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_fix_stage(uuid,integer) to service_role;

create function public.list_fix_stage_work(p_limit integer default 50)
returns table(fix_run_id uuid,stage text,attempt_count integer,idempotency_key text)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if p_limit not between 1 and 100 then raise exception 'invalid_fix_stage_batch_size' using errcode='22023'; end if;
  return query
    select q.fix_run_id,q.stage,q.attempt_count,q.idempotency_key
    from public.fix_stage_queue q
    where (q.status='queued' and q.attempt_count<3)
      or (q.status='claimed' and q.lease_expires_at<now())
    order by q.created_at,q.id limit p_limit;
end;
$$;
revoke all on function public.list_fix_stage_work(integer) from public,anon,authenticated;
grant execute on function public.list_fix_stage_work(integer) to service_role;

create function public.begin_fix_model_attempt(
  p_stage_id uuid,p_claim_token uuid,p_attempt_number integer,p_provider text,p_model text,p_schema_version text,
  p_prompt_contract_version text,p_input_fingerprint text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare q public.fix_stage_queue%rowtype; r public.fix_runs%rowtype; v_id uuid;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if p_provider is null or p_provider !~ '^[a-zA-Z0-9._:-]{1,80}$' or p_model is null or char_length(p_model) not between 1 and 160
    or p_schema_version is null or char_length(p_schema_version) not between 1 and 80
    or p_prompt_contract_version is null or char_length(p_prompt_contract_version) not between 1 and 80
    or p_input_fingerprint is null or p_input_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid_fix_model_attempt' using errcode='22023';
  end if;
  select * into q from public.fix_stage_queue x where x.id=p_stage_id and x.status='claimed'
    and x.claim_token=p_claim_token and x.lease_expires_at>now() for update;
  if not found or q.stage not in ('diagnose','plan','generate_patch') or q.attempt_count not between 1 and 3
    or p_attempt_number<>q.attempt_count then
    raise exception 'fix_model_attempt_stage_invalid' using errcode='42501';
  end if;
  select * into r from public.fix_runs x where x.id=q.fix_run_id and x.workspace_id=q.workspace_id;
  if not found then raise exception 'fix_run_not_found' using errcode='P0002'; end if;
  update public.fix_model_attempts set status='ambiguous',failure_category='previous_model_attempt_interrupted',completed_at=now()
    where fix_run_id=r.id and stage=q.stage and attempt_number<q.attempt_count and status='started';
  insert into public.fix_model_attempts(fix_run_id,workspace_id,stage,attempt_number,provider,model,schema_version,
    prompt_contract_version,status,input_fingerprint)
    values(r.id,r.workspace_id,q.stage,q.attempt_count,p_provider,p_model,p_schema_version,p_prompt_contract_version,'started',p_input_fingerprint)
    on conflict(fix_run_id,stage,attempt_number) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from public.fix_model_attempts where fix_run_id=r.id and stage=q.stage and attempt_number=q.attempt_count
      and input_fingerprint=p_input_fingerprint and provider=p_provider and model=p_model and status='started';
    if v_id is null then raise exception 'fix_model_attempt_replay_conflict' using errcode='23505'; end if;
  end if;
  return jsonb_build_object('attemptId',v_id,'attemptNumber',q.attempt_count);
end;
$$;
revoke all on function public.begin_fix_model_attempt(uuid,uuid,integer,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.begin_fix_model_attempt(uuid,uuid,integer,text,text,text,text,text) to service_role;

create function public.finish_fix_model_attempt(
  p_stage_id uuid,p_claim_token uuid,p_attempt_id uuid,p_status text,p_model_version text,
  p_output_fingerprint text,p_latency_ms integer,p_input_tokens integer,p_output_tokens integer,
  p_cost_microusd bigint,p_failure_category text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare q public.fix_stage_queue%rowtype;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if p_status is null or p_status not in ('succeeded','failed','ambiguous')
    or (p_status='succeeded' and (p_output_fingerprint is null or p_output_fingerprint !~ '^[a-f0-9]{64}$'))
    or (p_output_fingerprint is not null and p_output_fingerprint !~ '^[a-f0-9]{64}$')
    or (p_model_version is not null and char_length(p_model_version)>160)
    or (p_latency_ms is not null and p_latency_ms not between 0 and 3600000)
    or (p_input_tokens is not null and p_input_tokens<0) or (p_output_tokens is not null and p_output_tokens<0)
    or (p_cost_microusd is not null and p_cost_microusd<0)
    or (p_failure_category is not null and p_failure_category !~ '^[a-z0-9_]{1,100}$') then
    raise exception 'invalid_fix_model_attempt_result' using errcode='22023';
  end if;
  select * into q from public.fix_stage_queue x where x.id=p_stage_id and x.status='claimed'
    and x.claim_token=p_claim_token and x.lease_expires_at>now();
  if not found then raise exception 'fix_stage_claim_lost' using errcode='40001'; end if;
  update public.fix_model_attempts set status=p_status,model_version=p_model_version,output_fingerprint=p_output_fingerprint,
    latency_ms=p_latency_ms,input_tokens=p_input_tokens,output_tokens=p_output_tokens,cost_microusd=p_cost_microusd,
    failure_category=p_failure_category,completed_at=now()
    where id=p_attempt_id and fix_run_id=q.fix_run_id and stage=q.stage and attempt_number=q.attempt_count and status='started';
  if not found then raise exception 'fix_model_attempt_identity_mismatch' using errcode='42501'; end if;
  return true;
end;
$$;
revoke all on function public.finish_fix_model_attempt(uuid,uuid,uuid,text,text,text,integer,integer,integer,bigint,text) from public,anon,authenticated;
grant execute on function public.finish_fix_model_attempt(uuid,uuid,uuid,text,text,text,integer,integer,integer,bigint,text) to service_role;

create function public.complete_fix_stage(p_stage_id uuid,p_claim_token uuid,p_result text,p_failure_category text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare q public.fix_stage_queue%rowtype; v_run public.fix_runs%rowtype; v_next text; v_status text;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if p_result not in ('completed','failed','cancelled','retry') or (p_failure_category is not null and p_failure_category !~ '^[a-z0-9_]{1,100}$') then
    raise exception 'invalid_fix_stage_result' using errcode='22023';
  end if;
  select * into q from public.fix_stage_queue where id=p_stage_id and status='claimed' and claim_token=p_claim_token and lease_expires_at>now() for update;
  if not found then raise exception 'fix_stage_claim_lost' using errcode='40001'; end if;
  select * into v_run from public.fix_runs where id=q.fix_run_id and workspace_id=q.workspace_id for update;
  if p_result='completed' and ((q.stage='diagnose' and not exists(select 1 from public.fix_diagnoses x where x.fix_run_id=v_run.id))
    or (q.stage='plan' and not exists(select 1 from public.fix_plans x where x.fix_run_id=v_run.id))
    or (q.stage='generate_patch' and not exists(select 1 from public.fix_patches x where x.fix_run_id=v_run.id and x.status='validated'))
    or (q.stage='apply_patch' and not exists(select 1 from public.fix_patches x where x.fix_run_id=v_run.id and x.status='applied'))
    or (q.stage='verify_patch' and not exists(select 1 from public.fix_verification_runs x where x.fix_run_id=v_run.id and x.status='passed'))
    or (q.stage='preflight' and not exists(select 1 from public.fix_preflight_results x where x.fix_run_id=v_run.id and x.status='passed'))
    or (q.stage='risk_assess' and not exists(select 1 from public.fix_risk_assessments x where x.fix_run_id=v_run.id))
    or (q.stage='create_draft_pr' and not exists(select 1 from public.fix_pr_outcomes x where x.fix_run_id=v_run.id and x.status in ('draft_created','reconciled_existing')))) then
    raise exception 'fix_stage_evidence_missing' using errcode='23514';
  end if;
  if p_result='retry' then
    if q.attempt_count>=3 then
      v_status:=case q.stage when 'diagnose' then 'diagnosis_failed' when 'plan' then 'plan_failed'
        when 'generate_patch' then 'patch_failed' when 'apply_patch' then 'patch_conflict'
        when 'verify_patch' then 'validation_failed' when 'preflight' then 'preflight_failed'
        when 'risk_assess' then 'risk_blocked' else 'failed' end;
      update public.fix_stage_queue set status='failed',claim_token=null,lease_expires_at=null,
        failure_category=coalesce(p_failure_category,'fix_stage_retry_limit'),completed_at=now() where id=q.id;
      update public.fix_runs set status=v_status,failure_category=coalesce(p_failure_category,'fix_stage_retry_limit'),
        updated_at=now(),completed_at=now() where id=v_run.id;
      return jsonb_build_object('status',v_status,'stageId',q.id,'nextStage',null,'retryExhausted',true);
    end if;
    update public.fix_stage_queue set status='queued',claim_token=null,lease_expires_at=null,failure_category=p_failure_category where id=q.id;
    return jsonb_build_object('status','retry_queued','stageId',q.id);
  end if;
  update public.fix_stage_queue set status=p_result,claim_token=null,lease_expires_at=null,failure_category=p_failure_category,
    completed_at=case when p_result='completed' then now() else now() end where id=q.id;
  if p_result<>'completed' then
    v_status:=case when p_result='cancelled' then 'cancelled' else case q.stage
      when 'diagnose' then 'diagnosis_failed' when 'plan' then 'plan_failed' when 'apply_patch' then 'patch_conflict'
      when 'generate_patch' then 'patch_failed' when 'verify_patch' then 'validation_failed' when 'preflight' then 'preflight_failed'
      when 'risk_assess' then 'risk_blocked' else 'failed' end end;
    update public.fix_runs set status=v_status,failure_category=p_failure_category,updated_at=now(),completed_at=now() where id=v_run.id;
    return jsonb_build_object('status',v_status,'nextStage',null);
  end if;
  v_next:=case q.stage when 'diagnose' then 'plan' when 'plan' then 'generate_patch' when 'generate_patch' then 'apply_patch'
    when 'apply_patch' then 'verify_patch' when 'verify_patch' then case when v_run.provenance_mode='evidence_only' then 'risk_assess' else 'preflight' end
    when 'preflight' then 'risk_assess' when 'risk_assess' then case when v_run.provenance_mode='customer' and v_run.draft_pr_policy_allowed and v_run.risk_level in ('LOW','MEDIUM') then 'create_draft_pr' else null end
    else null end;
  if q.stage='verify_patch' and v_run.provenance_mode='customer' then
    update public.fix_runs set status='preflight_pending',current_stage='preflight',updated_at=now() where id=v_run.id;
  elsif q.stage='risk_assess' and v_run.provenance_mode='evidence_only' then
    update public.fix_runs set status=case when v_run.risk_level='BLOCKED' then 'risk_blocked' else 'candidate_validated' end,
      current_stage='risk_assess',updated_at=now(),completed_at=now() where id=v_run.id;
  elsif q.stage='risk_assess' and v_next is null then
    update public.fix_runs set status=case when v_run.risk_level in ('HIGH','BLOCKED') then 'risk_blocked' else 'candidate_validated' end,
      current_stage='risk_assess',updated_at=now(),completed_at=now() where id=v_run.id;
  elsif q.stage='create_draft_pr' then
    update public.fix_runs set status='pr_created',current_stage='create_draft_pr',updated_at=now(),completed_at=now() where id=v_run.id;
  elsif v_next='create_draft_pr' then
    update public.fix_runs set status='ready_for_pr',current_stage=v_next,updated_at=now() where id=v_run.id;
  elsif v_next is not null then
    update public.fix_runs set status=case v_next when 'diagnose' then 'diagnosing' when 'plan' then 'planning' when 'generate_patch' then 'generating_patch'
      when 'apply_patch' then 'applying_patch' when 'verify_patch' then 'validating' when 'preflight' then 'preflight_pending' when 'risk_assess' then 'risk_assessing' else 'creating_pr' end,
      current_stage=v_next,updated_at=now() where id=v_run.id;
  end if;
  if v_next is not null then
    insert into public.fix_stage_queue(fix_run_id,workspace_id,stage,idempotency_key)
      values(v_run.id,v_run.workspace_id,v_next,encode(extensions.digest(convert_to(v_run.id::text||':'||v_next,'UTF8'),'sha256'),'hex'))
      on conflict(fix_run_id,stage) do nothing;
  end if;
  return jsonb_build_object('status','completed','nextStage',v_next);
end;
$$;
revoke all on function public.complete_fix_stage(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.complete_fix_stage(uuid,uuid,text,text) to service_role;

create function public.resolve_fix_external_operation(p_fix_run_id uuid,p_operation_id uuid,p_status text,p_external_id text default null,p_external_url text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_op public.fix_external_operations%rowtype;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if p_status not in ('succeeded','failed','ambiguous') or (p_external_id is not null and char_length(p_external_id)>255)
    or (p_external_url is not null and (left(p_external_url,19)<>'https://github.com/' or char_length(p_external_url)>1024)) then
    raise exception 'invalid_fix_external_operation_result' using errcode='22023';
  end if;
  select * into v_op from public.fix_external_operations x where x.id=p_operation_id and x.fix_run_id=p_fix_run_id for update;
  if not found then raise exception 'fix_external_operation_not_found' using errcode='P0002'; end if;
  if v_op.status='failed' then raise exception 'fix_external_operation_terminal_failure' using errcode='23514'; end if;
  if v_op.status='succeeded' then
    if p_status='succeeded' and v_op.external_id is not distinct from p_external_id and v_op.external_url is not distinct from p_external_url then return true; end if;
    raise exception 'fix_external_operation_already_succeeded' using errcode='23514';
  end if;
  update public.fix_external_operations set status=p_status,external_id=p_external_id,external_url=p_external_url,updated_at=now()
    where id=v_op.id;
  return true;
end;
$$;
revoke all on function public.resolve_fix_external_operation(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.resolve_fix_external_operation(uuid,uuid,text,text,text) to service_role;

create function public.record_fix_stage_artifact(p_fix_run_id uuid,p_stage_id uuid,p_claim_token uuid,p_kind text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.fix_runs%rowtype; v_queue public.fix_stage_queue%rowtype; v_id uuid; v_evidence uuid[]; v_plan_id uuid; v_patch_id uuid; v_preflight_id uuid; v_replayed boolean:=false;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>65536 then raise exception 'invalid_fix_stage_payload' using errcode='22023'; end if;
  select * into v_run from public.fix_runs where id=p_fix_run_id for update;
  select * into v_queue from public.fix_stage_queue where id=p_stage_id and fix_run_id=p_fix_run_id and status='claimed'
    and claim_token=p_claim_token and lease_expires_at>now() for update;
  if not found then raise exception 'fix_stage_claim_lost' using errcode='40001'; end if;
  if v_run.id is null then raise exception 'fix_run_not_found' using errcode='P0002'; end if;
  if (v_run.provenance_mode='evidence_only' and p_kind in ('preflight','external_operation','pr_outcome'))
    or p_kind not in ('diagnosis','plan','patch','verification','preflight','risk','external_operation','pr_outcome') then
    raise exception 'fix_artifact_kind_forbidden' using errcode='42501';
  end if;
  if (p_kind='diagnosis' and v_queue.stage<>'diagnose') or (p_kind='plan' and v_queue.stage<>'plan')
    or (p_kind='patch' and v_queue.stage not in ('generate_patch','apply_patch'))
    or (p_kind='verification' and v_queue.stage<>'verify_patch') or (p_kind='preflight' and v_queue.stage<>'preflight')
    or (p_kind='risk' and v_queue.stage<>'risk_assess') or (p_kind='external_operation' and v_queue.stage<>'create_draft_pr')
    or (p_kind='pr_outcome' and v_queue.stage<>'create_draft_pr') then raise exception 'fix_artifact_stage_mismatch' using errcode='42501'; end if;
  case p_kind
  when 'diagnosis' then
    if not (p_payload ?& array['diagnosis','evidenceIds','provider','model','schemaVersion','promptContractVersion','inputFingerprint','outputFingerprint']) then
      raise exception 'fix_diagnosis_contract_invalid' using errcode='22023'; end if;
    select array_agg(x::uuid) into v_evidence from jsonb_array_elements_text(p_payload->'evidenceIds') x;
    if coalesce(cardinality(v_evidence),0)=0 or not (to_jsonb(v_run.positive_graph_evidence_ids) @> to_jsonb(v_evidence)) then
      raise exception 'fix_diagnosis_evidence_not_pinned' using errcode='42501'; end if;
    insert into public.fix_diagnoses(fix_run_id,workspace_id,graph_build_id,analysis_run_id,repository_id,commit_sha,
      semantic_route,change_family,diagnosis,evidence_ids,provider,model,model_version,schema_version,prompt_contract_version,
      input_fingerprint,output_fingerprint,latency_ms,input_tokens,output_tokens,cost_microusd)
    values(v_run.id,v_run.workspace_id,v_run.graph_build_id,v_run.analysis_run_id,v_run.repository_id,v_run.commit_sha,
      v_run.semantic_route,coalesce(p_payload->>'changeFamily','unknown'),p_payload->'diagnosis',v_evidence,p_payload->>'provider',p_payload->>'model',
      p_payload->>'modelVersion',p_payload->>'schemaVersion',p_payload->>'promptContractVersion',p_payload->>'inputFingerprint',p_payload->>'outputFingerprint',
      nullif(p_payload->>'latencyMs','')::integer,nullif(p_payload->>'inputTokens','')::integer,nullif(p_payload->>'outputTokens','')::integer,nullif(p_payload->>'costMicrousd','')::bigint)
    on conflict(fix_run_id) do nothing returning id into v_id;
    if v_id is null then
      select id into v_id from public.fix_diagnoses where fix_run_id=v_run.id
        and input_fingerprint=p_payload->>'inputFingerprint' and output_fingerprint=p_payload->>'outputFingerprint';
      if v_id is null then raise exception 'fix_diagnosis_replay_conflict' using errcode='23505'; end if;
    end if;
  when 'plan' then
    if not (p_payload ?& array['plan','planVersion','planFingerprint','provider','model','schemaVersion','promptContractVersion']) then raise exception 'fix_plan_contract_invalid' using errcode='22023'; end if;
    insert into public.fix_plans(fix_run_id,workspace_id,plan_version,plan,plan_fingerprint,provider,model,schema_version,prompt_contract_version)
    values(v_run.id,v_run.workspace_id,(p_payload->>'planVersion')::integer,p_payload->'plan',p_payload->>'planFingerprint',p_payload->>'provider',p_payload->>'model',p_payload->>'schemaVersion',p_payload->>'promptContractVersion')
    on conflict(fix_run_id,plan_version) do nothing returning id into v_id;
    if v_id is null then
      select id into v_id from public.fix_plans where fix_run_id=v_run.id and plan_version=(p_payload->>'planVersion')::integer
        and plan_fingerprint=p_payload->>'planFingerprint';
      if v_id is null then raise exception 'fix_plan_replay_conflict' using errcode='23505'; end if;
    end if;
  when 'patch' then
    v_plan_id:=(p_payload->>'planId')::uuid;
    select id into v_plan_id from public.fix_plans where id=v_plan_id and fix_run_id=v_run.id;
    if v_plan_id is null then raise exception 'fix_patch_plan_mismatch' using errcode='42501'; end if;
    if v_queue.stage='apply_patch' then
      update public.fix_patches set status='applied' where fix_run_id=v_run.id and id=(p_payload->>'patchId')::uuid and status='validated' returning id into v_id;
      if v_id is null then raise exception 'fix_patch_not_applicable' using errcode='42501'; end if;
    else
      if not (p_payload ?& array['attemptNumber','baseSha','patchFingerprint','artifactPath','changedPaths','lineCount','byteCount','provider','model']) then raise exception 'fix_patch_contract_invalid' using errcode='22023'; end if;
      if (p_payload->>'baseSha')<>v_run.commit_sha or jsonb_typeof(p_payload->'changedPaths')<>'array'
        or jsonb_array_length(p_payload->'changedPaths') not between 1 and 25
        or exists(select 1 from jsonb_array_elements_text(p_payload->'changedPaths') path
          where path like '/%' or path like '%..%' or path ~ E'\\\\' or path ~* '(^|/)(\.git|node_modules|secrets|\.env($|\.))'
            or path ~* '\.(pem|key|p12|pfx)$'
            or not exists(select 1 from jsonb_array_elements((select p.plan->'allowedFiles' from public.fix_plans p where p.id=v_plan_id)) f where f->>'path'=path)) then
        raise exception 'fix_patch_path_or_base_forbidden' using errcode='42501';
      end if;
      insert into public.fix_patches(fix_run_id,workspace_id,plan_id,attempt_number,base_sha,patch_fingerprint,artifact_path,
        changed_paths,line_count,byte_count,status,provider,model)
      values(v_run.id,v_run.workspace_id,v_plan_id,(p_payload->>'attemptNumber')::integer,p_payload->>'baseSha',p_payload->>'patchFingerprint',
        p_payload->>'artifactPath',array(select jsonb_array_elements_text(p_payload->'changedPaths')),(p_payload->>'lineCount')::integer,(p_payload->>'byteCount')::integer,
        'validated',p_payload->>'provider',p_payload->>'model') on conflict(fix_run_id,attempt_number) do nothing returning id into v_id;
      if v_id is null then
        select id into v_id from public.fix_patches where fix_run_id=v_run.id and attempt_number=(p_payload->>'attemptNumber')::integer
          and patch_fingerprint=p_payload->>'patchFingerprint' and base_sha=v_run.commit_sha;
        if v_id is null then raise exception 'fix_patch_attempt_conflict' using errcode='23505'; end if;
      end if;
    end if;
  when 'verification' then
    v_patch_id:=(p_payload->>'patchId')::uuid;
    if not exists(select 1 from public.fix_patches x where x.id=v_patch_id and x.fix_run_id=v_run.id and x.status='applied'
      and x.patch_fingerprint=p_payload->>'patchFingerprint') then raise exception 'fix_verification_patch_mismatch' using errcode='42501'; end if;
    insert into public.fix_verification_runs(fix_run_id,workspace_id,patch_id,profile_id,status,checks,diagnostic_summary,duration_ms,patch_fingerprint,attempt_number,idempotency_key)
      values(v_run.id,v_run.workspace_id,v_patch_id,p_payload->>'profileId',p_payload->>'status',p_payload->'checks',coalesce(p_payload->>'diagnosticSummary',''),
        (p_payload->>'durationMs')::integer,p_payload->>'patchFingerprint',(p_payload->>'attemptNumber')::integer,
        encode(extensions.digest(convert_to(v_run.id::text||':verify:'||v_patch_id::text||':'||(p_payload->>'profileId')||':'||(p_payload->>'attemptNumber'),'UTF8'),'sha256'),'hex'))
      on conflict(idempotency_key) do nothing returning id into v_id;
    if v_id is null then
      select id into v_id from public.fix_verification_runs where fix_run_id=v_run.id and patch_id=v_patch_id
        and profile_id=p_payload->>'profileId' and attempt_number=(p_payload->>'attemptNumber')::integer
        and patch_fingerprint=p_payload->>'patchFingerprint' and status=p_payload->>'status';
      if v_id is null then raise exception 'fix_verification_attempt_conflict' using errcode='23505'; end if;
    end if;
  when 'preflight' then
    if v_run.provenance_mode='evidence_only' then raise exception 'evidence_only_preflight_forbidden' using errcode='42501'; end if;
    v_patch_id:=(p_payload->>'patchId')::uuid;
    if not exists(select 1 from public.fix_patches x where x.id=v_patch_id and x.fix_run_id=v_run.id and x.status='applied'
      and x.patch_fingerprint=p_payload->>'patchFingerprint') then raise exception 'fix_preflight_patch_mismatch' using errcode='42501'; end if;
    v_preflight_id:=nullif(p_payload->>'preflightRunId','')::uuid;
    if (p_payload->>'status')='passed' and (v_preflight_id is null or not exists(
      select 1 from public.preflight_runs pr join public.impact_assessments ia on ia.id=pr.impact_assessment_id and ia.workspace_id=pr.workspace_id
      where pr.id=v_preflight_id and pr.workspace_id=v_run.workspace_id and pr.status='completed'
        and ia.workspace_dependency_id=v_run.workspace_dependency_id and ia.source_change_classification_id=v_run.classification_id
    )) then raise exception 'canonical_preflight_evidence_required' using errcode='42501'; end if;
    insert into public.fix_preflight_results(fix_run_id,workspace_id,status,patch_id,patch_fingerprint,preflight_run_id,failure_category)
      values(v_run.id,v_run.workspace_id,p_payload->>'status',v_patch_id,p_payload->>'patchFingerprint',v_preflight_id,p_payload->>'failureCategory') returning id into v_id;
  when 'risk' then
    insert into public.fix_risk_assessments(fix_run_id,workspace_id,risk_version,risk_level,factors,review_required,review_reason,input_fingerprint)
      values(v_run.id,v_run.workspace_id,p_payload->>'riskVersion',p_payload->>'riskLevel',p_payload->'factors',
        v_run.review_disposition='review_required',v_run.review_reason,p_payload->>'inputFingerprint') on conflict(fix_run_id) do nothing returning id into v_id;
    if v_id is null then
      select id into v_id from public.fix_risk_assessments where fix_run_id=v_run.id
        and input_fingerprint=p_payload->>'inputFingerprint' and risk_level=p_payload->>'riskLevel';
      if v_id is null then raise exception 'fix_risk_replay_conflict' using errcode='23505'; end if;
    end if;
    update public.fix_runs set risk_level=p_payload->>'riskLevel',status=case when (p_payload->>'riskLevel')='BLOCKED' then 'risk_blocked' else 'risk_assessing' end,updated_at=now()
      where id=v_run.id;
  when 'external_operation' then
    if v_run.provenance_mode='evidence_only' or v_run.risk_level not in ('LOW','MEDIUM') or not v_run.draft_pr_policy_allowed then
      raise exception 'fix_pr_not_eligible' using errcode='42501'; end if;
    if (p_payload->>'idempotencyKey')<>encode(extensions.digest(convert_to(v_run.idempotency_key||':'||(p_payload->>'operationKind')||':'||(p_payload->>'requestFingerprint'),'UTF8'),'sha256'),'hex') then
      raise exception 'fix_external_operation_identity_mismatch' using errcode='23514'; end if;
    insert into public.fix_external_operations(fix_run_id,workspace_id,operation_kind,idempotency_key,status,request_fingerprint)
      values(v_run.id,v_run.workspace_id,p_payload->>'operationKind',p_payload->>'idempotencyKey',p_payload->>'status',p_payload->>'requestFingerprint')
      on conflict(idempotency_key) do nothing returning id into v_id;
    if v_id is null then
      v_replayed:=true;
      select id into v_id from public.fix_external_operations where idempotency_key=p_payload->>'idempotencyKey'
        and fix_run_id=v_run.id and operation_kind=p_payload->>'operationKind' and request_fingerprint=p_payload->>'requestFingerprint';
      if v_id is null then raise exception 'fix_external_operation_replay_conflict' using errcode='23505'; end if;
    end if;
  when 'pr_outcome' then
    if v_run.provenance_mode='evidence_only' or v_run.risk_level not in ('LOW','MEDIUM') or not v_run.draft_pr_policy_allowed then
      raise exception 'fix_pr_not_eligible' using errcode='42501'; end if;
    if (p_payload->>'status') not in ('draft_created','reconciled_existing')
      or (p_payload->>'baseSha')<>v_run.commit_sha
      or (p_payload->>'branchName')<>('auterim/fix/'||left(v_run.idempotency_key,12))
      or not exists(select 1 from public.fix_external_operations x where x.id=(p_payload->>'externalOperationId')::uuid
        and x.fix_run_id=v_run.id and x.operation_kind='github_draft_pr' and x.status='succeeded')
      or not exists(select 1 from public.fix_patches x join public.fix_verification_runs v on v.patch_id=x.id and v.fix_run_id=x.fix_run_id
        where x.fix_run_id=v_run.id and x.status='applied' and v.status='passed' and v.patch_fingerprint=x.patch_fingerprint)
      or (v_run.preflight_required and not exists(select 1 from public.fix_preflight_results f
        where f.fix_run_id=v_run.id and f.status='passed' and exists(select 1 from public.fix_patches x
          where x.id=f.patch_id and x.patch_fingerprint=f.patch_fingerprint and x.status='applied'))) then
      raise exception 'fix_pr_outcome_unverified' using errcode='42501';
    end if;
    insert into public.fix_pr_outcomes(fix_run_id,workspace_id,external_operation_id,status,branch_name,pull_request_url,base_sha,head_sha)
      values(v_run.id,v_run.workspace_id,(p_payload->>'externalOperationId')::uuid,p_payload->>'status',p_payload->>'branchName',
        p_payload->>'pullRequestUrl',p_payload->>'baseSha',p_payload->>'headSha') returning id into v_id;
  end case;
  if p_kind='external_operation' then
    return jsonb_build_object('status','recorded','recordId',v_id,'replayed',v_replayed);
  end if;
  return jsonb_build_object('status','recorded','recordId',v_id);
end;
$$;
revoke all on function public.record_fix_stage_artifact(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_fix_stage_artifact(uuid,uuid,uuid,text,jsonb) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('fix-engine-artifacts','fix-engine-artifacts',false,131072,array['text/x-diff','text/plain'])
on conflict(id) do nothing;

alter table public.fix_runs enable row level security;
alter table public.fix_model_attempts enable row level security;
alter table public.fix_stage_queue enable row level security;
alter table public.fix_diagnoses enable row level security;
alter table public.fix_plans enable row level security;
alter table public.fix_patches enable row level security;
alter table public.fix_verification_runs enable row level security;
alter table public.fix_preflight_results enable row level security;
alter table public.fix_risk_assessments enable row level security;
alter table public.fix_external_operations enable row level security;
alter table public.fix_pr_outcomes enable row level security;

create policy fix_runs_member_read on public.fix_runs for select to authenticated using (exists(
  select 1 from public.workspace_members wm where wm.workspace_id=fix_runs.workspace_id and wm.user_id=(select auth.uid())));
create policy fix_model_attempts_member_read on public.fix_model_attempts for select to authenticated using (exists(
  select 1 from public.workspace_members wm where wm.workspace_id=fix_model_attempts.workspace_id and wm.user_id=(select auth.uid())));
create policy fix_stage_queue_member_read on public.fix_stage_queue for select to authenticated using (exists(
  select 1 from public.workspace_members wm where wm.workspace_id=fix_stage_queue.workspace_id and wm.user_id=(select auth.uid())));
create policy fix_diagnoses_member_read on public.fix_diagnoses for select to authenticated using (exists(
  select 1 from public.workspace_members wm where wm.workspace_id=fix_diagnoses.workspace_id and wm.user_id=(select auth.uid())));
create policy fix_plans_member_read on public.fix_plans for select to authenticated using (exists(
  select 1 from public.workspace_members wm where wm.workspace_id=fix_plans.workspace_id and wm.user_id=(select auth.uid())));
create policy fix_patches_member_read on public.fix_patches for select to authenticated using (exists(
  select 1 from public.workspace_members wm where wm.workspace_id=fix_patches.workspace_id and wm.user_id=(select auth.uid())));
create policy fix_verification_member_read on public.fix_verification_runs for select to authenticated using (exists(
  select 1 from public.workspace_members wm where wm.workspace_id=fix_verification_runs.workspace_id and wm.user_id=(select auth.uid())));
create policy fix_preflight_member_read on public.fix_preflight_results for select to authenticated using (exists(
  select 1 from public.workspace_members wm where wm.workspace_id=fix_preflight_results.workspace_id and wm.user_id=(select auth.uid())));
create policy fix_risk_member_read on public.fix_risk_assessments for select to authenticated using (exists(
  select 1 from public.workspace_members wm where wm.workspace_id=fix_risk_assessments.workspace_id and wm.user_id=(select auth.uid())));
create policy fix_external_ops_member_read on public.fix_external_operations for select to authenticated using (exists(
  select 1 from public.workspace_members wm where wm.workspace_id=fix_external_operations.workspace_id and wm.user_id=(select auth.uid())));
create policy fix_pr_outcomes_member_read on public.fix_pr_outcomes for select to authenticated using (exists(
  select 1 from public.workspace_members wm where wm.workspace_id=fix_pr_outcomes.workspace_id and wm.user_id=(select auth.uid())));

revoke all on public.fix_runs,public.fix_model_attempts,public.fix_stage_queue,public.fix_diagnoses,public.fix_plans,public.fix_patches,
  public.fix_verification_runs,public.fix_preflight_results,public.fix_risk_assessments,public.fix_external_operations,public.fix_pr_outcomes from public,anon;
revoke insert,update,delete on public.fix_runs,public.fix_model_attempts,public.fix_stage_queue,public.fix_diagnoses,public.fix_plans,public.fix_patches,
  public.fix_verification_runs,public.fix_preflight_results,public.fix_risk_assessments,public.fix_external_operations,public.fix_pr_outcomes from authenticated;
grant select on public.fix_runs,public.fix_model_attempts,public.fix_stage_queue,public.fix_diagnoses,public.fix_plans,public.fix_patches,
  public.fix_verification_runs,public.fix_preflight_results,public.fix_risk_assessments,public.fix_external_operations,public.fix_pr_outcomes to authenticated;
grant select on public.fix_runs,public.fix_model_attempts,public.fix_stage_queue,public.fix_diagnoses,public.fix_plans,public.fix_patches,
  public.fix_verification_runs,public.fix_preflight_results,public.fix_risk_assessments,public.fix_external_operations,public.fix_pr_outcomes to service_role;
revoke insert,update,delete on public.fix_runs,public.fix_model_attempts,public.fix_stage_queue,public.fix_diagnoses,public.fix_plans,public.fix_patches,
  public.fix_verification_runs,public.fix_preflight_results,public.fix_risk_assessments,public.fix_external_operations,public.fix_pr_outcomes from service_role;
grant execute on function public.create_fix_run_from_graph(uuid),public.claim_fix_stage(uuid,integer),
  public.list_fix_stage_work(integer),
  public.complete_fix_stage(uuid,uuid,text,text),public.begin_fix_model_attempt(uuid,uuid,integer,text,text,text,text,text),
  public.finish_fix_model_attempt(uuid,uuid,uuid,text,text,text,integer,integer,integer,bigint,text),
  public.record_fix_stage_artifact(uuid,uuid,uuid,text,jsonb) to service_role;

create function public.purge_expired_fix_patch_artifacts(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_paths text[];
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if p_limit not between 1 and 500 then raise exception 'invalid_fix_artifact_purge_limit' using errcode='22023'; end if;
  with candidates as (
    select p.id from public.fix_patches p
    where p.artifact_bucket='fix-engine-artifacts' and p.expires_at<now() and p.artifact_purged_at is null
      and (p.artifact_purge_claimed_until is null or p.artifact_purge_claimed_until<now())
    order by p.expires_at,p.id for update skip locked limit p_limit
  ), claimed as (
    update public.fix_patches p set artifact_purge_claimed_until=now()+interval '10 minutes'
    from candidates c where p.id=c.id returning p.artifact_path
  ) select coalesce(array_agg(artifact_path order by artifact_path),array[]::text[]) into v_paths from claimed;
  return jsonb_build_object('paths',to_jsonb(v_paths),'count',cardinality(v_paths));
end;
$$;
revoke all on function public.purge_expired_fix_patch_artifacts(integer) from public,anon,authenticated;
grant execute on function public.purge_expired_fix_patch_artifacts(integer) to service_role;

create function public.complete_fix_patch_artifact_purge(p_paths text[])
returns integer language plpgsql security definer set search_path = '' as $$
declare v_updated integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if p_paths is null or cardinality(p_paths)>100 or exists(
    select 1 from unnest(p_paths) x where x !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.diff$'
  ) or cardinality(p_paths)<>(select count(distinct x)::integer from unnest(p_paths) x) then
    raise exception 'invalid_fix_artifact_purge_paths' using errcode='22023'; end if;
  update public.fix_patches p set artifact_purged_at=now(),artifact_purge_claimed_until=null
  where p.artifact_path=any(p_paths) and p.expires_at<now() and p.artifact_purged_at is null
    and p.artifact_purge_claimed_until>now();
  get diagnostics v_updated=row_count;
  if v_updated<>cardinality(p_paths) then raise exception 'fix_artifact_purge_lease_lost' using errcode='40001'; end if;
  return v_updated;
end;
$$;
revoke all on function public.complete_fix_patch_artifact_purge(text[]) from public,anon,authenticated;
grant execute on function public.complete_fix_patch_artifact_purge(text[]) to service_role;
