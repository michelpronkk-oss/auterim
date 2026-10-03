-- Auterim Milestone 4: tenant context and isolated customer impact assessments.

alter table public.dependency_context
  add column criticality text not null default 'normal'
    check (criticality in ('critical', 'important', 'normal')),
  add column production_critical boolean not null default false,
  add column used_for jsonb not null default '[]'::jsonb
    check (jsonb_typeof(used_for) = 'array' and jsonb_array_length(used_for) <= 12
      and octet_length(used_for::text) <= 2048
      and used_for <@ '["customer-facing product", "authentication", "billing", "email", "AI processing", "verification", "internal workflows", "analytics", "infrastructure", "database", "other"]'::jsonb),
  add column context_note text not null default '' check (octet_length(context_note) <= 2000),
  add column usage_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(usage_metadata) = 'object' and octet_length(usage_metadata::text) <= 4000);

create table public.impact_assessments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  workspace_dependency_id uuid not null,
  source_change_classification_id uuid not null
    references public.source_change_classifications (id) on delete restrict,
  context_fingerprint text not null check (context_fingerprint ~ '^[a-f0-9]{64}$'),
  impact_engine_version text not null check (char_length(impact_engine_version) between 1 and 80),
  schema_version integer not null check (schema_version > 0),
  prompt_version text not null check (char_length(prompt_version) between 1 and 80),
  provider text not null check (char_length(provider) between 1 and 80),
  model text check (model is null or octet_length(model) <= 160),
  status text not null default 'processing'
    check (status in ('processing', 'assessed', 'failed')),
  trigger_run_id text check (trigger_run_id is null or char_length(trigger_run_id) between 1 and 255),
  attempt_number integer check (attempt_number is null or attempt_number between 1 and 100),
  attempt_count integer not null default 0 check (attempt_count between 0 and 6),
  relevant boolean,
  relevance text check (relevance is null or relevance in ('high', 'medium', 'low', 'none')),
  severity text check (severity is null or severity in ('critical', 'high', 'medium', 'low', 'informational')),
  affected_areas jsonb,
  impact_summary text check (impact_summary is null or octet_length(impact_summary) <= 1200),
  why_it_matters text check (why_it_matters is null or octet_length(why_it_matters) <= 800),
  action_required boolean,
  recommended_action text check (recommended_action is null or octet_length(recommended_action) <= 600),
  confidence numeric(4,3) check (confidence is null or confidence between 0 and 1),
  missing_context jsonb,
  evidence_refs jsonb,
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  error_category text check (error_category is null or char_length(error_category) <= 80),
  error_summary text check (error_summary is null or octet_length(error_summary) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  assessed_at timestamptz,
  constraint impact_assessment_dependency_workspace_fkey
    foreign key (workspace_dependency_id, workspace_id)
    references public.workspace_dependencies (id, workspace_id) on delete cascade,
  constraint impact_assessment_identity_key unique (
    workspace_dependency_id, source_change_classification_id, impact_engine_version,
    schema_version, prompt_version, context_fingerprint
  ),
  constraint impact_assessment_attempt_pair_check check (
    (trigger_run_id is null and attempt_number is null)
    or (trigger_run_id is not null and attempt_number is not null)
  ),
  constraint impact_assessment_output_check check (
    (status = 'assessed' and relevant is not null and relevance is not null and severity is not null
      and affected_areas is not null and jsonb_typeof(affected_areas) = 'array'
      and jsonb_array_length(affected_areas) <= 8 and octet_length(affected_areas::text) <= 2048
      and impact_summary is not null and why_it_matters is not null and action_required is not null
      and confidence is not null and missing_context is not null
      and jsonb_typeof(missing_context) = 'array' and jsonb_array_length(missing_context) <= 10
      and octet_length(missing_context::text) <= 4096 and evidence_refs is not null
      and jsonb_typeof(evidence_refs) = 'array' and jsonb_array_length(evidence_refs) <= 8
      and octet_length(evidence_refs::text) <= 4096 and assessed_at is not null)
    or (status <> 'assessed' and relevant is null and relevance is null and severity is null
      and affected_areas is null and impact_summary is null and why_it_matters is null
      and action_required is null and recommended_action is null and confidence is null
      and missing_context is null and evidence_refs is null and assessed_at is null)
  ),
  constraint impact_assessment_relevance_consistency_check check (
    status <> 'assessed' or ((relevant and relevance <> 'none') or (not relevant and relevance = 'none'))
  ),
  constraint impact_assessment_action_consistency_check check (
    status <> 'assessed' or (action_required = (recommended_action is not null))
  )
);

