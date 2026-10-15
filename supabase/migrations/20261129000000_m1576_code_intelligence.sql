-- M15.76: deterministic, exact-commit code intelligence. Facts contain bounded
-- structural provenance only; source files and secret values are never stored.

create table public.code_analysis_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid,
  repository_id uuid not null,
  provider_repository_identity text not null check (char_length(provider_repository_identity) between 1 and 300),
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{40,64}$'),
  analyzer_version text not null check (char_length(analyzer_version) between 1 and 80),
  language_profile text not null check (char_length(language_profile) between 1 and 80),
  analysis_profile text not null check (char_length(analysis_profile) between 1 and 80),
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  coverage_state text not null default 'partial' check (coverage_state in ('complete','partial','unsupported','failed')),
  files_discovered integer not null default 0 check (files_discovered >= 0),
  files_analyzed integer not null default 0 check (files_analyzed >= 0),
  files_skipped integer not null default 0 check (files_skipped >= 0),
  parse_failures integer not null default 0 check (parse_failures >= 0),
  bytes_analyzed bigint not null default 0 check (bytes_analyzed >= 0),
  attempt_count integer not null default 0 check (attempt_count between 0 and 8),
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 200),
  claim_token uuid,
  lease_expires_at timestamptz,
  failure_category text check (failure_category is null or failure_category ~ '^[a-z0-9_]{1,80}$'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint code_analysis_runs_product_workspace_fkey
    foreign key (product_id,workspace_id) references public.workspace_products(id,workspace_id) on delete cascade,
  constraint code_analysis_runs_repository_workspace_fkey
    foreign key (repository_id,workspace_id) references public.repositories(id,workspace_id) on delete cascade,
  constraint code_analysis_runs_identity_key
    unique (repository_id,commit_sha,analyzer_version,analysis_profile),
  constraint code_analysis_runs_id_workspace_repo_commit_key
    unique (id,workspace_id,repository_id,commit_sha),
  constraint code_analysis_runs_lease_pair_check check (
    (claim_token is null and lease_expires_at is null)
    or (claim_token is not null and lease_expires_at is not null)
  ),
  constraint code_analysis_runs_terminal_time_check check (
    (status in ('completed','failed') and completed_at is not null)
    or (status in ('queued','running') and completed_at is null)
  )
);
comment on column public.code_analysis_runs.product_id is
  'NULL for reusable repository-wide snapshots; Product identity is retained on code_analysis_route_handoffs.';

create index code_analysis_runs_repository_commit_idx
  on public.code_analysis_runs(repository_id,commit_sha,created_at desc);
create index code_analysis_runs_recovery_idx
  on public.code_analysis_runs(status,lease_expires_at,created_at)
  where status in ('queued','running');
create trigger code_analysis_runs_set_updated_at
  before update on public.code_analysis_runs for each row execute function private.set_updated_at();

