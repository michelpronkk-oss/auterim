-- M15.75A: provider-neutral, server-only shadow intelligence decisions.
create table public.change_intelligence_decisions (
  id uuid primary key default gen_random_uuid(),
  source_change_id uuid not null references public.source_changes (id) on delete restrict,
  engine_version text not null check (char_length(engine_version) between 1 and 80),
  policy_version text not null check (char_length(policy_version) between 1 and 80),
  provider text not null check (char_length(provider) between 1 and 80),
  model text not null check (char_length(model) between 1 and 160),
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[a-f0-9]{32}$'),
  status text not null default 'queued' check (status in ('queued','processing','completed','failed')),
  trigger_run_id text check (trigger_run_id is null or char_length(trigger_run_id) between 1 and 255),
  attempt_number integer check (attempt_number is null or attempt_number between 1 and 100),
  attempts_count integer not null default 0 check (attempts_count between 0 and 8),
  proposed_route text check (proposed_route is null or proposed_route in (
    'docs_noise','deprecation','breaking_api_change','auth_or_security_change',
    'schema_or_contract_change','pricing_change','limits_or_quota_change','sdk_change',
    'webhook_or_event_change','feature_change','availability_or_runtime_change',
    'terms_or_policy_change','uncertain'
  )),
  probabilities jsonb check (probabilities is null or (
    jsonb_typeof(probabilities) = 'object' and octet_length(probabilities::text) <= 4096
  )),
  confidence numeric(5,4) check (confidence is null or confidence between 0 and 1),
  evidence_quality jsonb check (evidence_quality is null or (
    jsonb_typeof(evidence_quality) = 'object' and octet_length(evidence_quality::text) <= 2048
  )),
  proposed_policy_state text check (proposed_policy_state is null or proposed_policy_state in (
    'suppress_candidate','continue_candidate','escalate','insufficient_evidence'
  )),
  latency_ms integer check (latency_ms is null or latency_ms between 0 and 120000),
  input_tokens integer check (input_tokens is null or input_tokens between 0 and 1000000),
  output_tokens integer check (output_tokens is null or output_tokens between 0 and 1000000),
  cost_usd numeric(12,8) check (cost_usd is null or cost_usd between 0 and 100),
  error_category text check (error_category is null or error_category ~ '^[a-z0-9_]{1,80}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint change_intelligence_decision_identity_key unique
    (source_change_id, engine_version, policy_version, provider, model, evidence_fingerprint),
  constraint change_intelligence_decision_attempt_pair_check check (
    (trigger_run_id is null and attempt_number is null) or
    (trigger_run_id is not null and attempt_number is not null)
  ),
  constraint change_intelligence_decision_state_check check (
    (status = 'completed' and proposed_route is not null and probabilities is not null
      and confidence is not null and evidence_quality is not null
      and proposed_policy_state is not null and completed_at is not null and error_category is null)
    or (status <> 'completed' and proposed_route is null and probabilities is null
      and confidence is null and evidence_quality is null and proposed_policy_state is null
      and completed_at is null)
  )
);

create index change_intelligence_decisions_queue_idx
  on public.change_intelligence_decisions (status, created_at, source_change_id)
  where status in ('queued','failed');
create index change_intelligence_decisions_source_idx
  on public.change_intelligence_decisions (source_change_id, created_at desc);
create trigger change_intelligence_decisions_set_updated_at
  before update on public.change_intelligence_decisions
  for each row execute function private.set_updated_at();

create function private.queue_source_change_intelligence()
returns trigger language plpgsql security definer set search_path = '' as $$
declare fingerprint text;
begin
  select md5(ch.diff_text || ':' || old_snapshot.content_hash || ':' || new_snapshot.content_hash)
    into fingerprint
  from public.source_changes ch
  join public.source_snapshots old_snapshot on old_snapshot.id = ch.previous_snapshot_id
  join public.source_snapshots new_snapshot on new_snapshot.id = ch.new_snapshot_id
  where ch.id = new.id;
  insert into public.change_intelligence_decisions (
    source_change_id, engine_version, policy_version, provider, model, evidence_fingerprint
  ) values (
    new.id, 'jev-shadow-v1', 'intelligence-policy-v1', 'openrouter',
    'typesafe/jev-1.14', fingerprint
  ) on conflict (source_change_id, engine_version, policy_version, provider, model, evidence_fingerprint)
    do nothing;
  return new;
end;
$$;
revoke all on function private.queue_source_change_intelligence() from public, anon, authenticated;
create trigger source_changes_queue_intelligence after insert on public.source_changes
  for each row execute function private.queue_source_change_intelligence();

-- Backfill immutable global source changes so a temporary dispatch/provider failure is recoverable.
insert into public.change_intelligence_decisions (
  source_change_id, engine_version, policy_version, provider, model, evidence_fingerprint
)
select ch.id, 'jev-shadow-v1', 'intelligence-policy-v1', 'openrouter', 'typesafe/jev-1.14',
  md5(ch.diff_text || ':' || old_snapshot.content_hash || ':' || new_snapshot.content_hash)
from public.source_changes ch
join public.source_snapshots old_snapshot on old_snapshot.id = ch.previous_snapshot_id
join public.source_snapshots new_snapshot on new_snapshot.id = ch.new_snapshot_id
on conflict (source_change_id, engine_version, policy_version, provider, model, evidence_fingerprint)
  do nothing;

create function public.begin_source_change_intelligence(
  p_source_change_id uuid, p_trigger_run_id text, p_attempt_number integer
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare d public.change_intelligence_decisions%rowtype;
begin
  if p_trigger_run_id is null or char_length(p_trigger_run_id) not between 1 and 255
     or p_attempt_number is null or p_attempt_number not between 1 and 100 then
    raise exception 'Intelligence attempt identity is invalid' using errcode = '22023';
  end if;
  select * into d from public.change_intelligence_decisions
    where source_change_id = p_source_change_id and engine_version = 'jev-shadow-v1'
      and policy_version = 'intelligence-policy-v1' and provider = 'openrouter'
      and model = 'typesafe/jev-1.14'
    order by created_at desc limit 1 for update;
  if not found then raise exception 'Intelligence decision was not queued' using errcode = 'P0002'; end if;
  if d.status = 'completed' then
    return jsonb_build_object('status','completed','sourceChangeId',d.source_change_id,'replayed',true);
  end if;
  if d.attempts_count >= 8 then
    return jsonb_build_object('status','busy','sourceChangeId',d.source_change_id);
  end if;
  if d.status = 'processing' and d.updated_at > now() - interval '20 minutes'
     and (d.trigger_run_id <> p_trigger_run_id or d.attempt_number >= p_attempt_number) then
    return jsonb_build_object('status','busy','sourceChangeId',d.source_change_id);
  end if;
  update public.change_intelligence_decisions set status='processing', trigger_run_id=p_trigger_run_id,
    attempt_number=p_attempt_number, attempts_count=attempts_count+1, error_category=null,
    proposed_route=null, probabilities=null, confidence=null, evidence_quality=null,
    proposed_policy_state=null, latency_ms=null, input_tokens=null, output_tokens=null,
    cost_usd=null, completed_at=null where id=d.id;
  return jsonb_build_object(
    'status','processing','sourceChangeId',d.source_change_id,'evidenceFingerprint',d.evidence_fingerprint,
    'engineVersion',d.engine_version,'policyVersion',d.policy_version,'provider',d.provider,'model',d.model,
    'change',(select jsonb_build_object(
      'sourceName',src.name,'sourceType',src.source_type,'dependencyName',dep.name,
      'beforeVersion',old_snapshot.version,'afterVersion',new_snapshot.version,
      'diffText',ch.diff_text,'addedLines',ch.added_lines,'removedLines',ch.removed_lines,
      'diffTruncated',ch.diff_truncated,'beforeBytes',ch.previous_bytes,'afterBytes',ch.new_bytes
    ) from public.source_changes ch
      join public.source_catalog src on src.id=ch.source_id
      join public.dependency_catalog dep on dep.id=src.dependency_id
      join public.source_snapshots old_snapshot on old_snapshot.id=ch.previous_snapshot_id
      join public.source_snapshots new_snapshot on new_snapshot.id=ch.new_snapshot_id
      where ch.id=d.source_change_id)
  );
end;
$$;

create function public.record_source_change_intelligence(
  p_source_change_id uuid, p_evidence_fingerprint text, p_trigger_run_id text,
  p_attempt_number integer, p_route text, p_probabilities jsonb, p_confidence numeric,
  p_evidence_quality jsonb, p_proposed_policy_state text, p_latency_ms integer,
  p_input_tokens integer default null, p_output_tokens integer default null,
  p_cost_usd numeric default null
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare d public.change_intelligence_decisions%rowtype;
begin
  if p_evidence_fingerprint is null or p_evidence_fingerprint !~ '^[a-f0-9]{32}$'
    or p_route not in ('docs_noise','deprecation','breaking_api_change','auth_or_security_change',
      'schema_or_contract_change','pricing_change','limits_or_quota_change','sdk_change',
      'webhook_or_event_change','feature_change','availability_or_runtime_change','terms_or_policy_change','uncertain')
    or p_probabilities is null or jsonb_typeof(p_probabilities)<>'object' or octet_length(p_probabilities::text)>4096
    or p_confidence is null or p_confidence<0 or p_confidence>1
    or p_evidence_quality is null or jsonb_typeof(p_evidence_quality)<>'object' or octet_length(p_evidence_quality::text)>2048
    or p_proposed_policy_state not in ('suppress_candidate','continue_candidate','escalate','insufficient_evidence')
    or p_latency_ms is null or p_latency_ms<0 or p_latency_ms>120000
    or (p_input_tokens is not null and p_input_tokens not between 0 and 1000000)
    or (p_output_tokens is not null and p_output_tokens not between 0 and 1000000)
    or (p_cost_usd is not null and p_cost_usd not between 0 and 100) then
    raise exception 'Intelligence decision failed persistence validation' using errcode = '22023';
  end if;
  update public.change_intelligence_decisions set status='completed', proposed_route=p_route,
    probabilities=p_probabilities, confidence=p_confidence, evidence_quality=p_evidence_quality,
    proposed_policy_state=p_proposed_policy_state, latency_ms=p_latency_ms,
    input_tokens=p_input_tokens, output_tokens=p_output_tokens, cost_usd=p_cost_usd,
    error_category=null, completed_at=now()
  where source_change_id=p_source_change_id and engine_version='jev-shadow-v1'
    and policy_version='intelligence-policy-v1' and provider='openrouter'
    and model='typesafe/jev-1.14' and evidence_fingerprint=p_evidence_fingerprint
    and status='processing' and trigger_run_id=p_trigger_run_id and attempt_number=p_attempt_number
  returning * into d;
  if not found then
    select * into d from public.change_intelligence_decisions where source_change_id=p_source_change_id
      and engine_version='jev-shadow-v1' and policy_version='intelligence-policy-v1'
      and provider='openrouter' and model='typesafe/jev-1.14' and evidence_fingerprint=p_evidence_fingerprint;
    if d.status='completed' then return jsonb_build_object('status','completed','replayed',true); end if;
    raise exception 'Intelligence attempt is no longer current' using errcode = '40001';
  end if;
  return jsonb_build_object('status','completed','replayed',false);
end;
$$;

create function public.record_source_change_intelligence_failure(
  p_source_change_id uuid, p_evidence_fingerprint text, p_trigger_run_id text,
  p_attempt_number integer, p_error_category text
)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_error_category is null or p_error_category !~ '^[a-z0-9_]{1,80}$' then
    raise exception 'Intelligence error category is invalid' using errcode = '22023';
  end if;
  update public.change_intelligence_decisions set status='failed', error_category=p_error_category,
    proposed_route=null, probabilities=null, confidence=null, evidence_quality=null,
    proposed_policy_state=null, completed_at=null
  where source_change_id=p_source_change_id and engine_version='jev-shadow-v1'
    and policy_version='intelligence-policy-v1' and provider='openrouter'
    and model='typesafe/jev-1.14' and evidence_fingerprint=p_evidence_fingerprint
    and status='processing' and trigger_run_id=p_trigger_run_id and attempt_number=p_attempt_number;
  if not found then raise exception 'Intelligence attempt is no longer current' using errcode = '40001'; end if;
end;
$$;

create function public.list_queued_source_change_intelligence_ids(p_limit integer default 100)
returns table (source_change_id uuid) language sql security invoker set search_path = '' as $$
  select d.source_change_id from public.change_intelligence_decisions d
  where ((d.status in ('queued','failed')) or
    (d.status='processing' and d.updated_at < now() - interval '20 minutes'))
    and d.attempts_count < 8
  order by d.created_at,d.source_change_id limit least(greatest(coalesce(p_limit,1),1),100);
$$;

alter table public.change_intelligence_decisions enable row level security;
revoke all on public.change_intelligence_decisions from public, anon, authenticated;
grant select,insert,update,delete on public.change_intelligence_decisions to service_role;
revoke all on function public.begin_source_change_intelligence(uuid,text,integer) from public,anon,authenticated;
revoke all on function public.record_source_change_intelligence(uuid,text,text,integer,text,jsonb,numeric,jsonb,text,integer,integer,integer,numeric) from public,anon,authenticated;
revoke all on function public.record_source_change_intelligence_failure(uuid,text,text,integer,text) from public,anon,authenticated;
revoke all on function public.list_queued_source_change_intelligence_ids(integer) from public,anon,authenticated;
grant execute on function public.begin_source_change_intelligence(uuid,text,integer) to service_role;
grant execute on function public.record_source_change_intelligence(uuid,text,text,integer,text,jsonb,numeric,jsonb,text,integer,integer,integer,numeric) to service_role;
grant execute on function public.record_source_change_intelligence_failure(uuid,text,text,integer,text) to service_role;
grant execute on function public.list_queued_source_change_intelligence_ids(integer) to service_role;
