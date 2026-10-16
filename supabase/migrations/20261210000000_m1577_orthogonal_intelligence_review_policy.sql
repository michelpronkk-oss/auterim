-- M15.77: keep evidence-analysis eligibility separate from review/risk.
-- The Jev escalation probability remains a calibrated review signal. It no
-- longer turns an otherwise clear route into evidence_escalation.

alter table public.change_intelligence_decisions
  add column review_disposition text not null default 'none'
    check (review_disposition in ('none','review_required')),
  add column review_reason text check (review_reason is null or review_reason in (
    'critical_change','elevated_risk','classifier_review','evidence_incomplete',
    'evidence_insufficient','analysis_uncertain','classifier_model_conflict',
    'high_risk_docs_noise_conflict','policy_review'
  )),
  add constraint change_intelligence_review_pair check (
    (review_disposition='none' and review_reason is null)
    or (review_disposition='review_required' and review_reason is not null)
  );

-- Active policy v2 must never persist a risk/uncertainty signal as "none".
-- V3 remains available to older policy-v1 workers during a staged rollout.
alter table public.change_intelligence_decisions
  add constraint change_intelligence_v2_review_safety check (
    active_policy_version not in ('intelligence-policy-active-v2','intelligence-policy-semantics-v2')
    or review_disposition='review_required'
    or (
      proposed_policy_state in ('continue_candidate','suppress_candidate')
      and coalesce(evidence_quality->>'sourceCriticality','standard') <> 'critical'
      and coalesce((probabilities->>'criticalChange')::numeric,1)
        < coalesce((policy_thresholds->>'criticalChange')::numeric,1)
      and coalesce((probabilities->>'requiresEscalation')::numeric,1)
        < coalesce((policy_thresholds->>'requiresEscalation')::numeric,1)
    )
  );

alter table public.intelligence_route_intents
  add column review_disposition text not null default 'none'
    check (review_disposition in ('none','review_required')),
  add column review_reason text check (review_reason is null or review_reason in (
    'critical_change','elevated_risk','classifier_review','evidence_incomplete',
    'evidence_insufficient','analysis_uncertain','classifier_model_conflict',
    'high_risk_docs_noise_conflict','policy_review'
  )),
  add constraint intelligence_route_review_pair check (
    (review_disposition='none' and review_reason is null)
    or (review_disposition='review_required' and review_reason is not null)
  );

alter table public.code_analysis_route_handoffs
  add column review_disposition text not null default 'none'
    check (review_disposition in ('none','review_required')),
  add column review_reason text;
alter table public.impact_graph_builds
  add column review_disposition text not null default 'none'
    check (review_disposition in ('none','review_required')),
  add column review_reason text;

update public.code_analysis_route_handoffs handoff
set review_disposition=intent.review_disposition, review_reason=intent.review_reason
from public.intelligence_route_intents intent
where intent.id=handoff.route_intent_id;
update public.impact_graph_builds build
set review_disposition=intent.review_disposition, review_reason=intent.review_reason
from public.intelligence_route_intents intent
where intent.id=build.route_intent_id;

alter table public.code_analysis_route_handoffs
  add constraint code_handoffs_review_pair check (
    (review_disposition='none' and review_reason is null)
    or (review_disposition='review_required' and review_reason is not null)
  );
alter table public.impact_graph_builds
  add constraint impact_graph_builds_review_pair check (
    (review_disposition='none' and review_reason is null)
    or (review_disposition='review_required' and review_reason is not null)
  );

create function private.guard_intelligence_route_review_provenance()
returns trigger language plpgsql security definer set search_path = '' as $$
declare d public.change_intelligence_decisions%rowtype;
begin
  select * into d from public.change_intelligence_decisions where id=new.intelligence_decision_id;
  if not found or d.source_change_id is distinct from new.source_change_id then
    raise exception 'Route decision provenance is unavailable' using errcode='23503';
  end if;
  if new.review_disposition is distinct from d.review_disposition
    or new.review_reason is distinct from d.review_reason then
    raise exception 'Route review provenance differs from its decision' using errcode='23514';
  end if;
  if tg_op='UPDATE' and (new.review_disposition is distinct from old.review_disposition
    or new.review_reason is distinct from old.review_reason) then
    raise exception 'Route review provenance is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger intelligence_route_review_provenance_guard
  before insert or update of source_change_id,intelligence_decision_id,review_disposition,review_reason
  on public.intelligence_route_intents
  for each row execute function private.guard_intelligence_route_review_provenance();
revoke all on function private.guard_intelligence_route_review_provenance() from public,anon,authenticated;

