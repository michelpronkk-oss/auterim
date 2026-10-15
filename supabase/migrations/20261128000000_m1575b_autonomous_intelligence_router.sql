-- M15.75B: durable provider-neutral routing and bounded evidence escalation.
alter table public.change_intelligence_decisions
  add column response_model text check (
    response_model is null or char_length(response_model) between 1 and 160
  ),
  add column policy_reason text check (
    policy_reason is null or policy_reason ~ '^[a-z0-9_]{1,80}$'
  );

create function public.record_source_change_intelligence_v2(
  p_source_change_id uuid, p_evidence_fingerprint text, p_trigger_run_id text,
  p_attempt_number integer, p_route text, p_probabilities jsonb, p_confidence numeric,
  p_evidence_quality jsonb, p_proposed_policy_state text, p_policy_reason text, p_response_model text,
  p_latency_ms integer, p_input_tokens integer, p_output_tokens integer, p_cost_usd numeric
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare d public.change_intelligence_decisions%rowtype;
begin
  if (p_response_model is not null and char_length(p_response_model) not between 1 and 160)
    or p_policy_reason is null or p_policy_reason !~ '^[a-z0-9_]{1,80}$' then
    raise exception 'Intelligence response model failed persistence validation' using errcode = '22023';
  end if;
  update public.change_intelligence_decisions set status='completed', proposed_route=p_route,
    probabilities=p_probabilities, confidence=p_confidence, evidence_quality=p_evidence_quality,
    proposed_policy_state=p_proposed_policy_state, response_model=p_response_model,policy_reason=p_policy_reason,
    latency_ms=p_latency_ms, input_tokens=p_input_tokens, output_tokens=p_output_tokens,
    cost_usd=p_cost_usd, error_category=null, completed_at=now()
  where source_change_id=p_source_change_id and engine_version='jev-shadow-v1'
    and policy_version='intelligence-policy-v1' and provider='openrouter'
    and model='typesafe/jev-1.14' and evidence_fingerprint=p_evidence_fingerprint
    and status='processing' and trigger_run_id=p_trigger_run_id and attempt_number=p_attempt_number
  returning * into d;
  if not found then
    select * into d from public.change_intelligence_decisions
    where source_change_id=p_source_change_id and engine_version='jev-shadow-v1'
      and policy_version='intelligence-policy-v1' and provider='openrouter'
      and model='typesafe/jev-1.14' and evidence_fingerprint=p_evidence_fingerprint;
    if d.status='completed' then
      return jsonb_build_object('status','completed','replayed',true);
    end if;
    raise exception 'Intelligence attempt is no longer current' using errcode = '40001';
  end if;
  return jsonb_build_object('status','completed','replayed',false);
end;
$$;

create table public.intelligence_route_intents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  source_change_id uuid not null references public.source_changes(id) on delete restrict,
  intelligence_decision_id uuid not null references public.change_intelligence_decisions(id) on delete restrict,
  policy_version text not null check (char_length(policy_version) between 1 and 80),
  engine_version text not null check (char_length(engine_version) between 1 and 80),
  router_version text not null check (char_length(router_version) between 1 and 80),
  provider text not null check (char_length(provider) between 1 and 80),
  requested_model text not null check (char_length(requested_model) between 1 and 160),
  response_model text check (response_model is null or char_length(response_model) between 1 and 160),
  route text not null check (route in (
    'docs_noise','deprecation','breaking_api_change','auth_or_security_change',
    'schema_or_contract_change','pricing_change','limits_or_quota_change','sdk_change',
    'webhook_or_event_change','feature_change','availability_or_runtime_change',
    'terms_or_policy_change','uncertain'
  )),
  policy_state text not null check (policy_state in (
    'suppress_candidate','continue_candidate','escalate','insufficient_evidence'
  )),
  route_target text not null check (route_target in (
    'suppress_archive','dependency_product_impact','dependency_impact_repository_exposure_candidate',
    'integration_auth_risk_analysis','contract_exposure_analysis','commercial_impact_analysis',
    'capacity_risk_analysis','repository_dependency_exposure_analysis',
    'contract_repository_exposure_analysis','product_relevance_analysis',
    'runtime_risk_analysis_candidate','provider_policy_review','evidence_escalation'
  )),
  route_status text not null check (route_status in (
    'suppressed','pending','queued','dispatching','dispatched','completed','failed'
  )),
  reason text not null check (reason ~ '^[a-z0-9_]{1,80}$'),
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[a-f0-9]{32}$'),
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 160),
  dispatch_attempt_count integer not null default 0 check (dispatch_attempt_count between 0 and 8),
  claim_token uuid,
  lease_expires_at timestamptz,
  trigger_run_id text check (trigger_run_id is null or char_length(trigger_run_id) between 1 and 255),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  dispatched_at timestamptz,
  completed_at timestamptz,
  failure_category text check (failure_category is null or failure_category ~ '^[a-z0-9_]{1,80}$'),
  constraint intelligence_route_identity_key unique
    (source_change_id,intelligence_decision_id,policy_version,router_version),
  constraint intelligence_route_policy_safety_check check (
    route <> 'uncertain' or policy_state in ('escalate','insufficient_evidence')
  ),
  constraint intelligence_route_suppression_safety_check check (
    policy_state <> 'suppress_candidate' or route = 'docs_noise'
  ),
  constraint intelligence_route_terminal_time_check check (
    (route_status in ('suppressed','completed','failed') and completed_at is not null)
    or (route_status not in ('suppressed','completed','failed') and completed_at is null)
  ),
  constraint intelligence_route_lease_pair_check check (
    (claim_token is null and lease_expires_at is null)
    or (claim_token is not null and lease_expires_at is not null)
  )
);

