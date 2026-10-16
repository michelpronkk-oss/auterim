-- M15.77: persist the exact active/shadow policy identity used for each decision.
alter table public.change_intelligence_decisions
  add column policy_mode text check (policy_mode is null or policy_mode in ('active_calibrated','shadow','fail_closed')),
  add column active_policy_version text check (active_policy_version is null or char_length(active_policy_version) between 1 and 80),
  add column threshold_version text check (threshold_version is null or char_length(threshold_version) between 1 and 80),
  add column calibration_corpus_version text check (calibration_corpus_version is null or char_length(calibration_corpus_version) between 1 and 100),
  add column calibration_version text check (calibration_version is null or char_length(calibration_version) between 1 and 100),
  add column calibration_fixture_count integer check (calibration_fixture_count is null or calibration_fixture_count between 0 and 10000),
  add column threshold_fingerprint text check (threshold_fingerprint is null or threshold_fingerprint ~ '^[a-f0-9]{64}$'),
  add column policy_thresholds jsonb check (policy_thresholds is null or (jsonb_typeof(policy_thresholds)='object' and octet_length(policy_thresholds::text)<=4096)),
  add column readiness_metadata jsonb check (readiness_metadata is null or (jsonb_typeof(readiness_metadata)='object' and octet_length(readiness_metadata::text)<=4096)),
  add column holdout_metrics jsonb check (holdout_metrics is null or (jsonb_typeof(holdout_metrics)='object' and octet_length(holdout_metrics::text)<=4096));

-- SDK usage is a first-class semantic classification so Jev and the classifier
-- can agree on the already-supported sdk_change route.
alter table public.source_change_classifications
  drop constraint source_change_classifications_category_check;
alter table public.source_change_classifications
  add constraint source_change_classifications_category_check check (
    category is null or category in ('pricing','api_change','deprecation','sdk_change','limits','terms','feature_change','availability','documentation','security','other')
  );