create index impact_assessments_workspace_attention_idx
  on public.impact_assessments (workspace_id, status, relevant, created_at desc);
create index impact_assessments_classification_idx
  on public.impact_assessments (source_change_classification_id, workspace_dependency_id);

create trigger impact_assessments_set_updated_at
  before update on public.impact_assessments
  for each row execute function private.set_updated_at();

alter table public.impact_assessments enable row level security;
revoke all on public.impact_assessments from public, anon, authenticated;
grant select on public.impact_assessments to authenticated;
grant all on public.impact_assessments to service_role;

create policy impact_assessments_select_member on public.impact_assessments
  for select to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member'])));

create function public.upsert_dependency_impact_context(
  p_workspace_id uuid,
  p_workspace_dependency_id uuid,
  p_criticality text,
  p_production_critical boolean,
  p_used_for jsonb,
  p_context_note text,
  p_usage_metadata jsonb default '{}'::jsonb
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result public.dependency_context%rowtype;
begin
  if p_criticality not in ('critical', 'important', 'normal')
    or p_production_critical is null
    or p_used_for is null or jsonb_typeof(p_used_for) <> 'array'
    or jsonb_array_length(p_used_for) > 12 or octet_length(p_used_for::text) > 2048
    or p_context_note is null or octet_length(p_context_note) > 2000
    or p_usage_metadata is null or jsonb_typeof(p_usage_metadata) <> 'object'
    or octet_length(p_usage_metadata::text) > 4000 then
    raise exception 'Dependency impact context is invalid' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_used_for) as labels(label)
    where jsonb_typeof(label) <> 'string' or label #>> '{}' not in (
      'customer-facing product', 'authentication', 'billing', 'email', 'AI processing',
      'verification', 'internal workflows', 'analytics', 'infrastructure', 'database', 'other'
    )
  ) then
    raise exception 'Dependency impact usage labels are invalid' using errcode = '22023';
  end if;
  insert into public.dependency_context (
    workspace_id, workspace_dependency_id, criticality, production_critical,
    used_for, context_note, usage_metadata
  ) values (
    p_workspace_id, p_workspace_dependency_id, p_criticality, p_production_critical,
    p_used_for, p_context_note, p_usage_metadata
  ) on conflict (workspace_dependency_id) do update set
    criticality = excluded.criticality,
    production_critical = excluded.production_critical,
    used_for = excluded.used_for,
    context_note = excluded.context_note,
    usage_metadata = excluded.usage_metadata
  where dependency_context.workspace_id = excluded.workspace_id
  returning * into result;
  if not found then
    raise exception 'Workspace dependency was not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'workspaceId', result.workspace_id,
    'workspaceDependencyId', result.workspace_dependency_id,
    'criticality', result.criticality,
    'productionCritical', result.production_critical,
    'usedFor', result.used_for,
    'contextNote', result.context_note,
    'usageMetadata', result.usage_metadata,
    'updatedAt', result.updated_at
  );
end;
$$;