create function private.copy_route_review_provenance()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r public.intelligence_route_intents%rowtype;
begin
  select * into r from public.intelligence_route_intents where id=new.route_intent_id;
  if not found then raise exception 'Route review provenance is unavailable' using errcode='23503'; end if;
  if tg_op='UPDATE' and new.route_intent_id=old.route_intent_id
    and (new.review_disposition is distinct from old.review_disposition
      or new.review_reason is distinct from old.review_reason) then
    raise exception 'Downstream review provenance is immutable' using errcode='23514';
  end if;
  new.review_disposition:=r.review_disposition;
  new.review_reason:=r.review_reason;
  return new;
end;
$$;
create trigger code_handoffs_copy_review_provenance
  before insert or update of route_intent_id,review_disposition,review_reason on public.code_analysis_route_handoffs
  for each row execute function private.copy_route_review_provenance();
create trigger impact_graph_builds_copy_review_provenance
  before insert or update of route_intent_id,review_disposition,review_reason on public.impact_graph_builds
  for each row execute function private.copy_route_review_provenance();
revoke all on function private.copy_route_review_provenance() from public,anon,authenticated;

create function public.record_source_change_intelligence_v4(
  p_source_change_id uuid, p_evidence_fingerprint text, p_trigger_run_id text,
  p_attempt_number integer, p_route text, p_probabilities jsonb, p_confidence numeric,
  p_evidence_quality jsonb, p_proposed_policy_state text, p_policy_reason text,
  p_review_disposition text, p_review_reason text, p_response_model text,
  p_policy_mode text, p_active_policy_version text, p_threshold_version text,
  p_calibration_corpus_version text, p_calibration_version text,
  p_calibration_fixture_count integer, p_threshold_fingerprint text,
  p_policy_thresholds jsonb, p_readiness_metadata jsonb, p_holdout_metrics jsonb,
  p_latency_ms integer, p_input_tokens integer, p_output_tokens integer, p_cost_usd numeric
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare d public.change_intelligence_decisions%rowtype;
begin
  if p_policy_mode is null or p_policy_mode not in ('active_calibrated','shadow','fail_closed')
    or p_active_policy_version is null or p_active_policy_version not in (
      'intelligence-policy-active-v2','intelligence-policy-semantics-v2'
    )
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
    or p_review_disposition not in ('none','review_required')
    or (p_review_disposition='none' and p_review_reason is not null)
    or (p_review_disposition='review_required' and p_review_reason not in (
      'critical_change','elevated_risk','classifier_review','evidence_incomplete',
      'evidence_insufficient','analysis_uncertain','classifier_model_conflict',
      'high_risk_docs_noise_conflict','policy_review'
    ))
    or (p_response_model is not null and char_length(p_response_model) not between 1 and 160) then
    raise exception 'Intelligence policy metadata failed persistence validation' using errcode='22023';
  end if;

  update public.change_intelligence_decisions set
    status='completed', proposed_route=p_route, probabilities=p_probabilities,
    confidence=p_confidence, evidence_quality=p_evidence_quality,
    proposed_policy_state=p_proposed_policy_state, response_model=p_response_model,
    policy_reason=p_policy_reason, review_disposition=p_review_disposition,
    review_reason=p_review_reason, policy_mode=p_policy_mode,
    active_policy_version=p_active_policy_version, threshold_version=p_threshold_version,
    calibration_corpus_version=p_calibration_corpus_version,
    calibration_version=p_calibration_version, calibration_fixture_count=p_calibration_fixture_count,
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
    if d.status='completed' then
      if d.review_disposition is distinct from p_review_disposition
        or d.review_reason is distinct from p_review_reason then
        raise exception 'Completed review decision differs from replay' using errcode='40001';
      end if;
      return jsonb_build_object('status','completed','replayed',true);
    end if;
    raise exception 'Intelligence attempt is no longer current' using errcode='40001';
  end if;
  return jsonb_build_object('status','completed','replayed',false);
end;
$$;
revoke all on function public.record_source_change_intelligence_v4(uuid,text,text,integer,text,jsonb,numeric,jsonb,text,text,text,text,text,text,text,text,text,text,integer,text,jsonb,jsonb,jsonb,integer,integer,integer,numeric)
  from public,anon,authenticated;
grant execute on function public.record_source_change_intelligence_v4(uuid,text,text,integer,text,jsonb,numeric,jsonb,text,text,text,text,text,text,text,text,text,text,integer,text,jsonb,jsonb,jsonb,integer,integer,integer,numeric)
  to service_role;

create or replace function public.persist_intelligence_route_intent(
  p_source_change_id uuid, p_router_version text default 'intelligence-router-v1'
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  d public.change_intelligence_decisions%rowtype;
  c public.source_changes%rowtype;
  r public.intelligence_route_intents%rowtype;
  target text;
  initial_status text;
  idem text;
  effective_policy_version text;
  inserted_count integer;
begin
  if p_router_version is null or char_length(p_router_version) not between 1 and 80 then
    raise exception 'Router version is invalid' using errcode='22023';
  end if;
  select * into c from public.source_changes where id=p_source_change_id;
  if not found then raise exception 'Source change not found' using errcode='P0002'; end if;
  if (c.source_mode='internal_test' and (c.processing_mode<>'evidence_only' or c.workspace_id is null or c.scope_product_id is null))
    or (c.source_mode='provider' and (c.processing_mode<>'customer' or c.workspace_id is not null or c.scope_product_id is not null)) then
    raise exception 'Source change provenance is invalid' using errcode='22023';
  end if;
  select * into d from public.change_intelligence_decisions
    where source_change_id=p_source_change_id and status='completed'
    order by created_at desc limit 1;
  if not found then raise exception 'Completed intelligence decision not found' using errcode='P0002'; end if;
  if d.proposed_route='uncertain' and d.proposed_policy_state='suppress_candidate' then
    raise exception 'Uncertain decisions cannot be suppressed' using errcode='22023';
  end if;
  if d.proposed_policy_state='suppress_candidate' and (
    d.proposed_route<>'docs_noise' or coalesce(d.evidence_quality->>'sourceCriticality','standard')='critical'
    or coalesce((d.evidence_quality->>'incomplete')::boolean,true)
    or d.review_disposition<>'none'
  ) then raise exception 'Unsafe intelligence suppression rejected' using errcode='22023'; end if;
  target:=public.resolve_intelligence_route_target(d.proposed_route,d.proposed_policy_state);
  if target is null then raise exception 'Intelligence route is invalid' using errcode='22023'; end if;
  initial_status:=case when d.proposed_policy_state='suppress_candidate' then 'suppressed'
    when d.proposed_policy_state='continue_candidate' then 'pending' else 'queued' end;
  effective_policy_version:=coalesce(d.active_policy_version,d.policy_version);
  idem:='intelligence-router-v1:'||md5(d.source_change_id::text||':'||d.id::text||':'||effective_policy_version||':'||p_router_version);
  insert into public.intelligence_route_intents (
    workspace_id,scope_product_id,source_change_id,intelligence_decision_id,
    policy_version,engine_version,router_version,provider,requested_model,response_model,
    route,policy_state,review_disposition,review_reason,route_target,route_status,reason,
    evidence_fingerprint,idempotency_key,completed_at
  ) values (
    c.workspace_id,c.scope_product_id,d.source_change_id,d.id,effective_policy_version,d.engine_version,
    p_router_version,d.provider,d.model,d.response_model,d.proposed_route,d.proposed_policy_state,
    d.review_disposition,d.review_reason,target,initial_status,coalesce(d.policy_reason,'policy_decision'),
    d.evidence_fingerprint,idem,case when initial_status='suppressed' then now() else null end
  ) on conflict(source_change_id,intelligence_decision_id,policy_version,router_version) do nothing;
  get diagnostics inserted_count=row_count;
  select * into r from public.intelligence_route_intents
    where source_change_id=d.source_change_id and intelligence_decision_id=d.id
      and policy_version=effective_policy_version and router_version=p_router_version;
  if r.workspace_id is distinct from c.workspace_id or r.scope_product_id is distinct from c.scope_product_id then
    raise exception 'Existing route intent scope differs from immutable source provenance' using errcode='23514';
  end if;
  if r.review_disposition is distinct from d.review_disposition or r.review_reason is distinct from d.review_reason then
    raise exception 'Existing route review provenance differs from decision' using errcode='23514';
  end if;
  if r.route_target='evidence_escalation' and r.route_status in ('queued','dispatching','dispatched') then
    insert into public.intelligence_evidence_escalations(route_intent_id,last_reason)
      values(r.id,coalesce(r.reason,'evidence_escalation')) on conflict(route_intent_id) do nothing;
  end if;
  return jsonb_build_object('id',r.id,'sourceChangeId',r.source_change_id,'decisionId',r.intelligence_decision_id,
    'workspaceId',r.workspace_id,'productId',r.scope_product_id,'route',r.route,'policyState',r.policy_state,
    'reviewDisposition',r.review_disposition,'reviewReason',r.review_reason,'policyVersion',r.policy_version,
    'routeTarget',r.route_target,'routeStatus',r.route_status,'idempotencyKey',r.idempotency_key,
    'replayed',inserted_count=0);
end;
$$;