create or replace function public.record_source_change_classification(
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
    or p_material is null or p_category not in ('pricing','api_change','deprecation','sdk_change','limits','terms','feature_change','availability','documentation','security','other')
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

create function public.record_source_change_intelligence_v3(
  p_source_change_id uuid, p_evidence_fingerprint text, p_trigger_run_id text,
  p_attempt_number integer, p_route text, p_probabilities jsonb, p_confidence numeric,
  p_evidence_quality jsonb, p_proposed_policy_state text, p_policy_reason text,
  p_response_model text, p_policy_mode text, p_active_policy_version text,
  p_threshold_version text, p_calibration_corpus_version text, p_calibration_version text,
  p_calibration_fixture_count integer, p_threshold_fingerprint text,
  p_policy_thresholds jsonb, p_readiness_metadata jsonb, p_holdout_metrics jsonb,
  p_latency_ms integer, p_input_tokens integer, p_output_tokens integer, p_cost_usd numeric
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare d public.change_intelligence_decisions%rowtype;
begin
  if p_policy_mode is null or p_policy_mode not in ('active_calibrated','shadow','fail_closed')
    or p_active_policy_version is null or char_length(p_active_policy_version) not between 1 and 80
    or p_threshold_version is null or char_length(p_threshold_version) not between 1 and 80
    or p_calibration_corpus_version is null or char_length(p_calibration_corpus_version) not between 1 and 100
    or p_calibration_version is null or char_length(p_calibration_version) not between 1 and 100
    or p_calibration_fixture_count not between 0 and 10000
    or p_policy_thresholds is null or jsonb_typeof(p_policy_thresholds)<>'object' or octet_length(p_policy_thresholds::text)>4096
    or p_readiness_metadata is null or jsonb_typeof(p_readiness_metadata)<>'object' or octet_length(p_readiness_metadata::text)>4096
    or (p_holdout_metrics is not null and (jsonb_typeof(p_holdout_metrics)<>'object' or octet_length(p_holdout_metrics::text)>4096))
    or (p_threshold_fingerprint is not null and p_threshold_fingerprint !~ '^[a-f0-9]{64}$')
    or (p_policy_mode='active_calibrated' and p_threshold_fingerprint is null)
    or (p_policy_mode='active_calibrated' and p_calibration_fixture_count<>32)
    or p_policy_reason is null or p_policy_reason !~ '^[a-z0-9_]{1,80}$'
    or (p_response_model is not null and char_length(p_response_model) not between 1 and 160) then
    raise exception 'Intelligence policy metadata failed persistence validation' using errcode='22023';
  end if;

  update public.change_intelligence_decisions set
    status='completed', proposed_route=p_route, probabilities=p_probabilities,
    confidence=p_confidence, evidence_quality=p_evidence_quality,
    proposed_policy_state=p_proposed_policy_state, response_model=p_response_model,
    policy_reason=p_policy_reason, policy_mode=p_policy_mode,
    active_policy_version=p_active_policy_version, threshold_version=p_threshold_version,
    calibration_corpus_version=p_calibration_corpus_version,
    calibration_version=p_calibration_version,
    calibration_fixture_count=p_calibration_fixture_count,
    threshold_fingerprint=p_threshold_fingerprint, policy_thresholds=p_policy_thresholds,
    readiness_metadata=p_readiness_metadata, holdout_metrics=p_holdout_metrics,
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
    if d.status='completed' then return jsonb_build_object('status','completed','replayed',true); end if;
    raise exception 'Intelligence attempt is no longer current' using errcode='40001';
  end if;
  return jsonb_build_object('status','completed','replayed',false);
end;
$$;

revoke all on function public.record_source_change_intelligence_v3(uuid,text,text,integer,text,jsonb,numeric,jsonb,text,text,text,text,text,text,text,text,integer,text,jsonb,jsonb,jsonb,integer,integer,integer,numeric) from public,anon,authenticated;
grant execute on function public.record_source_change_intelligence_v3(uuid,text,text,integer,text,jsonb,numeric,jsonb,text,text,text,text,text,text,text,text,integer,text,jsonb,jsonb,jsonb,integer,integer,integer,numeric) to service_role;

-- Keep already-running pre-deploy Trigger workers safe during rollout while
-- identifying their legacy threshold decisions honestly as shadow decisions.
create or replace function public.record_source_change_intelligence_v2(
  p_source_change_id uuid, p_evidence_fingerprint text, p_trigger_run_id text,
  p_attempt_number integer, p_route text, p_probabilities jsonb, p_confidence numeric,
  p_evidence_quality jsonb, p_proposed_policy_state text, p_policy_reason text,
  p_response_model text, p_latency_ms integer, p_input_tokens integer,
  p_output_tokens integer, p_cost_usd numeric
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  return public.record_source_change_intelligence_v3(
    p_source_change_id,p_evidence_fingerprint,p_trigger_run_id,p_attempt_number,
    p_route,p_probabilities,p_confidence,p_evidence_quality,
    case when p_evidence_quality->>'sourceCriticality'='critical'
        and coalesce((p_evidence_quality->>'incomplete')::boolean,true)
      then 'insufficient_evidence' else 'escalate' end,
    'calibration_not_available',p_response_model,'fail_closed','intelligence-policy-v1',
    'uncalibrated-conservative-v1','none','uncalibrated-conservative-v1',0,null,
    jsonb_build_object('material',1,'criticalChange',1,'evidenceSufficient',1,
      'docsNoise',1,'requiresEscalation',1,'routeConfidence',1,
      'calibrationFixtureCount',0,'calibrationVersion','uncalibrated-conservative-v1'),
    jsonb_build_object('calibrationAvailable',false,'failClosed',true),null,
    p_latency_ms,p_input_tokens,p_output_tokens,p_cost_usd
  );
end;
$$;

-- Carry the actual policy identity into the route intent (and therefore later
-- graph provenance) while keeping the decision's legacy queue identity stable.
create or replace function public.persist_intelligence_route_intent(
  p_source_change_id uuid, p_router_version text default 'intelligence-router-v1'
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  d public.change_intelligence_decisions%rowtype;
  r public.intelligence_route_intents%rowtype;
  target text;
  initial_status text;
  idem text;
  effective_policy_version text;
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
    when d.proposed_policy_state='continue_candidate' then 'pending' else 'queued' end;
  effective_policy_version := coalesce(d.active_policy_version,d.policy_version);
  idem := 'intelligence-router-v1:' || md5(d.source_change_id::text || ':' || d.id::text || ':' || effective_policy_version || ':' || p_router_version);
  insert into public.intelligence_route_intents (
    source_change_id,intelligence_decision_id,policy_version,engine_version,router_version,
    provider,requested_model,response_model,route,policy_state,route_target,route_status,reason,
    evidence_fingerprint,idempotency_key,completed_at
  ) values (
    d.source_change_id,d.id,effective_policy_version,d.engine_version,p_router_version,
    d.provider,d.model,d.response_model,d.proposed_route,d.proposed_policy_state,target,initial_status,
    coalesce(d.policy_reason,'policy_decision'),d.evidence_fingerprint,idem,
    case when initial_status='suppressed' then now() else null end
  ) on conflict (source_change_id,intelligence_decision_id,policy_version,router_version) do nothing;
  get diagnostics inserted_count = row_count;
  select * into r from public.intelligence_route_intents
    where source_change_id=d.source_change_id and intelligence_decision_id=d.id
      and policy_version=effective_policy_version and router_version=p_router_version;
  if r.route_target='evidence_escalation' and r.route_status in ('queued','dispatching','dispatched') then
    insert into public.intelligence_evidence_escalations(route_intent_id,last_reason)
      values (r.id, coalesce(r.reason,'evidence_escalation')) on conflict (route_intent_id) do nothing;
  end if;
  return jsonb_build_object(
    'id',r.id,'sourceChangeId',r.source_change_id,'decisionId',r.intelligence_decision_id,
    'route',r.route,'policyState',r.policy_state,'policyVersion',r.policy_version,
    'routeTarget',r.route_target,'routeStatus',r.route_status,
    'idempotencyKey',r.idempotency_key,'replayed',inserted_count=0
  );
end;
$$;