create index intelligence_route_intents_recovery_idx
  on public.intelligence_route_intents(route_status,lease_expires_at,created_at)
  where route_status in ('queued','dispatching');
create index intelligence_route_intents_source_idx
  on public.intelligence_route_intents(source_change_id,created_at desc);
create trigger intelligence_route_intents_set_updated_at
  before update on public.intelligence_route_intents
  for each row execute function private.set_updated_at();

create table public.intelligence_evidence_escalations (
  id uuid primary key default gen_random_uuid(),
  route_intent_id uuid not null unique references public.intelligence_route_intents(id) on delete restrict,
  attempt_count integer not null default 0 check (attempt_count between 0 and 3),
  max_attempts integer not null default 3 check (max_attempts = 3),
  last_reason text not null check (last_reason ~ '^[a-z0-9_]{1,80}$'),
  next_allowed_at timestamptz not null default now(),
  terminal_state text not null default 'queued' check (terminal_state in (
    'queued','running','completed','insufficient_evidence','exhausted'
  )),
  claim_token uuid,
  lease_expires_at timestamptz,
  last_trigger_run_id text check (last_trigger_run_id is null or char_length(last_trigger_run_id) between 1 and 255),
  evidence_summary jsonb check (evidence_summary is null or (
    jsonb_typeof(evidence_summary)='object' and octet_length(evidence_summary::text)<=2048
  )),
  evidence_fingerprint text check (evidence_fingerprint is null or evidence_fingerprint ~ '^[a-f0-9]{32}$'),
  failure_category text check (failure_category is null or failure_category ~ '^[a-z0-9_]{1,80}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint intelligence_escalation_state_time_check check (
    (terminal_state in ('completed','insufficient_evidence','exhausted') and completed_at is not null)
    or (terminal_state in ('queued','running') and completed_at is null)
  ),
  constraint intelligence_escalation_lease_pair_check check (
    (claim_token is null and lease_expires_at is null)
    or (claim_token is not null and lease_expires_at is not null)
  )
);
create index intelligence_evidence_escalations_recovery_idx
  on public.intelligence_evidence_escalations(terminal_state,next_allowed_at,lease_expires_at)
  where terminal_state in ('queued','running');
create trigger intelligence_evidence_escalations_set_updated_at
  before update on public.intelligence_evidence_escalations
  for each row execute function private.set_updated_at();