create table public.code_entities (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null,
  workspace_id uuid not null,
  repository_id uuid not null,
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{40,64}$'),
  entity_type text not null check (entity_type in (
    'file','module','function','method','class','import','package_dependency',
    'external_sdk_reference','http_endpoint_reference','webhook_event_reference',
    'environment_variable_name','model_or_resource_identifier','schema_reference'
  )),
  name text not null check (char_length(name) between 1 and 240),
  language text not null check (char_length(language) between 1 and 40),
  path text not null check (char_length(path) between 1 and 1024),
  start_line integer check (start_line is null or start_line > 0),
  start_column integer check (start_column is null or start_column > 0),
  end_line integer check (end_line is null or end_line > 0),
  end_column integer check (end_column is null or end_column > 0),
  extractor_type text not null check (char_length(extractor_type) between 1 and 80),
  confidence_class text not null check (confidence_class in ('exact','structural','heuristic')),
  structural_fingerprint text not null check (structural_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  constraint code_entities_run_fk foreign key (analysis_run_id,workspace_id,repository_id,commit_sha)
    references public.code_analysis_runs(id,workspace_id,repository_id,commit_sha) on delete cascade,
  constraint code_entities_id_run_key unique (id,analysis_run_id),
  constraint code_entities_run_fingerprint_key unique (analysis_run_id,structural_fingerprint)
);
create index code_entities_lookup_idx on public.code_entities(repository_id,commit_sha,entity_type,path);

create table public.code_relations (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.code_analysis_runs(id) on delete cascade,
  from_entity_id uuid not null,
  to_entity_id uuid not null,
  relation_type text not null check (relation_type in (
    'FILE_CONTAINS_SYMBOL','IMPORTS_PACKAGE','IMPORTS_SYMBOL','CALLS_SYMBOL',
    'REFERENCES_EXTERNAL','USES_ENV_NAME','HANDLES_EVENT','CALLS_ENDPOINT','REFERENCES_SCHEMA'
  )),
  confidence_class text not null check (confidence_class in ('exact','structural','heuristic')),
  structural_fingerprint text not null check (structural_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  constraint code_relations_from_same_run_fk foreign key (from_entity_id,analysis_run_id)
    references public.code_entities(id,analysis_run_id) on delete cascade,
  constraint code_relations_to_same_run_fk foreign key (to_entity_id,analysis_run_id)
    references public.code_entities(id,analysis_run_id) on delete cascade,
  constraint code_relations_run_fingerprint_key unique (analysis_run_id,structural_fingerprint)
);
create index code_relations_run_type_idx on public.code_relations(analysis_run_id,relation_type);

create table public.code_external_references (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null,
  workspace_id uuid not null,
  repository_id uuid not null,
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{40,64}$'),
  entity_id uuid,
  reference_type text not null check (reference_type in (
    'package','import','sdk_call','event','endpoint','dynamic_endpoint','environment_variable','schema'
  )),
  normalized_value text not null check (char_length(normalized_value) between 1 and 512),
  path text not null check (char_length(path) between 1 and 1024),
  start_line integer not null check (start_line > 0),
  end_line integer not null check (end_line >= start_line),
  language text not null check (char_length(language) between 1 and 40),
  confidence_class text not null check (confidence_class in ('exact','structural','heuristic')),
  redacted boolean not null default false,
  value_fingerprint text check (value_fingerprint is null or value_fingerprint ~ '^[a-f0-9]{64}$'),
  extractor_type text not null check (char_length(extractor_type) between 1 and 80),
  structural_fingerprint text not null check (structural_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  constraint code_external_references_run_fk foreign key (analysis_run_id,workspace_id,repository_id,commit_sha)
    references public.code_analysis_runs(id,workspace_id,repository_id,commit_sha) on delete cascade,
  constraint code_external_references_entity_fk foreign key (entity_id,analysis_run_id)
    references public.code_entities(id,analysis_run_id) on delete cascade,
  constraint code_external_references_run_fingerprint_key unique (analysis_run_id,structural_fingerprint),
  constraint code_external_references_redaction_check check (
    not redacted or (normalized_value='[redacted]' and value_fingerprint is not null)
  )
);
create index code_external_references_lookup_idx
  on public.code_external_references(repository_id,commit_sha,reference_type,normalized_value);

create table public.code_analysis_skipped_files (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.code_analysis_runs(id) on delete cascade,
  path text not null check (char_length(path) between 1 and 1024),
  skip_reason text not null check (skip_reason ~ '^[a-z0-9_:-]{1,80}$'),
  byte_size bigint not null default 0 check (byte_size >= 0),
  created_at timestamptz not null default now(),
  constraint code_analysis_skipped_files_identity_key unique (analysis_run_id,path,skip_reason)
);
create index code_analysis_skipped_files_run_idx on public.code_analysis_skipped_files(analysis_run_id);

create table public.code_analysis_route_handoffs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  product_id uuid not null,
  repository_id uuid not null,
  route_intent_id uuid not null references public.intelligence_route_intents(id) on delete restrict,
  analysis_run_id uuid not null,
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{40,64}$'),
  status text not null default 'queued' check (status in ('queued','completed','failed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint code_handoffs_product_fk foreign key (product_id,workspace_id)
    references public.workspace_products(id,workspace_id) on delete cascade,
  constraint code_handoffs_repository_fk foreign key (repository_id,workspace_id)
    references public.repositories(id,workspace_id) on delete cascade,
  constraint code_handoffs_run_fk foreign key (analysis_run_id,workspace_id,repository_id,commit_sha)
    references public.code_analysis_runs(id,workspace_id,repository_id,commit_sha) on delete cascade,
  constraint code_handoffs_identity_key unique (route_intent_id,product_id,repository_id,commit_sha),
  constraint code_handoffs_terminal_time_check check (
    (status='completed' and completed_at is not null) or (status<>'completed' and completed_at is null)
  )
);
create index code_handoffs_recovery_idx on public.code_analysis_route_handoffs(status,created_at) where status='queued';

create function public.claim_code_analysis_run(
  p_workspace_id uuid,p_product_id uuid,p_repository_id uuid,p_commit_sha text,
  p_analyzer_version text,p_language_profile text,p_analysis_profile text,p_idempotency_key text,
  p_route_intent_id uuid default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare r public.code_analysis_runs%rowtype; token uuid; provider_identity text;
begin
  if p_commit_sha is null or p_commit_sha !~ '^[a-f0-9]{40,64}$'
    or p_analyzer_version is null or char_length(p_analyzer_version) not between 1 and 80
    or p_language_profile is null or char_length(p_language_profile) not between 1 and 80
    or p_analysis_profile is null or char_length(p_analysis_profile) not between 1 and 80
    or p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200 then
    raise exception 'Code analysis identity is invalid' using errcode='22023';
  end if;
  if not exists (
    select 1 from public.repositories repository
    join public.repository_connections connection
      on connection.id=repository.connection_id and connection.workspace_id=repository.workspace_id
    join public.workspace_product_repositories mapping
      on mapping.repository_id=repository.id and mapping.workspace_id=repository.workspace_id and mapping.status='active'
    join public.workspace_products product
      on product.id=mapping.protected_product_id and product.workspace_id=mapping.workspace_id and product.status='protected'
    where repository.id=p_repository_id and repository.workspace_id=p_workspace_id
      and repository.status='available' and connection.status='connected'
      and product.id=p_product_id
  ) then raise exception 'Protected repository authorization required' using errcode='42501'; end if;
  select connection.provider || ':' || repository.external_id::text into provider_identity
  from public.repositories repository
  join public.repository_connections connection
    on connection.id=repository.connection_id and connection.workspace_id=repository.workspace_id
  where repository.id=p_repository_id and repository.workspace_id=p_workspace_id;
  if provider_identity is null or char_length(provider_identity) > 300 then
    raise exception 'Provider repository identity is unavailable' using errcode='22023';
  end if;
  if p_route_intent_id is not null and not exists (
    select 1 from public.intelligence_route_intents intent
    where intent.id=p_route_intent_id and intent.route_status='pending'
      and intent.route_target in (
        'dependency_product_impact','dependency_impact_repository_exposure_candidate',
        'contract_exposure_analysis','repository_dependency_exposure_analysis',
        'contract_repository_exposure_analysis','integration_auth_risk_analysis'
      )
  ) then raise exception 'Code intelligence route intent is not eligible' using errcode='22023'; end if;
  insert into public.code_analysis_runs(
    workspace_id,product_id,repository_id,provider_repository_identity,commit_sha,analyzer_version,language_profile,
    analysis_profile,idempotency_key
  ) values (
    p_workspace_id,null,p_repository_id,provider_identity,p_commit_sha,p_analyzer_version,p_language_profile,
    p_analysis_profile,p_idempotency_key
  ) on conflict (repository_id,commit_sha,analyzer_version,analysis_profile) do nothing;
  select * into r from public.code_analysis_runs
    where repository_id=p_repository_id and commit_sha=p_commit_sha
      and analyzer_version=p_analyzer_version and analysis_profile=p_analysis_profile for update;
  if r.status='completed' then
    if p_route_intent_id is not null then
      insert into public.code_analysis_route_handoffs(workspace_id,product_id,repository_id,route_intent_id,analysis_run_id,commit_sha,status,completed_at)
      values (p_workspace_id,p_product_id,p_repository_id,p_route_intent_id,r.id,p_commit_sha,'completed',r.completed_at)
      on conflict (route_intent_id,product_id,repository_id,commit_sha) do nothing;
    end if;
    return jsonb_build_object('status','completed','analysisRunId',r.id,'replayed',true);
  end if;
  if r.status='running' and r.lease_expires_at>now() then
    return jsonb_build_object('status','busy','analysisRunId',r.id,'replayed',false);
  end if;
  if r.status='failed' then
    return jsonb_build_object('status','failed','analysisRunId',r.id,'replayed',true);
  end if;
  if r.attempt_count>=8 then
    update public.code_analysis_runs set status='failed',coverage_state='failed',failure_category='attempts_exhausted',
      completed_at=now(),claim_token=null,lease_expires_at=null where id=r.id;
    return jsonb_build_object('status','failed','analysisRunId',r.id,'replayed',false);
  end if;
  token:=gen_random_uuid();
  update public.code_analysis_runs set status='running',coverage_state='partial',attempt_count=attempt_count+1,
    claim_token=token,lease_expires_at=now()+interval '5 minutes',started_at=coalesce(started_at,now()),
    completed_at=null,failure_category=null where id=r.id returning * into r;
  if p_route_intent_id is not null then
    insert into public.code_analysis_route_handoffs(workspace_id,product_id,repository_id,route_intent_id,analysis_run_id,commit_sha)
    values (p_workspace_id,p_product_id,p_repository_id,p_route_intent_id,r.id,p_commit_sha)
    on conflict (route_intent_id,product_id,repository_id,commit_sha) do nothing;
  end if;
  return jsonb_build_object('status','claimed','analysisRunId',r.id,'claimToken',token,'replayed',false);
end;
$$;

create function public.complete_code_analysis_run(
  p_analysis_run_id uuid,p_claim_token uuid,p_coverage_state text,p_files_discovered integer,
  p_files_analyzed integer,p_files_skipped integer,p_parse_failures integer,p_bytes_analyzed bigint
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_coverage_state not in ('complete','partial','unsupported','failed')
    or least(p_files_discovered,p_files_analyzed,p_files_skipped,p_parse_failures,p_bytes_analyzed)<0
    or p_files_analyzed>p_files_discovered or p_files_skipped>p_files_discovered then
    raise exception 'Code analysis result is invalid' using errcode='22023';
  end if;
  update public.code_analysis_runs set status='completed',coverage_state=p_coverage_state,
    files_discovered=p_files_discovered,files_analyzed=p_files_analyzed,files_skipped=p_files_skipped,
    parse_failures=p_parse_failures,bytes_analyzed=p_bytes_analyzed,completed_at=now(),claim_token=null,
    lease_expires_at=null,failure_category=null
  where id=p_analysis_run_id and status='running' and claim_token=p_claim_token;
  if not found then return exists(select 1 from public.code_analysis_runs where id=p_analysis_run_id and status='completed'); end if;
  update public.code_analysis_route_handoffs set status='completed',completed_at=now()
    where analysis_run_id=p_analysis_run_id and status='queued';
  return true;
end;
$$;

create function public.fail_code_analysis_run(
  p_analysis_run_id uuid,p_claim_token uuid,p_failure_category text,p_retryable boolean
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_failure_category is null or p_failure_category !~ '^[a-z0-9_]{1,80}$' then
    raise exception 'Code analysis failure category is invalid' using errcode='22023';
  end if;
  update public.code_analysis_runs set status=case when p_retryable and attempt_count<8 then 'queued' else 'failed' end,
    coverage_state=case when p_retryable and attempt_count<8 then 'partial' else 'failed' end,
    failure_category=p_failure_category,completed_at=case when p_retryable and attempt_count<8 then null else now() end,
    claim_token=null,lease_expires_at=null
  where id=p_analysis_run_id and status='running' and claim_token=p_claim_token;
  if not found then return false; end if;
  if not p_retryable or not exists(select 1 from public.code_analysis_runs where id=p_analysis_run_id and status='queued') then
    update public.code_analysis_route_handoffs set status='failed' where analysis_run_id=p_analysis_run_id and status='queued';
  end if;
  return true;
end;
$$;

create function public.list_code_intelligence_route_targets(p_route_intent_id uuid)
returns table(
  workspace_id uuid,product_id uuid,repository_id uuid,owner text,name text,
  default_branch text,external_id bigint,installation_id bigint
) language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (
    select 1 from public.intelligence_route_intents intent
    where intent.id=p_route_intent_id and intent.route_status='pending'
      and intent.route_target in (
        'dependency_product_impact','dependency_impact_repository_exposure_candidate',
        'contract_exposure_analysis','repository_dependency_exposure_analysis',
        'contract_repository_exposure_analysis','integration_auth_risk_analysis'
      )
  ) then raise exception 'Code intelligence route intent is not eligible' using errcode='22023'; end if;
  return query
    select mapping.workspace_id,mapping.protected_product_id,repository.id,repository.owner,repository.name,
      repository.default_branch,repository.external_id,connection.installation_id
    from public.workspace_product_repositories mapping
    join public.workspace_products product
      on product.id=mapping.protected_product_id and product.workspace_id=mapping.workspace_id and product.status='protected'
    join public.repositories repository
      on repository.id=mapping.repository_id and repository.workspace_id=mapping.workspace_id
        and repository.status='available'
    join public.repository_connections connection
      on connection.id=repository.connection_id and connection.workspace_id=repository.workspace_id
        and connection.status='connected' and connection.provider='github'
    where mapping.status='active'
    order by mapping.workspace_id,mapping.protected_product_id,repository.id
    limit 51;
end;
$$;

alter table public.code_analysis_runs enable row level security;
alter table public.code_entities enable row level security;
alter table public.code_relations enable row level security;
alter table public.code_external_references enable row level security;
alter table public.code_analysis_skipped_files enable row level security;
alter table public.code_analysis_route_handoffs enable row level security;

revoke all on public.code_analysis_runs,public.code_entities,public.code_relations,
  public.code_external_references,public.code_analysis_skipped_files,public.code_analysis_route_handoffs from public,anon,authenticated;
grant select,insert,update,delete on public.code_analysis_runs,public.code_entities,public.code_relations,
  public.code_external_references,public.code_analysis_skipped_files,public.code_analysis_route_handoffs to service_role;

revoke all on function public.claim_code_analysis_run(uuid,uuid,uuid,text,text,text,text,text,uuid) from public,anon,authenticated;
revoke all on function public.complete_code_analysis_run(uuid,uuid,text,integer,integer,integer,integer,bigint) from public,anon,authenticated;
revoke all on function public.fail_code_analysis_run(uuid,uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.list_code_intelligence_route_targets(uuid) from public,anon,authenticated;
grant execute on function public.claim_code_analysis_run(uuid,uuid,uuid,text,text,text,text,text,uuid) to service_role;
grant execute on function public.complete_code_analysis_run(uuid,uuid,text,integer,integer,integer,integer,bigint) to service_role;
grant execute on function public.fail_code_analysis_run(uuid,uuid,text,boolean) to service_role;
grant execute on function public.list_code_intelligence_route_targets(uuid) to service_role;
