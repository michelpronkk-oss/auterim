-- Auterim Milestone 3: immutable, versioned interpretations of global source changes.
create table public.source_change_classifications (
  id uuid primary key default gen_random_uuid(),
  change_id uuid not null references public.source_changes (id) on delete restrict,
  classifier_version text not null check (char_length(classifier_version) between 1 and 80),
  schema_version integer not null check (schema_version > 0),
  prompt_version text not null check (char_length(prompt_version) between 1 and 80),
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[a-f0-9]{32}$'),
  provider text not null check (char_length(provider) between 1 and 80),
  model text check (model is null or octet_length(model) <= 160),
  status text not null default 'queued' check (status in ('queued', 'processing', 'classified', 'failed')),
  trigger_run_id text check (trigger_run_id is null or char_length(trigger_run_id) between 1 and 255),
  attempt_number integer check (attempt_number is null or attempt_number between 1 and 100),
  attempts_count integer not null default 0 check (attempts_count between 0 and 6),
  material boolean,
  category text check (category is null or category in ('pricing','api_change','deprecation','limits','terms','feature_change','availability','documentation','security','other')),
  affected_entities jsonb,
  severity_hint text check (severity_hint is null or severity_hint in ('critical','high','medium','low','informational')),
  confidence numeric(4,3) check (confidence is null or confidence between 0 and 1),
  summary text check (summary is null or octet_length(summary) <= 1200),
  evidence jsonb check (evidence is null or (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) <= 5 and octet_length(evidence::text) <= 4096)),
  reasoning_summary text check (reasoning_summary is null or octet_length(reasoning_summary) <= 600),
  decision_status text check (decision_status is null or decision_status in ('classified','review_required')),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  error_category text check (error_category is null or char_length(error_category) <= 80),
  error_summary text check (error_summary is null or octet_length(error_summary) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  classified_at timestamptz,
  constraint source_change_classification_identity_key unique (change_id, classifier_version, schema_version, prompt_version, provider, evidence_fingerprint),
  constraint source_change_classification_state_check check (
    (status = 'classified' and material is not null and category is not null and affected_entities is not null
      and severity_hint is not null and confidence is not null and summary is not null and evidence is not null
      and reasoning_summary is not null and decision_status is not null and classified_at is not null)
    or (status <> 'classified' and material is null and category is null and affected_entities is null
      and severity_hint is null and confidence is null and summary is null and evidence is null
      and reasoning_summary is null and decision_status is null and classified_at is null)
  ),
  constraint source_change_classification_attempt_pair_check check (
    (trigger_run_id is null and attempt_number is null) or (trigger_run_id is not null and attempt_number is not null)
  ),
  constraint source_change_classification_entities_check check (
    affected_entities is null or (jsonb_typeof(affected_entities) = 'array' and jsonb_array_length(affected_entities) <= 5 and octet_length(affected_entities::text) <= 2048)
  )
);

create index source_change_classifications_status_created_idx
  on public.source_change_classifications (status, created_at)
  where status in ('queued', 'failed');
create index source_change_classifications_change_created_idx
  on public.source_change_classifications (change_id, created_at desc);

create trigger source_change_classifications_set_updated_at
  before update on public.source_change_classifications
  for each row execute function private.set_updated_at();

create function private.queue_source_change_classification()
returns trigger language plpgsql security definer set search_path = '' as $$
declare fingerprint text;
begin
  select md5(ch.diff_text || ':' || old_snapshot.content_hash || ':' || new_snapshot.content_hash)
    into fingerprint
  from public.source_changes ch
  join public.source_snapshots old_snapshot on old_snapshot.id = ch.previous_snapshot_id
  join public.source_snapshots new_snapshot on new_snapshot.id = ch.new_snapshot_id
  where ch.id = new.id;
  insert into public.source_change_classifications (
    change_id, classifier_version, schema_version, prompt_version, evidence_fingerprint, provider
  ) values (new.id, 'semantic-v1', 1, 'materiality-v1', fingerprint, 'ai-gateway')
  on conflict (change_id, classifier_version, schema_version, prompt_version, provider, evidence_fingerprint) do nothing;
  return new;