create function public.resolve_intelligence_route_target(p_route text,p_policy_state text)
returns text language plpgsql immutable security invoker set search_path = '' as $$
begin
  if p_policy_state in ('escalate','insufficient_evidence') then return 'evidence_escalation'; end if;
  if p_policy_state is null or p_policy_state not in ('suppress_candidate','continue_candidate') then
    raise exception 'Intelligence policy state is invalid' using errcode = '22023';
  end if;
  return case p_route
    when 'docs_noise' then 'suppress_archive'
    when 'deprecation' then 'dependency_product_impact'
    when 'breaking_api_change' then 'dependency_impact_repository_exposure_candidate'
    when 'auth_or_security_change' then 'integration_auth_risk_analysis'
    when 'schema_or_contract_change' then 'contract_exposure_analysis'
    when 'pricing_change' then 'commercial_impact_analysis'
    when 'limits_or_quota_change' then 'capacity_risk_analysis'
    when 'sdk_change' then 'repository_dependency_exposure_analysis'
    when 'webhook_or_event_change' then 'contract_repository_exposure_analysis'
    when 'feature_change' then 'product_relevance_analysis'
    when 'availability_or_runtime_change' then 'runtime_risk_analysis_candidate'
    when 'terms_or_policy_change' then 'provider_policy_review'
    when 'uncertain' then 'evidence_escalation'
    else null end;
end;
$$;