create function public.get_dependency_impact_context(
  p_workspace_id uuid, p_workspace_dependency_id uuid
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result public.dependency_context%rowtype;
begin
  select * into result from public.dependency_context
  where workspace_id = p_workspace_id and workspace_dependency_id = p_workspace_dependency_id;
  if not found then
    if not exists (select 1 from public.workspace_dependencies
      where id = p_workspace_dependency_id and workspace_id = p_workspace_id) then
      raise exception 'Workspace dependency was not found' using errcode = 'P0002';
    end if;
    return jsonb_build_object(
      'workspaceId', p_workspace_id, 'workspaceDependencyId', p_workspace_dependency_id,
      'criticality', 'normal', 'productionCritical', false, 'usedFor', '[]'::jsonb,
      'contextNote', '', 'usageMetadata', '{}'::jsonb
    );
  end if;
  return jsonb_build_object(
    'workspaceId', result.workspace_id,
    'workspaceDependencyId', result.workspace_dependency_id,
    'criticality', result.criticality,
    'productionCritical', result.production_critical,
    'usedFor', result.used_for,
    'contextNote', result.context_note,
    'usageMetadata', result.usage_metadata,
    'updatedAt', result.updated_at
  );
end;
$$;

create function public.load_customer_impact_packet(
  p_workspace_dependency_id uuid, p_source_change_classification_id uuid
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  select jsonb_build_object(
    'workspaceId', wd.workspace_id,
    'workspaceDependencyId', wd.id,
    'dependencyName', dependency.name,
    'context', jsonb_build_object(
      'criticality', coalesce(dc.criticality, 'normal'),
      'productionCritical', coalesce(dc.production_critical, false),
      'usedFor', coalesce(dc.used_for, '[]'::jsonb),
      'contextNote', coalesce(dc.context_note, ''),
      'usageMetadata', coalesce(dc.usage_metadata, '{}'::jsonb)
    ),
    'globalChange', jsonb_build_object(
      'sourceType', source.source_type,
      'material', classification.material,
      'category', classification.category,
      'summary', classification.summary,
      'affectedEntities', classification.affected_entities,
      'severityHint', classification.severity_hint,
      'confidence', classification.confidence,
      'evidence', classification.evidence
    )
  ) into result
  from public.workspace_dependencies wd
  join public.dependency_catalog dependency on dependency.id = wd.dependency_id
  left join public.dependency_context dc
    on dc.workspace_dependency_id = wd.id and dc.workspace_id = wd.workspace_id
  join public.source_change_classifications classification
    on classification.id = p_source_change_classification_id
  join public.source_changes change on change.id = classification.change_id
  join public.source_catalog source on source.id = change.source_id
    and source.dependency_id = wd.dependency_id
  where wd.id = p_workspace_dependency_id
    and classification.status = 'classified'
    and classification.material = true
    and classification.decision_status = 'classified'
    and not exists (
      select 1 from public.source_change_classifications newer
      where newer.change_id = classification.change_id
        and newer.status = 'classified'
        and (newer.created_at > classification.created_at
          or (newer.created_at = classification.created_at and newer.id > classification.id))
    );
  if result is null then
    raise exception 'Eligible tenant impact input was not found' using errcode = 'P0002';
  end if;
  return result;
end;
$$;

create function public.begin_customer_impact_assessment(
  p_workspace_dependency_id uuid,
  p_source_change_classification_id uuid,
  p_context_fingerprint text,
  p_impact_engine_version text,
  p_schema_version integer,
  p_prompt_version text,
  p_provider text,
  p_trigger_run_id text,
  p_attempt_number integer
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  wd public.workspace_dependencies%rowtype;
  assessment public.impact_assessments%rowtype;
begin
  if p_context_fingerprint is null or p_context_fingerprint !~ '^[a-f0-9]{64}$'
    or p_impact_engine_version is null or char_length(p_impact_engine_version) not between 1 and 80
    or p_schema_version is null or p_schema_version < 1
    or p_prompt_version is null or char_length(p_prompt_version) not between 1 and 80
    or p_provider is null or char_length(p_provider) not between 1 and 80
    or p_trigger_run_id is null or char_length(p_trigger_run_id) not between 1 and 255
    or p_attempt_number is null or p_attempt_number not between 1 and 100 then
    raise exception 'Impact assessment attempt identity is invalid' using errcode = '22023';
  end if;
  select * into wd from public.workspace_dependencies where id = p_workspace_dependency_id;
  if not found then raise exception 'Workspace dependency was not found' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from public.source_change_classifications c
    join public.source_changes ch on ch.id = c.change_id
    join public.source_catalog s on s.id = ch.source_id
    where c.id = p_source_change_classification_id and c.status = 'classified'
      and c.material = true and c.decision_status = 'classified'
      and s.dependency_id = wd.dependency_id
      and not exists (
        select 1 from public.source_change_classifications newer
        where newer.change_id = c.change_id
          and newer.status = 'classified'
          and (newer.created_at > c.created_at or (newer.created_at = c.created_at and newer.id > c.id))
      )
  ) then
    raise exception 'Eligible tenant impact input was not found' using errcode = 'P0002';
  end if;
  insert into public.impact_assessments (
    workspace_id, workspace_dependency_id, source_change_classification_id,
    context_fingerprint, impact_engine_version, schema_version, prompt_version,
    provider, status
  ) values (
    wd.workspace_id, wd.id, p_source_change_classification_id,
    p_context_fingerprint, p_impact_engine_version, p_schema_version, p_prompt_version,
    p_provider, 'failed'
  ) on conflict (workspace_dependency_id, source_change_classification_id,
    impact_engine_version, schema_version, prompt_version, context_fingerprint) do nothing;
  select * into assessment from public.impact_assessments where
    workspace_dependency_id = wd.id
    and source_change_classification_id = p_source_change_classification_id
    and impact_engine_version = p_impact_engine_version
    and schema_version = p_schema_version and prompt_version = p_prompt_version
    and context_fingerprint = p_context_fingerprint for update;
  if assessment.status = 'assessed' then
    return jsonb_build_object('status', 'assessed', 'id', assessment.id, 'replayed', true,
      'result', jsonb_build_object('relevant', assessment.relevant, 'relevance', assessment.relevance,
        'severity', assessment.severity, 'affectedAreas', assessment.affected_areas,
        'impactSummary', assessment.impact_summary, 'whyItMatters', assessment.why_it_matters,
        'actionRequired', assessment.action_required, 'recommendedAction', assessment.recommended_action,
        'confidence', assessment.confidence, 'missingContext', assessment.missing_context,
        'evidenceRefs', assessment.evidence_refs));
  end if;
  if assessment.attempt_count >= 6 then
    return jsonb_build_object('status', 'busy', 'id', assessment.id);
  end if;
  if assessment.status = 'processing' and assessment.updated_at > now() - interval '1 hour'
    and (assessment.trigger_run_id <> p_trigger_run_id or assessment.attempt_number >= p_attempt_number) then
    return jsonb_build_object('status', 'busy', 'id', assessment.id);
  end if;
  update public.impact_assessments set status = 'processing', trigger_run_id = p_trigger_run_id,
    attempt_number = p_attempt_number, attempt_count = attempt_count + 1,
    provider = p_provider, model = null, relevant = null, relevance = null, severity = null,
    affected_areas = null, impact_summary = null, why_it_matters = null,
    action_required = null, recommended_action = null, confidence = null, missing_context = null,
    evidence_refs = null, input_tokens = null, output_tokens = null, latency_ms = null,
    error_category = null, error_summary = null, assessed_at = null
  where id = assessment.id returning * into assessment;
  return jsonb_build_object('status', 'processing', 'id', assessment.id,
    'attemptCount', assessment.attempt_count);
end;
$$;

create function public.record_customer_impact_assessment(
  p_id uuid, p_trigger_run_id text, p_attempt_number integer,
  p_provider text, p_model text, p_relevant boolean, p_relevance text,
  p_severity text, p_affected_areas jsonb, p_impact_summary text, p_why_it_matters text,
  p_action_required boolean, p_recommended_action text, p_confidence numeric,
  p_missing_context jsonb, p_evidence_refs jsonb,
  p_input_tokens integer default null, p_output_tokens integer default null,
  p_latency_ms integer default null
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare assessment public.impact_assessments%rowtype;
begin
  if p_relevant is null or p_relevance not in ('high','medium','low','none')
    or (p_relevant and p_relevance = 'none') or (not p_relevant and p_relevance <> 'none')
    or p_severity not in ('critical','high','medium','low','informational')
    or p_affected_areas is null or jsonb_typeof(p_affected_areas) <> 'array'
      or jsonb_array_length(p_affected_areas) > 8 or octet_length(p_affected_areas::text) > 2048
    or p_impact_summary is null or octet_length(p_impact_summary) > 1200
    or p_why_it_matters is null or octet_length(p_why_it_matters) > 800
    or p_action_required is null or (p_action_required <> (p_recommended_action is not null))
    or (p_recommended_action is not null and octet_length(p_recommended_action) > 600)
    or p_confidence is null or p_confidence < 0 or p_confidence > 1
    or p_missing_context is null or jsonb_typeof(p_missing_context) <> 'array'
      or jsonb_array_length(p_missing_context) > 10 or octet_length(p_missing_context::text) > 4096
    or p_evidence_refs is null or jsonb_typeof(p_evidence_refs) <> 'array'
      or jsonb_array_length(p_evidence_refs) > 8 or octet_length(p_evidence_refs::text) > 4096 then
    raise exception 'Impact assessment failed persistence validation' using errcode = '22023';
  end if;
  update public.impact_assessments set status = 'assessed', provider = p_provider, model = p_model,
    relevant = p_relevant, relevance = p_relevance, severity = p_severity,
    affected_areas = p_affected_areas, impact_summary = p_impact_summary,
    why_it_matters = p_why_it_matters, action_required = p_action_required,
    recommended_action = p_recommended_action, confidence = p_confidence,
    missing_context = p_missing_context, evidence_refs = p_evidence_refs,
    input_tokens = p_input_tokens, output_tokens = p_output_tokens, latency_ms = p_latency_ms,
    error_category = null, error_summary = null, assessed_at = now()
  where id = p_id and status = 'processing' and trigger_run_id = p_trigger_run_id
    and attempt_number = p_attempt_number
    and exists (
      select 1
      from public.impact_assessments current_assessment
      join public.source_change_classifications classification
        on classification.id = current_assessment.source_change_classification_id
      where current_assessment.id = p_id
        and classification.status = 'classified'
        and classification.material = true
        and classification.decision_status = 'classified'
        and not exists (
          select 1 from public.source_change_classifications newer
          where newer.change_id = classification.change_id
            and newer.status = 'classified'
            and (newer.created_at > classification.created_at
              or (newer.created_at = classification.created_at and newer.id > classification.id))
        )
    ) returning * into assessment;
  if not found then raise exception 'Impact assessment attempt is no longer current' using errcode = '40001'; end if;
  return jsonb_build_object('status', 'assessed', 'id', assessment.id, 'replayed', false);
end;
$$;

create function public.fail_customer_impact_assessment(
  p_id uuid, p_trigger_run_id text, p_attempt_number integer,
  p_error_category text, p_error_summary text
)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.impact_assessments set status = 'failed',
    relevant = null, relevance = null, severity = null, affected_areas = null,
    impact_summary = null, why_it_matters = null, action_required = null,
    recommended_action = null, confidence = null, missing_context = null,
    evidence_refs = null, assessed_at = null,
    error_category = left(coalesce(p_error_category, 'impact_classification_error'), 80),
    error_summary = left(coalesce(p_error_summary, 'Customer impact assessment failed.'), 1000)
  where id = p_id and status = 'processing' and trigger_run_id = p_trigger_run_id
    and attempt_number = p_attempt_number;
  if not found then raise exception 'Impact assessment attempt is no longer current' using errcode = '40001'; end if;
end;
$$;

revoke all on function public.upsert_dependency_impact_context(uuid,uuid,text,boolean,jsonb,text,jsonb) from public, anon;
revoke all on function public.get_dependency_impact_context(uuid,uuid) from public, anon;
revoke all on function public.load_customer_impact_packet(uuid,uuid) from public, anon, authenticated;
revoke all on function public.begin_customer_impact_assessment(uuid,uuid,text,text,integer,text,text,text,integer) from public, anon, authenticated;
revoke all on function public.record_customer_impact_assessment(uuid,text,integer,text,text,boolean,text,text,jsonb,text,text,boolean,text,numeric,jsonb,jsonb,integer,integer,integer) from public, anon, authenticated;
revoke all on function public.fail_customer_impact_assessment(uuid,text,integer,text,text) from public, anon, authenticated;
grant execute on function public.upsert_dependency_impact_context(uuid,uuid,text,boolean,jsonb,text,jsonb) to service_role;
grant execute on function public.get_dependency_impact_context(uuid,uuid) to service_role;
grant execute on function public.load_customer_impact_packet(uuid,uuid) to service_role;
grant execute on function public.begin_customer_impact_assessment(uuid,uuid,text,text,integer,text,text,text,integer) to service_role;
grant execute on function public.record_customer_impact_assessment(uuid,text,integer,text,text,boolean,text,text,jsonb,text,text,boolean,text,numeric,jsonb,jsonb,integer,integer,integer) to service_role;
grant execute on function public.fail_customer_impact_assessment(uuid,text,integer,text,text) to service_role;

-- Durable fan-out outbox. Revisions enqueue fresh assessments when context changes.
alter table public.dependency_context
  add column context_revision bigint not null default 1 check (context_revision > 0);

create table public.customer_impact_dispatch_queue (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  workspace_dependency_id uuid not null,
  source_change_classification_id uuid not null
    references public.source_change_classifications (id) on delete restrict,
  context_revision bigint not null check (context_revision >= 0),
  status text not null default 'queued'
    check (status in ('queued', 'dispatched', 'complete', 'failed', 'superseded')),
  dispatch_attempt_count integer not null default 0 check (dispatch_attempt_count between 0 and 6),
  error_category text check (error_category is null or char_length(error_category) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_impact_queue_dependency_workspace_fkey
    foreign key (workspace_dependency_id, workspace_id)
    references public.workspace_dependencies (id, workspace_id) on delete cascade,
  constraint customer_impact_queue_identity_key unique (
    workspace_dependency_id, source_change_classification_id, context_revision
  )
);

create index customer_impact_queue_pending_idx
  on public.customer_impact_dispatch_queue (created_at, id)
  where status in ('queued', 'failed');
create index customer_impact_queue_dependency_idx
  on public.customer_impact_dispatch_queue (workspace_dependency_id, status, created_at desc);

create trigger customer_impact_queue_set_updated_at
  before update on public.customer_impact_dispatch_queue
  for each row execute function private.set_updated_at();

create function private.enqueue_customer_impact_for_dependency(
  p_workspace_dependency_id uuid, p_context_revision bigint
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.customer_impact_dispatch_queue (
    workspace_id, workspace_dependency_id, source_change_classification_id, context_revision
  )
  select wd.workspace_id, wd.id, classification.id, p_context_revision
  from public.workspace_dependencies wd
  join public.source_catalog source on source.dependency_id = wd.dependency_id
  join public.source_changes change on change.source_id = source.id
  join public.source_change_classifications classification on classification.change_id = change.id
  where wd.id = p_workspace_dependency_id
    and classification.status = 'classified'
    and classification.material = true
    and classification.decision_status = 'classified'
    and not exists (
      select 1 from public.source_change_classifications newer
      where newer.change_id = classification.change_id
        and newer.status = 'classified'
        and (newer.created_at > classification.created_at
          or (newer.created_at = classification.created_at and newer.id > classification.id))
    )
  on conflict (workspace_dependency_id, source_change_classification_id, context_revision) do nothing;
end;
$$;

create function private.enqueue_customer_impacts_on_dependency_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.enqueue_customer_impact_for_dependency(new.id, 0);
  return new;
end;
$$;

create trigger workspace_dependencies_enqueue_existing_impacts
  after insert on public.workspace_dependencies
  for each row execute function private.enqueue_customer_impacts_on_dependency_insert();

create function private.bump_dependency_context_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.criticality is distinct from old.criticality
    or new.production_critical is distinct from old.production_critical
    or new.used_for is distinct from old.used_for
    or new.context_note is distinct from old.context_note
    or new.usage_metadata is distinct from old.usage_metadata then
    new.context_revision := old.context_revision + 1;
  else
    new.context_revision := old.context_revision;
  end if;
  return new;
end;
$$;

create trigger dependency_context_bump_revision
  before update on public.dependency_context
  for each row execute function private.bump_dependency_context_revision();

create function private.enqueue_customer_impacts_on_context_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE'
    and new.criticality is not distinct from old.criticality
    and new.production_critical is not distinct from old.production_critical
    and new.used_for is not distinct from old.used_for
    and new.context_note is not distinct from old.context_note
    and new.usage_metadata is not distinct from old.usage_metadata then
    return new;
  end if;
  update public.customer_impact_dispatch_queue
  set status = 'superseded'
  where workspace_dependency_id = new.workspace_dependency_id and status = 'queued';
  perform private.enqueue_customer_impact_for_dependency(new.workspace_dependency_id, new.context_revision);
  return new;
end;
$$;

create trigger dependency_context_enqueue_impacts
  after insert or update on public.dependency_context
  for each row execute function private.enqueue_customer_impacts_on_context_change();

create function private.enqueue_customer_impacts_on_classification()
returns trigger language plpgsql security definer set search_path = '' as $$
declare context_revision_value bigint;
begin
  if new.status <> 'classified' or new.material is distinct from true
    or new.decision_status <> 'classified' then
    return new;
  end if;
  if exists (
    select 1 from public.source_change_classifications newer
    where newer.change_id = new.change_id
      and newer.status = 'classified'
      and (newer.created_at > new.created_at
        or (newer.created_at = new.created_at and newer.id > new.id))
  ) then
    return new;
  end if;
  update public.customer_impact_dispatch_queue old_queue
  set status = 'superseded'
  from public.source_change_classifications old_classification
  where old_queue.source_change_classification_id = old_classification.id
    and old_classification.change_id = new.change_id
    and old_classification.id <> new.id
    and old_queue.status in ('queued', 'failed');
  insert into public.customer_impact_dispatch_queue (
    workspace_id, workspace_dependency_id, source_change_classification_id, context_revision
  )
  select wd.workspace_id, wd.id, new.id, coalesce(dc.context_revision, 0)
  from public.source_changes change
  join public.source_catalog source on source.id = change.source_id
  join public.workspace_dependencies wd on wd.dependency_id = source.dependency_id
  left join public.dependency_context dc
    on dc.workspace_dependency_id = wd.id and dc.workspace_id = wd.workspace_id
  where change.id = new.change_id
    and not exists (
      select 1 from public.source_change_classifications newer
      where newer.change_id = new.change_id
        and newer.status = 'classified'
        and (newer.created_at > new.created_at
          or (newer.created_at = new.created_at and newer.id > new.id))
    )
  on conflict (workspace_dependency_id, source_change_classification_id, context_revision) do nothing;
  return new;
end;
$$;

create trigger source_change_classifications_enqueue_customer_impacts
  after insert or update of status, material, decision_status on public.source_change_classifications
  for each row execute function private.enqueue_customer_impacts_on_classification();

-- Backfill already-classified material events into the durable outbox.
insert into public.customer_impact_dispatch_queue (
  workspace_id, workspace_dependency_id, source_change_classification_id, context_revision
)
select wd.workspace_id, wd.id, classification.id, coalesce(dc.context_revision, 0)
from public.source_change_classifications classification
join public.source_changes change on change.id = classification.change_id
join public.source_catalog source on source.id = change.source_id
join public.workspace_dependencies wd on wd.dependency_id = source.dependency_id
left join public.dependency_context dc
  on dc.workspace_dependency_id = wd.id and dc.workspace_id = wd.workspace_id
where classification.status = 'classified'
  and classification.material = true
  and classification.decision_status = 'classified'
  and not exists (
    select 1 from public.source_change_classifications newer
    where newer.change_id = classification.change_id
      and newer.status = 'classified'
      and (newer.created_at > classification.created_at
        or (newer.created_at = classification.created_at and newer.id > classification.id))
  )
on conflict (workspace_dependency_id, source_change_classification_id, context_revision) do nothing;

create function public.list_customer_impact_dispatch_queue(
  p_source_change_id uuid default null, p_limit integer default 100
)
returns table (
  queue_id uuid, workspace_dependency_id uuid, source_change_classification_id uuid,
  context_revision bigint
)
language sql security invoker set search_path = '' as $$
  select queue.id, queue.workspace_dependency_id, queue.source_change_classification_id,
    queue.context_revision
  from public.customer_impact_dispatch_queue queue
  join public.source_change_classifications classification
    on classification.id = queue.source_change_classification_id
  where (p_source_change_id is null or classification.change_id = p_source_change_id)
    and not exists (
      select 1 from public.source_change_classifications newer
      where newer.change_id = classification.change_id
        and newer.status = 'classified'
        and (newer.created_at > classification.created_at
          or (newer.created_at = classification.created_at and newer.id > classification.id))
    )
    and queue.dispatch_attempt_count < 6
    and (
      queue.status = 'queued'
      or (queue.status = 'failed' and coalesce(queue.error_category, '') <> 'permanent_configuration')
      or (queue.status = 'dispatched' and queue.updated_at < now() - interval '15 minutes')
    )
  order by queue.created_at, queue.id
  limit least(greatest(coalesce(p_limit, 1), 1), 100);
$$;

create function public.mark_customer_impact_queue_dispatched(p_queue_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.customer_impact_dispatch_queue
  set status = 'dispatched', dispatch_attempt_count = dispatch_attempt_count + 1,
    error_category = null
  where id = p_queue_id and dispatch_attempt_count < 6
    and (status in ('queued', 'failed') or (status = 'dispatched' and updated_at < now() - interval '15 minutes'));
  if not found then raise exception 'Impact queue item is no longer dispatchable' using errcode = '40001'; end if;
end;
$$;

create function public.mark_customer_impact_queue_complete(p_queue_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.customer_impact_dispatch_queue set status = 'complete', error_category = null
  where id = p_queue_id and status = 'dispatched';
  if not found and not exists (
    select 1 from public.customer_impact_dispatch_queue where id = p_queue_id and status = 'complete'
  ) then
    raise exception 'Impact queue item is no longer current' using errcode = '40001';
  end if;
end;
$$;

create function public.mark_customer_impact_queue_failed(p_queue_id uuid, p_error_category text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.customer_impact_dispatch_queue
  set status = 'failed', error_category = left(coalesce(p_error_category, 'impact_task_failed'), 80)
  where id = p_queue_id and status = 'dispatched';
  if not found and not exists (
    select 1 from public.customer_impact_dispatch_queue
    where id = p_queue_id and status = 'failed'
  ) then
    raise exception 'Impact queue item is no longer current' using errcode = '40001';
  end if;
end;
$$;

alter table public.customer_impact_dispatch_queue enable row level security;
revoke all on public.customer_impact_dispatch_queue from public, anon, authenticated;
grant all on public.customer_impact_dispatch_queue to service_role;

revoke all on function private.enqueue_customer_impact_for_dependency(uuid,bigint) from public, anon, authenticated;
revoke all on function private.enqueue_customer_impacts_on_dependency_insert() from public, anon, authenticated;
revoke all on function private.bump_dependency_context_revision() from public, anon, authenticated;
revoke all on function private.enqueue_customer_impacts_on_context_change() from public, anon, authenticated;
revoke all on function private.enqueue_customer_impacts_on_classification() from public, anon, authenticated;
revoke all on function public.list_customer_impact_dispatch_queue(uuid,integer) from public, anon, authenticated;
revoke all on function public.mark_customer_impact_queue_dispatched(uuid) from public, anon, authenticated;
revoke all on function public.mark_customer_impact_queue_complete(uuid) from public, anon, authenticated;
revoke all on function public.mark_customer_impact_queue_failed(uuid,text) from public, anon, authenticated;
grant execute on function public.list_customer_impact_dispatch_queue(uuid,integer) to service_role;
grant execute on function public.mark_customer_impact_queue_dispatched(uuid) to service_role;
grant execute on function public.mark_customer_impact_queue_complete(uuid) to service_role;
grant execute on function public.mark_customer_impact_queue_failed(uuid,text) to service_role;