end;
$$;
revoke all on function private.queue_source_change_classification() from public, anon, authenticated;
create trigger source_changes_queue_classification after insert on public.source_changes
  for each row execute function private.queue_source_change_classification();

create function public.begin_source_change_classification(
  p_source_change_id uuid, p_trigger_run_id text, p_attempt_number integer,
  p_classifier_version text, p_schema_version integer, p_prompt_version text, p_provider text
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  c public.source_change_classifications%rowtype;
  ch public.source_changes%rowtype;
  src public.source_catalog%rowtype;
  dep public.dependency_catalog%rowtype;
  old_snapshot public.source_snapshots%rowtype;
  new_snapshot public.source_snapshots%rowtype;
  fingerprint text;
begin
  if p_trigger_run_id is null or char_length(p_trigger_run_id) not between 1 and 255
     or p_attempt_number is null or p_attempt_number not between 1 and 100
     or p_classifier_version is null or char_length(p_classifier_version) not between 1 and 80
     or p_schema_version is null or p_schema_version < 1
     or p_prompt_version is null or char_length(p_prompt_version) not between 1 and 80
     or p_provider is null or char_length(p_provider) not between 1 and 80 then
    raise exception 'Classification attempt identity is invalid' using errcode = '22023';
  end if;
  select * into ch from public.source_changes where id = p_source_change_id;
  if not found then raise exception 'Source change was not found' using errcode = 'P0002'; end if;
  select * into old_snapshot from public.source_snapshots where id = ch.previous_snapshot_id;
  select * into new_snapshot from public.source_snapshots where id = ch.new_snapshot_id;
  fingerprint := md5(ch.diff_text || ':' || old_snapshot.content_hash || ':' || new_snapshot.content_hash);
  insert into public.source_change_classifications (
    change_id, classifier_version, schema_version, prompt_version, evidence_fingerprint, provider
  ) values (p_source_change_id, p_classifier_version, p_schema_version, p_prompt_version, fingerprint, p_provider)
  on conflict (change_id, classifier_version, schema_version, prompt_version, provider, evidence_fingerprint) do nothing;
  select * into c from public.source_change_classifications
    where change_id = p_source_change_id and classifier_version = p_classifier_version
      and schema_version = p_schema_version and prompt_version = p_prompt_version
      and provider = p_provider and evidence_fingerprint = fingerprint
    for update;
  if c.status = 'classified' then
    return jsonb_build_object('status','classified','changeId',p_source_change_id,'classification',jsonb_build_object(
      'material',c.material,'category',c.category,'affectedEntities',c.affected_entities,'severityHint',c.severity_hint,
      'confidence',c.confidence,'summary',c.summary,'evidence',c.evidence,'reasoningSummary',c.reasoning_summary,
      'decisionStatus',c.decision_status),'replayed',true);
  end if;
  if c.attempts_count >= 6 then
    return jsonb_build_object('status','busy','changeId',p_source_change_id);
  end if;
  if c.status = 'processing' and c.updated_at > now() - interval '1 hour'
     and (c.trigger_run_id <> p_trigger_run_id or c.attempt_number >= p_attempt_number) then
    return jsonb_build_object('status','busy','changeId',p_source_change_id);
  end if;
  select * into src from public.source_catalog where id = ch.source_id;
  select * into dep from public.dependency_catalog where id = src.dependency_id;
  update public.source_change_classifications set status='processing', trigger_run_id=p_trigger_run_id,
    attempt_number=p_attempt_number, attempts_count=attempts_count+1, provider=p_provider, model=null, material=null, category=null,
    affected_entities=null, severity_hint=null, confidence=null, summary=null, evidence=null,
    reasoning_summary=null, decision_status=null, input_tokens=null, output_tokens=null, latency_ms=null,
    error_category=null, error_summary=null, classified_at=null where id=c.id;
  return jsonb_build_object('status','processing','changeId',p_source_change_id,'schemaVersion',p_schema_version,
    'promptVersion',p_prompt_version,'classifierVersion',p_classifier_version,'provider',p_provider,
    'evidenceFingerprint',fingerprint,'triggerRunId',p_trigger_run_id,'attemptNumber',p_attempt_number,
    'change',jsonb_build_object('sourceName',src.name,'sourceType',src.source_type,'sourceUrl',src.url,
      'dependencyName',dep.name,'beforeVersion',old_snapshot.version,'afterVersion',new_snapshot.version,
      'diffText',ch.diff_text,'addedLines',ch.added_lines,'removedLines',ch.removed_lines,
      'diffTruncated',ch.diff_truncated,'beforeBytes',ch.previous_bytes,'afterBytes',ch.new_bytes));
end;
$$;

create function public.record_source_change_classification(
  p_source_change_id uuid, p_classifier_version text, p_evidence_fingerprint text,
  p_trigger_run_id text, p_attempt_number integer, p_provider text, p_model text,
  p_schema_version integer, p_prompt_version text, p_material boolean, p_category text,
  p_affected_entities jsonb, p_severity_hint text, p_confidence numeric, p_summary text,
  p_evidence jsonb, p_reasoning_summary text, p_decision_status text,
  p_input_tokens integer default null, p_output_tokens integer default null, p_latency_ms integer default null
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c public.source_change_classifications%rowtype;
begin
  if p_provider is null or char_length(p_provider) not between 1 and 80
    or p_model is null or octet_length(p_model)>160 or p_schema_version < 1
    or p_prompt_version is null or char_length(p_prompt_version) not between 1 and 80
    or p_material is null or p_category not in ('pricing','api_change','deprecation','limits','terms','feature_change','availability','documentation','security','other')
    or p_affected_entities is null or jsonb_typeof(p_affected_entities)<>'array' or jsonb_array_length(p_affected_entities)>5 or octet_length(p_affected_entities::text)>2048
    or p_severity_hint not in ('critical','high','medium','low','informational')
    or p_confidence is null or p_confidence<0 or p_confidence>1
    or p_summary is null or octet_length(p_summary)>1200
    or p_evidence is null or jsonb_typeof(p_evidence)<>'array' or jsonb_array_length(p_evidence)>5 or octet_length(p_evidence::text)>4096
    or p_reasoning_summary is null or octet_length(p_reasoning_summary)>600
    or p_decision_status not in ('classified','review_required') then
    raise exception 'Semantic classification failed persistence validation' using errcode = '22023';
  end if;
  update public.source_change_classifications set status='classified', provider=p_provider, model=p_model,
    schema_version=p_schema_version, prompt_version=p_prompt_version, material=p_material, category=p_category,
    affected_entities=p_affected_entities, severity_hint=p_severity_hint, confidence=p_confidence,
    summary=p_summary, evidence=p_evidence, reasoning_summary=p_reasoning_summary,
    decision_status=p_decision_status, input_tokens=p_input_tokens, output_tokens=p_output_tokens,
    latency_ms=p_latency_ms, error_category=null, error_summary=null, classified_at=now()
  where change_id=p_source_change_id and classifier_version=p_classifier_version
    and schema_version=p_schema_version and prompt_version=p_prompt_version and provider=p_provider
    and evidence_fingerprint=p_evidence_fingerprint and status='processing'
    and trigger_run_id=p_trigger_run_id and attempt_number=p_attempt_number returning * into c;
  if not found then
    select * into c from public.source_change_classifications where change_id=p_source_change_id
      and classifier_version=p_classifier_version and schema_version=p_schema_version
      and prompt_version=p_prompt_version and provider=p_provider and evidence_fingerprint=p_evidence_fingerprint;
    if c.status='classified' then
      return jsonb_build_object('status',c.status,'changeId',p_source_change_id,'classification',jsonb_build_object(
        'material',c.material,'category',c.category,'affectedEntities',c.affected_entities,'severityHint',c.severity_hint,
        'confidence',c.confidence,'summary',c.summary,'evidence',c.evidence,'reasoningSummary',c.reasoning_summary,
        'decisionStatus',c.decision_status),'replayed',true);
    end if;
    raise exception 'Classification attempt is no longer current' using errcode = '40001';
  end if;
  return jsonb_build_object('status',c.status,'changeId',p_source_change_id,'classification',jsonb_build_object(
    'material',c.material,'category',c.category,'affectedEntities',c.affected_entities,'severityHint',c.severity_hint,
    'confidence',c.confidence,'summary',c.summary,'evidence',c.evidence,'reasoningSummary',c.reasoning_summary,
    'decisionStatus',c.decision_status),'replayed',false);
end;
$$;

create function public.record_source_change_classification_failure(
  p_source_change_id uuid, p_classifier_version text, p_evidence_fingerprint text,
  p_trigger_run_id text, p_attempt_number integer, p_provider text, p_schema_version integer,
  p_prompt_version text, p_error_category text, p_error_summary text
)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.source_change_classifications set status='failed', material=null, category=null,
    affected_entities=null, severity_hint=null, confidence=null, summary=null, evidence=null,
    reasoning_summary=null, decision_status=null, classified_at=null,
    error_category=left(coalesce(p_error_category,'classification_error'),80),
    error_summary=left(coalesce(p_error_summary,'Semantic classification failed.'),1000)
  where change_id=p_source_change_id and classifier_version=p_classifier_version
    and schema_version=p_schema_version and prompt_version=p_prompt_version and provider=p_provider
    and evidence_fingerprint=p_evidence_fingerprint and status='processing'
    and trigger_run_id=p_trigger_run_id and attempt_number=p_attempt_number;
  if not found then raise exception 'Classification attempt is no longer current' using errcode = '40001'; end if;
end;
$$;

create function public.list_queued_source_change_classification_ids(p_limit integer default 100)
returns table (change_id uuid) language sql security invoker set search_path = '' as $$
  select c.change_id from public.source_change_classifications c
  where ((c.status in ('queued','failed') and coalesce(c.error_category,'') <> 'permanent_configuration')
    or (c.status='processing' and c.updated_at < now() - interval '1 hour'))
    and c.attempts_count < 6
  order by c.created_at,c.change_id limit least(greatest(coalesce(p_limit,1),1),100);
$$;

alter table public.source_change_classifications enable row level security;
revoke all on public.source_change_classifications from public, anon, authenticated;
grant select,insert,update,delete on public.source_change_classifications to service_role;
revoke all on function public.begin_source_change_classification(uuid,text,integer,text,integer,text,text) from public,anon,authenticated;
revoke all on function public.record_source_change_classification(uuid,text,text,text,integer,text,text,integer,text,boolean,text,jsonb,text,numeric,text,jsonb,text,text,integer,integer,integer) from public,anon,authenticated;
revoke all on function public.record_source_change_classification_failure(uuid,text,text,text,integer,text,integer,text,text,text) from public,anon,authenticated;
revoke all on function public.list_queued_source_change_classification_ids(integer) from public,anon,authenticated;
grant execute on function public.begin_source_change_classification(uuid,text,integer,text,integer,text,text) to service_role;
grant execute on function public.record_source_change_classification(uuid,text,text,text,integer,text,text,integer,text,boolean,text,jsonb,text,numeric,text,jsonb,text,text,integer,integer,integer) to service_role;
grant execute on function public.record_source_change_classification_failure(uuid,text,text,text,integer,text,integer,text,text,text) to service_role;
grant execute on function public.list_queued_source_change_classification_ids(integer) to service_role;