create function public.persist_intelligence_route_intent(
  p_source_change_id uuid, p_router_version text default 'intelligence-router-v1'
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  d public.change_intelligence_decisions%rowtype;
  r public.intelligence_route_intents%rowtype;
  target text;
  initial_status text;
  idem text;
  inserted_count integer;
begin
  if p_router_version is null or char_length(p_router_version) not between 1 and 80 then
    raise exception 'Router version is invalid' using errcode = '22023';
  end if;
  select * into d from public.change_intelligence_decisions
    where source_change_id=p_source_change_id and status='completed'
    order by created_at desc limit 1;
  if not found then raise exception 'Completed intelligence decision not found' using errcode = 'P0002'; end if;
  if d.proposed_route='uncertain' and d.proposed_policy_state='suppress_candidate' then
    raise exception 'Uncertain decisions cannot be suppressed' using errcode = '22023';
  end if;
  if d.proposed_policy_state='suppress_candidate' and (
    d.proposed_route<>'docs_noise'
    or coalesce(d.evidence_quality->>'sourceCriticality','standard')='critical'
    or coalesce((d.evidence_quality->>'incomplete')::boolean,true)
  ) then raise exception 'Unsafe intelligence suppression rejected' using errcode = '22023'; end if;
  target := public.resolve_intelligence_route_target(d.proposed_route,d.proposed_policy_state);
  if target is null then raise exception 'Intelligence route is invalid' using errcode = '22023'; end if;
  initial_status := case
    when d.proposed_policy_state='suppress_candidate' then 'suppressed'
    when d.proposed_policy_state='continue_candidate' then 'pending'
    else 'queued' end;
  idem := 'intelligence-router-v1:' || md5(d.source_change_id::text || ':' || d.id::text || ':' || d.policy_version || ':' || p_router_version);
  insert into public.intelligence_route_intents (
    source_change_id,intelligence_decision_id,policy_version,engine_version,router_version,
    provider,requested_model,response_model,route,policy_state,route_target,route_status,reason,
    evidence_fingerprint,idempotency_key,completed_at
  ) values (
    d.source_change_id,d.id,d.policy_version,d.engine_version,p_router_version,
    d.provider,d.model,d.response_model,d.proposed_route,d.proposed_policy_state,target,initial_status,
    coalesce(d.policy_reason,'policy_decision'),d.evidence_fingerprint,idem,
    case when initial_status='suppressed' then now() else null end
  ) on conflict (source_change_id,intelligence_decision_id,policy_version,router_version) do nothing;
  get diagnostics inserted_count = row_count;
  select * into r from public.intelligence_route_intents
    where source_change_id=d.source_change_id and intelligence_decision_id=d.id
      and policy_version=d.policy_version and router_version=p_router_version;
  if r.route_target='evidence_escalation' and r.route_status in ('queued','dispatching','dispatched') then
    insert into public.intelligence_evidence_escalations(route_intent_id,last_reason)
      values (r.id, coalesce(r.reason,'evidence_escalation')) on conflict (route_intent_id) do nothing;
  end if;
  return jsonb_build_object(
    'id',r.id,'sourceChangeId',r.source_change_id,'decisionId',r.intelligence_decision_id,
    'route',r.route,'policyState',r.policy_state,'routeTarget',r.route_target,
    'routeStatus',r.route_status,'idempotencyKey',r.idempotency_key,'replayed',inserted_count=0
  );
end;
$$;

create function public.claim_intelligence_route_dispatch(p_route_intent_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare r public.intelligence_route_intents%rowtype; token uuid;
begin
  select * into r from public.intelligence_route_intents where id=p_route_intent_id for update;
  if not found then raise exception 'Route intent not found' using errcode = 'P0002'; end if;
  if r.route_target<>'evidence_escalation' then
    return jsonb_build_object('status',r.route_status,'dispatched',false,'id',r.id);
  end if;
  if r.route_status='completed' then return jsonb_build_object('status','completed','dispatched',false,'id',r.id); end if;
  if r.route_status not in ('queued','dispatching') or
     (r.route_status='dispatching' and r.lease_expires_at>now()) then
    return jsonb_build_object('status',r.route_status,'dispatched',false,'id',r.id);
  end if;
  if r.dispatch_attempt_count>=8 then
    update public.intelligence_route_intents set route_status='failed',failure_category='dispatch_attempts_exhausted',
      completed_at=now(),claim_token=null,lease_expires_at=null where id=r.id;
    return jsonb_build_object('status','failed','dispatched',false,'id',r.id);
  end if;
  token:=gen_random_uuid();
  update public.intelligence_route_intents set route_status='dispatching',dispatch_attempt_count=dispatch_attempt_count+1,
    claim_token=token,lease_expires_at=now()+interval '10 seconds' where id=r.id;
  return jsonb_build_object('status','claimed','id',r.id,'claimToken',token,
    'idempotencyKey',r.idempotency_key || ':evidence-escalation');
end;
$$;

create function public.mark_intelligence_route_dispatched(
  p_route_intent_id uuid,p_claim_token uuid,p_trigger_run_id text
)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_trigger_run_id is null or char_length(p_trigger_run_id) not between 1 and 255 then
    raise exception 'Trigger run identity is invalid' using errcode = '22023';
  end if;
  update public.intelligence_route_intents set route_status='dispatched',trigger_run_id=p_trigger_run_id,
    dispatched_at=coalesce(dispatched_at,now()),claim_token=null,lease_expires_at=null,failure_category=null
  where id=p_route_intent_id and route_status='dispatching' and claim_token=p_claim_token;
  if found then return true; end if;
  return exists(select 1 from public.intelligence_route_intents where id=p_route_intent_id and route_status in ('dispatched','completed'));
end;
$$;

create function public.release_intelligence_route_dispatch(
  p_route_intent_id uuid,p_claim_token uuid,p_failure_category text
)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_failure_category is null or p_failure_category !~ '^[a-z0-9_]{1,80}$' then
    raise exception 'Failure category is invalid' using errcode = '22023';
  end if;
  update public.intelligence_route_intents set route_status='queued',failure_category=p_failure_category,
    claim_token=null,lease_expires_at=null
  where id=p_route_intent_id and route_status='dispatching' and claim_token=p_claim_token;
  return found;
end;
$$;

create function public.claim_intelligence_evidence_escalation(
  p_route_intent_id uuid,p_trigger_run_id text
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare e public.intelligence_evidence_escalations%rowtype; token uuid; result jsonb;
begin
  select * into e from public.intelligence_evidence_escalations
    where route_intent_id=p_route_intent_id for update;
  if not found then raise exception 'Evidence escalation not found' using errcode = 'P0002'; end if;
  if e.terminal_state in ('completed','insufficient_evidence','exhausted') then
    return jsonb_build_object('status',e.terminal_state,'replayed',true);
  end if;
  if e.next_allowed_at>now() or (e.terminal_state='running' and e.lease_expires_at>now()) then
    return jsonb_build_object('status','busy','replayed',false);
  end if;
  if e.attempt_count>=e.max_attempts then
    update public.intelligence_evidence_escalations set terminal_state='exhausted',completed_at=now(),
      claim_token=null,lease_expires_at=null,failure_category='attempts_exhausted'
      where id=e.id;
    update public.intelligence_route_intents set route_status='failed',completed_at=now(),failure_category='escalation_attempts_exhausted'
      where id=p_route_intent_id and route_status<>'completed';
    return jsonb_build_object('status','exhausted','replayed',false);
  end if;
  token:=gen_random_uuid();
  update public.intelligence_evidence_escalations set terminal_state='running',attempt_count=attempt_count+1,
    claim_token=token,lease_expires_at=now()+interval '60 seconds',last_trigger_run_id=p_trigger_run_id
    where id=e.id returning * into e;
  select jsonb_build_object(
    'status','claimed','id',e.id,'routeIntentId',r.id,'sourceChangeId',ch.id,
    'claimToken',token,'attemptCount',e.attempt_count,'sourceType',src.source_type,
    'sourceName',src.name,'dependencyName',dep.name,
    'beforeVersion',old_snapshot.version,'afterVersion',new_snapshot.version,
    'diffText',left(ch.diff_text,16384),
    'previousEvidence',case when octet_length(old_snapshot.normalized_content)<=8192 then old_snapshot.normalized_content
      else left(old_snapshot.normalized_content,4096)||E'\n[bounded middle omitted]\n'||right(old_snapshot.normalized_content,4096) end,
    'currentEvidence',case when octet_length(new_snapshot.normalized_content)<=8192 then new_snapshot.normalized_content
      else left(new_snapshot.normalized_content,4096)||E'\n[bounded middle omitted]\n'||right(new_snapshot.normalized_content,4096) end,
    'previousBytes',ch.previous_bytes,'currentBytes',ch.new_bytes,'priorDiffTruncated',ch.diff_truncated
  ) into result
  from public.intelligence_route_intents r
  join public.source_changes ch on ch.id=r.source_change_id
  join public.source_catalog src on src.id=ch.source_id
  join public.dependency_catalog dep on dep.id=src.dependency_id
  join public.source_snapshots old_snapshot on old_snapshot.id=ch.previous_snapshot_id
  join public.source_snapshots new_snapshot on new_snapshot.id=ch.new_snapshot_id
  where r.id=p_route_intent_id and r.route_target='evidence_escalation';
  if result is null then raise exception 'Bounded escalation evidence unavailable' using errcode = 'P0002'; end if;
  return result;
end;
$$;

create function public.complete_intelligence_evidence_escalation(
  p_route_intent_id uuid,p_claim_token uuid,p_terminal_state text,
  p_last_reason text,p_evidence_summary jsonb,p_evidence_fingerprint text
)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare e public.intelligence_evidence_escalations%rowtype;
begin
  if p_terminal_state not in ('completed','insufficient_evidence')
    or p_last_reason is null or p_last_reason !~ '^[a-z0-9_]{1,80}$'
    or p_evidence_summary is null or jsonb_typeof(p_evidence_summary)<>'object'
    or octet_length(p_evidence_summary::text)>2048
    or p_evidence_fingerprint is null or p_evidence_fingerprint !~ '^[a-f0-9]{32}$' then
    raise exception 'Evidence escalation result failed validation' using errcode = '22023';
  end if;
  update public.intelligence_evidence_escalations set terminal_state=p_terminal_state,last_reason=p_last_reason,
    evidence_summary=p_evidence_summary,evidence_fingerprint=p_evidence_fingerprint,
    completed_at=now(),claim_token=null,lease_expires_at=null,failure_category=null
  where route_intent_id=p_route_intent_id and terminal_state='running' and claim_token=p_claim_token
  returning * into e;
  if found then
    update public.intelligence_route_intents set route_status='completed',completed_at=now(),
      claim_token=null,lease_expires_at=null,failure_category=null
      where id=p_route_intent_id and route_status in ('dispatching','dispatched','queued');
    return true;
  end if;
  return exists(select 1 from public.intelligence_evidence_escalations
    where route_intent_id=p_route_intent_id and terminal_state=p_terminal_state
      and evidence_fingerprint=p_evidence_fingerprint);
end;
$$;

create function public.release_intelligence_evidence_escalation(
  p_route_intent_id uuid,p_claim_token uuid,p_failure_category text
)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_failure_category is null or p_failure_category !~ '^[a-z0-9_]{1,80}$' then
    raise exception 'Failure category is invalid' using errcode = '22023';
  end if;
  update public.intelligence_evidence_escalations set terminal_state='queued',failure_category=p_failure_category,
    next_allowed_at=now()+interval '30 seconds',claim_token=null,lease_expires_at=null
  where route_intent_id=p_route_intent_id and terminal_state='running' and claim_token=p_claim_token
    and attempt_count<max_attempts;
  if found then return true; end if;
  update public.intelligence_evidence_escalations set terminal_state='exhausted',completed_at=now(),
    failure_category=p_failure_category,claim_token=null,lease_expires_at=null
  where route_intent_id=p_route_intent_id and terminal_state='running' and claim_token=p_claim_token
    and attempt_count>=max_attempts;
  if found then
    update public.intelligence_route_intents set route_status='failed',completed_at=now(),failure_category='escalation_attempts_exhausted'
      where id=p_route_intent_id;
    return true;
  end if;
  return false;
end;
$$;

alter table public.intelligence_route_intents enable row level security;
alter table public.intelligence_evidence_escalations enable row level security;
revoke all on public.intelligence_route_intents,public.intelligence_evidence_escalations from public,anon,authenticated;
grant select,insert,update,delete on public.intelligence_route_intents,public.intelligence_evidence_escalations to service_role;
revoke all on function public.record_source_change_intelligence_v2(uuid,text,text,integer,text,jsonb,numeric,jsonb,text,text,text,integer,integer,integer,numeric) from public,anon,authenticated;
revoke all on function public.persist_intelligence_route_intent(uuid,text) from public,anon,authenticated;
revoke all on function public.resolve_intelligence_route_target(text,text) from public,anon,authenticated;
revoke all on function public.claim_intelligence_route_dispatch(uuid) from public,anon,authenticated;
revoke all on function public.mark_intelligence_route_dispatched(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.release_intelligence_route_dispatch(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.claim_intelligence_evidence_escalation(uuid,text) from public,anon,authenticated;
revoke all on function public.complete_intelligence_evidence_escalation(uuid,uuid,text,text,jsonb,text) from public,anon,authenticated;
revoke all on function public.release_intelligence_evidence_escalation(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.record_source_change_intelligence_v2(uuid,text,text,integer,text,jsonb,numeric,jsonb,text,text,text,integer,integer,integer,numeric) to service_role;
grant execute on function public.persist_intelligence_route_intent(uuid,text) to service_role;
grant execute on function public.resolve_intelligence_route_target(text,text) to service_role;
grant execute on function public.claim_intelligence_route_dispatch(uuid) to service_role;
grant execute on function public.mark_intelligence_route_dispatched(uuid,uuid,text) to service_role;
grant execute on function public.release_intelligence_route_dispatch(uuid,uuid,text) to service_role;
grant execute on function public.claim_intelligence_evidence_escalation(uuid,text) to service_role;
grant execute on function public.complete_intelligence_evidence_escalation(uuid,uuid,text,text,jsonb,text) to service_role;
grant execute on function public.release_intelligence_evidence_escalation(uuid,uuid,text) to service_role;
