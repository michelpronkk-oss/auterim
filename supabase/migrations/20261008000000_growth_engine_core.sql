-- Internal, global Growth Engine state. No tenant-owned source is referenced.
create table public.growth_topics (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.dependency_catalog(id) on delete restrict,
  topic_key text not null check(topic_key ~ '^[a-z0-9][a-z0-9._-]{0,119}$'),
  entity_key text not null check(entity_key ~ '^[a-z0-9][a-z0-9._-]{0,119}$'),
  label text not null check(char_length(btrim(label)) between 1 and 160),
  canonical_slug text not null unique check(canonical_slug ~ '^[a-z0-9]+([a-z0-9-]*[a-z0-9])?$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider_id,topic_key,entity_key)
);
create index growth_topics_provider_created_idx on public.growth_topics(provider_id,created_at desc,id desc);

create table public.growth_opportunities (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null unique references public.growth_topics(id) on delete restrict,
  decision text not null check(decision in ('PUBLIC_PAGE','HUB_UPDATE','DISTRIBUTION_ONLY','NOINDEX','IGNORE')),
  status text not null check(status in ('candidate','approved_by_engine','stale','superseded','rejected','published_later')),
  recommended_surface text not null check(recommended_surface in ('PUBLIC_PAGE','PROVIDER_HUB','DISTRIBUTION','NOINDEX','FREE_TOOL','NONE')),
  free_tool_type text check(free_tool_type is null or free_tool_type in ('STACK_SCANNER','DEPENDENCY_EXPOSURE_CHECK','API_DEPRECATION_CHECKER','MODEL_RETIREMENT_CHECKER')),
  cta_types text[] not null default '{}',
  indexable boolean not null default false,
  publication_ready boolean not null default false,
  headline text not null check(char_length(btrim(headline)) between 1 and 180),
  public_summary text not null check(char_length(btrim(public_summary)) between 1 and 1200),
  general_impact text not null check(char_length(btrim(general_impact)) between 1 and 800),
  affected_public_entities jsonb not null default '[]'::jsonb
    check(jsonb_typeof(affected_public_entities)='array' and jsonb_array_length(affected_public_entities)<=5),
  reasons text[] not null default '{}',
  blockers text[] not null default '{}',
  factors jsonb not null default '{}'::jsonb check(jsonb_typeof(factors)='object' and octet_length(factors::text)<=8192),
  confidence numeric(4,3) not null check(confidence between 0 and 1),
  freshness text not null check(freshness in ('current','upcoming','recent','stale','expired')),
  announced_at timestamptz,
  effective_at timestamptz,
  last_verified_at timestamptz not null,
  current_evidence_at timestamptz not null,
  current_source_change_created_at timestamptz not null,
  current_classified_at timestamptz not null,
  current_source_change_id uuid not null references public.source_changes(id) on delete restrict,
  current_evidence_fingerprint text not null check(current_evidence_fingerprint ~ '^[a-f0-9]{32,64}$'),
  current_evaluation_id uuid,
  current_policy_version text not null check(char_length(current_policy_version) between 1 and 80),
  current_evaluator_version text not null check(char_length(current_evaluator_version) between 1 and 80),
  public_safety_version text not null check(char_length(public_safety_version) between 1 and 80),
  last_evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(not indexable or (decision='PUBLIC_PAGE' and publication_ready)),
  check(not publication_ready or decision in ('PUBLIC_PAGE','HUB_UPDATE','DISTRIBUTION_ONLY'))
);
create index growth_opportunities_decision_recent_idx on public.growth_opportunities(decision,last_evaluated_at desc,id desc);
create index growth_opportunities_status_recent_idx on public.growth_opportunities(status,last_evaluated_at desc,id desc);
create index growth_opportunities_topic_date_idx on public.growth_opportunities(topic_id,effective_at);
create index growth_opportunities_current_change_idx on public.growth_opportunities(current_source_change_id);

create table public.growth_opportunity_evaluations (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.growth_opportunities(id) on delete restrict,
  source_change_id uuid not null references public.source_changes(id) on delete restrict,
  classification_id uuid not null references public.source_change_classifications(id) on delete restrict,
  evaluator_version text not null check(char_length(evaluator_version) between 1 and 80),
  packet_schema_version integer not null check(packet_schema_version>0),
  policy_version text not null check(char_length(policy_version) between 1 and 80),
  evidence_fingerprint text not null check(evidence_fingerprint ~ '^[a-f0-9]{32,64}$'),
  decision text not null check(decision in ('PUBLIC_PAGE','HUB_UPDATE','DISTRIBUTION_ONLY','NOINDEX','IGNORE')),
  reasons text[] not null default '{}',
  blockers text[] not null default '{}',
  factors jsonb not null check(jsonb_typeof(factors)='object' and octet_length(factors::text)<=8192),
  confidence numeric(4,3) not null check(confidence between 0 and 1),
  supersedes_evaluation_id uuid,
  evaluated_at timestamptz not null default now(),
  unique(source_change_id,opportunity_id,evaluator_version,packet_schema_version,policy_version,evidence_fingerprint),
  unique(id,opportunity_id)
);
alter table public.growth_opportunity_evaluations add constraint growth_evaluation_supersedes_same_opportunity_fk
  foreign key(supersedes_evaluation_id,opportunity_id)
  references public.growth_opportunity_evaluations(id,opportunity_id) on delete restrict;
create index growth_evaluations_opportunity_recent_idx on public.growth_opportunity_evaluations(opportunity_id,evaluated_at desc,id desc);
create index growth_evaluations_source_change_idx on public.growth_opportunity_evaluations(source_change_id,evaluated_at desc);
alter table public.growth_opportunities add constraint growth_opportunities_current_evaluation_fk
  foreign key(current_evaluation_id,id) references public.growth_opportunity_evaluations(id,opportunity_id) on delete restrict;

create table public.growth_opportunity_evidence (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.growth_opportunities(id) on delete restrict,
  source_change_id uuid not null references public.source_changes(id) on delete restrict,
  classification_id uuid not null references public.source_change_classifications(id) on delete restrict,
  source_id uuid not null references public.source_catalog(id) on delete restrict,
  evidence_type text not null check(evidence_type in ('added','removed','changed')),
  excerpt text not null check(char_length(btrim(excerpt)) between 1 and 280),
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique(opportunity_id,source_change_id,classification_id,evidence_type,excerpt)
);
create index growth_evidence_opportunity_idx on public.growth_opportunity_evidence(opportunity_id,observed_at desc,id desc);
create index growth_evidence_source_change_idx on public.growth_opportunity_evidence(source_change_id);

create table public.growth_distribution_candidates (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.growth_opportunities(id) on delete restrict,
  candidate_type text not null check(candidate_type in ('X_POST','LINKEDIN_POST','FOUNDER_THREAD','SHORT_DEMO','NEWSLETTER_ITEM','OUTBOUND_TRIGGER')),
  status text not null default 'candidate' check(status in ('candidate','needs_review','approved','rejected','stale')),
  suggested_angle text not null check(char_length(btrim(suggested_angle)) between 1 and 500),
  safe_claim_boundaries text[] not null default '{}',
  freshness text not null check(freshness in ('current','upcoming','recent','stale','expired')),
  evidence_fingerprint text not null check(evidence_fingerprint ~ '^[a-f0-9]{32,64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(opportunity_id,candidate_type)
);
create index growth_distribution_queue_idx on public.growth_distribution_candidates(status,created_at,id);

create table public.growth_evaluation_queue (
  id uuid primary key default gen_random_uuid(),
  classification_id uuid not null references public.source_change_classifications(id) on delete restrict,
  source_change_id uuid not null references public.source_changes(id) on delete restrict,
  evaluator_version text not null check(char_length(evaluator_version) between 1 and 80),
  packet_schema_version integer not null check(packet_schema_version>0),
  policy_version text not null check(char_length(policy_version) between 1 and 80),
  status text not null default 'queued' check(status in ('queued','claimed','completed','failed')),
  attempts integer not null default 0 check(attempts between 0 and 5),
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_category text check(last_error_category is null or char_length(last_error_category)<=80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check((status='claimed' and lease_token is not null and lease_expires_at is not null)
    or (status<>'claimed' and lease_token is null and lease_expires_at is null)),
  unique(classification_id,evaluator_version,packet_schema_version,policy_version)
);
create index growth_evaluation_queue_claim_idx on public.growth_evaluation_queue(status,available_at,created_at,id)
  where status in ('queued','claimed','failed');
create index growth_evaluation_queue_change_idx on public.growth_evaluation_queue(source_change_id,created_at desc);

alter table public.growth_topics enable row level security;
alter table public.growth_opportunities enable row level security;
alter table public.growth_opportunity_evaluations enable row level security;
alter table public.growth_opportunity_evidence enable row level security;
alter table public.growth_distribution_candidates enable row level security;
alter table public.growth_evaluation_queue enable row level security;
revoke all on public.growth_topics,public.growth_opportunities,public.growth_opportunity_evaluations,
  public.growth_opportunity_evidence,public.growth_distribution_candidates,public.growth_evaluation_queue from public,anon,authenticated;
grant select,insert,update,delete on public.growth_topics,public.growth_opportunities,
  public.growth_opportunity_evaluations,public.growth_opportunity_evidence,
  public.growth_distribution_candidates,public.growth_evaluation_queue to service_role;

create function public.record_growth_evaluation(p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  provider_row public.dependency_catalog%rowtype;
  topic_row public.growth_topics%rowtype;
  opportunity_row public.growth_opportunities%rowtype;
  source_row record;
  evaluation_row public.growth_opportunity_evaluations%rowtype;
  evidence_row jsonb;
  eval_id uuid;
  inserted_evaluation boolean := false;
  should_update boolean;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>32768 then
    raise exception 'Growth evaluation payload is invalid' using errcode='22023';
  end if;
  if coalesce(p_payload->>'decision','') not in ('PUBLIC_PAGE','HUB_UPDATE','DISTRIBUTION_ONLY','NOINDEX','IGNORE')
    or coalesce(p_payload->>'status','') not in ('candidate','approved_by_engine','stale','superseded','rejected','published_later')
    or coalesce(p_payload->>'recommendedSurface','') not in ('PUBLIC_PAGE','PROVIDER_HUB','DISTRIBUTION','NOINDEX','FREE_TOOL','NONE')
    or jsonb_typeof(p_payload->'evidence') is distinct from 'array' or jsonb_array_length(p_payload->'evidence')>5
    or jsonb_typeof(p_payload->'factors') is distinct from 'object'
    or jsonb_typeof(p_payload->'reasons') is distinct from 'array'
    or jsonb_typeof(p_payload->'blockers') is distinct from 'array'
    or jsonb_typeof(p_payload->'safeClaimBoundaries') is distinct from 'array'
    or jsonb_typeof(p_payload->'ctaTypes') is distinct from 'array'
    or jsonb_typeof(p_payload->'affectedPublicEntities') is distinct from 'array'
    or jsonb_array_length(p_payload->'affectedPublicEntities')>5
    or (p_payload->>'freeToolType' is not null and p_payload->>'freeToolType' not in
      ('STACK_SCANNER','DEPENDENCY_EXPOSURE_CHECK','API_DEPRECATION_CHECKER','MODEL_RETIREMENT_CHECKER'))
    or exists(select 1 from jsonb_array_elements_text(p_payload->'ctaTypes') cta
      where cta not in ('CHECK_MY_STACK','SCAN_COMPANY','VERIFY_WITH_GITHUB'))
    or (p_payload ? 'distributionTypes' and (jsonb_typeof(p_payload->'distributionTypes') is distinct from 'array'
      or jsonb_array_length(p_payload->'distributionTypes')>6
      or exists(select 1 from jsonb_array_elements_text(p_payload->'distributionTypes') t
        where t not in ('X_POST','LINKEDIN_POST','FOUNDER_THREAD','SHORT_DEMO','NEWSLETTER_ITEM','OUTBOUND_TRIGGER')))) then
    raise exception 'Growth evaluation contract is invalid' using errcode='22023';
  end if;
  select * into provider_row from public.dependency_catalog
    where slug=p_payload->>'providerSlug' and enabled;
  if provider_row.id is null then raise exception 'Public provider is unavailable' using errcode='22023'; end if;
  select ch.id as change_id,ch.source_id,ch.created_at as change_at,src.dependency_id,
    cls.id as classification_id,cls.classified_at,cls.material,cls.category,src.url
    into source_row
  from public.source_changes ch
  join public.source_catalog src on src.id=ch.source_id and src.enabled and src.dependency_id=provider_row.id
  join public.source_change_classifications cls on cls.id=(p_payload->>'classificationId')::uuid
    and cls.change_id=ch.id and cls.status='classified' and cls.material
  where ch.id=(p_payload->>'sourceChangeId')::uuid;
  if source_row.change_id is null then raise exception 'Public material evidence is unavailable' using errcode='22023'; end if;
  if jsonb_array_length(p_payload->'evidence')=0 or exists(
    select 1 from jsonb_array_elements(p_payload->'evidence') e
    where e->>'type' not in ('added','removed','changed')
      or coalesce(char_length(btrim(e->>'excerpt')),0) not between 1 and 280
      or not exists(
        select 1 from public.source_changes cited_change
        join public.source_catalog cited_source on cited_source.id=cited_change.source_id and cited_source.enabled
        join public.dependency_catalog cited_provider on cited_provider.id=cited_source.dependency_id and cited_provider.enabled
        join public.source_change_classifications cited_classification on cited_classification.id=(e->>'classificationId')::uuid
          and cited_classification.change_id=cited_change.id and cited_classification.status='classified' and cited_classification.material
        cross join lateral jsonb_array_elements(cited_classification.evidence) cited_evidence
        where cited_change.id=(e->>'sourceChangeId')::uuid
          and cited_source.id=(e->>'sourceId')::uuid and cited_source.url=e->>'sourceUrl'
          and cited_provider.slug=p_payload->>'providerSlug'
          and cited_evidence->>'type'=e->>'type' and cited_evidence->>'excerpt'=e->>'excerpt')
  ) then
    raise exception 'Evidence references do not match public global evidence' using errcode='22023';
  end if;

  insert into public.growth_topics(provider_id,topic_key,entity_key,label,canonical_slug)
  values(provider_row.id,p_payload->>'topicKey',p_payload->>'entityKey',p_payload->>'topicLabel',p_payload->>'canonicalSlug')
  on conflict(provider_id,topic_key,entity_key) do nothing;
  select * into topic_row from public.growth_topics
    where provider_id=provider_row.id and topic_key=p_payload->>'topicKey' and entity_key=p_payload->>'entityKey';

  insert into public.growth_opportunities(topic_id,decision,status,recommended_surface,free_tool_type,cta_types,indexable,publication_ready,
    headline,public_summary,general_impact,affected_public_entities,reasons,blockers,factors,confidence,freshness,announced_at,effective_at,
    last_verified_at,current_evidence_at,current_source_change_created_at,current_classified_at,current_source_change_id,
    current_evidence_fingerprint,current_policy_version,current_evaluator_version,public_safety_version)
  values(topic_row.id,p_payload->>'decision',p_payload->>'status',p_payload->>'recommendedSurface',
    nullif(p_payload->>'freeToolType',''),array(select jsonb_array_elements_text(p_payload->'ctaTypes')),
    (p_payload->>'indexable')::boolean,(p_payload->>'publicationReady')::boolean,p_payload->>'headline',
    p_payload->>'publicSummary',p_payload->>'generalImpact',p_payload->'affectedPublicEntities',array(select jsonb_array_elements_text(p_payload->'reasons')),
    array(select jsonb_array_elements_text(p_payload->'blockers')),p_payload->'factors',
    (p_payload->>'confidence')::numeric,p_payload->>'freshness',nullif(p_payload->>'announcedAt','')::timestamptz,
    nullif(p_payload->>'effectiveAt','')::timestamptz,source_row.classified_at,
    greatest(source_row.change_at,source_row.classified_at),source_row.change_at,source_row.classified_at,source_row.change_id,
    p_payload->>'evidenceFingerprint',p_payload->>'policyVersion',
    p_payload->>'evaluatorVersion',p_payload->>'publicSafetyVersion')
  on conflict(topic_id) do update set
    decision=excluded.decision,status=excluded.status,recommended_surface=excluded.recommended_surface,
    free_tool_type=excluded.free_tool_type,cta_types=excluded.cta_types,
    indexable=excluded.indexable,publication_ready=excluded.publication_ready,headline=excluded.headline,
    public_summary=excluded.public_summary,general_impact=excluded.general_impact,
    affected_public_entities=excluded.affected_public_entities,reasons=excluded.reasons,
    blockers=excluded.blockers,factors=excluded.factors,confidence=excluded.confidence,freshness=excluded.freshness,
    announced_at=excluded.announced_at,effective_at=excluded.effective_at,last_verified_at=excluded.last_verified_at,
    current_evidence_at=excluded.current_evidence_at,current_source_change_id=excluded.current_source_change_id,
    current_source_change_created_at=excluded.current_source_change_created_at,current_classified_at=excluded.current_classified_at,
    current_evidence_fingerprint=excluded.current_evidence_fingerprint,
    current_policy_version=excluded.current_policy_version,current_evaluator_version=excluded.current_evaluator_version,
    public_safety_version=excluded.public_safety_version,last_evaluated_at=now(),updated_at=now()
  where (excluded.current_source_change_created_at,excluded.current_classified_at,excluded.current_source_change_id::text,
      excluded.current_policy_version,excluded.current_evaluator_version) >=
    (public.growth_opportunities.current_source_change_created_at,public.growth_opportunities.current_classified_at,
      public.growth_opportunities.current_source_change_id::text,
      public.growth_opportunities.current_policy_version,public.growth_opportunities.current_evaluator_version);
  select * into opportunity_row from public.growth_opportunities where topic_id=topic_row.id;
  should_update := (opportunity_row.current_source_change_created_at,opportunity_row.current_classified_at,
      opportunity_row.current_source_change_id::text,opportunity_row.current_policy_version,opportunity_row.current_evaluator_version) =
    (source_row.change_at,source_row.classified_at,source_row.change_id::text,
      p_payload->>'policyVersion',p_payload->>'evaluatorVersion');

  insert into public.growth_opportunity_evaluations(opportunity_id,source_change_id,classification_id,evaluator_version,
    packet_schema_version,policy_version,evidence_fingerprint,decision,reasons,blockers,factors,confidence,supersedes_evaluation_id)
  values(opportunity_row.id,source_row.change_id,source_row.classification_id,p_payload->>'evaluatorVersion',
    (p_payload->>'packetSchemaVersion')::integer,p_payload->>'policyVersion',p_payload->>'evidenceFingerprint',
    p_payload->>'decision',array(select jsonb_array_elements_text(p_payload->'reasons')),
    array(select jsonb_array_elements_text(p_payload->'blockers')),p_payload->'factors',(p_payload->>'confidence')::numeric,
    case when should_update then opportunity_row.current_evaluation_id else null end)
  on conflict(source_change_id,opportunity_id,evaluator_version,packet_schema_version,policy_version,evidence_fingerprint) do nothing
  returning id into eval_id;
  inserted_evaluation := eval_id is not null;
  if eval_id is null then
    select id into eval_id from public.growth_opportunity_evaluations
      where source_change_id=source_row.change_id and opportunity_id=opportunity_row.id and evaluator_version=p_payload->>'evaluatorVersion'
        and packet_schema_version=(p_payload->>'packetSchemaVersion')::integer
        and policy_version=p_payload->>'policyVersion' and evidence_fingerprint=p_payload->>'evidenceFingerprint';
  end if;
  if should_update then update public.growth_opportunities set current_evaluation_id=eval_id where id=opportunity_row.id; end if;

  if should_update then
    update public.growth_distribution_candidates candidate set status='stale',updated_at=now()
    where candidate.opportunity_id=opportunity_row.id and candidate.status in ('candidate','needs_review','stale')
      and (p_payload->>'decision' not in ('PUBLIC_PAGE','HUB_UPDATE','DISTRIBUTION_ONLY')
        or not coalesce((p_payload->>'publicationReady')::boolean,false)
        or not (candidate.candidate_type=any(array(select jsonb_array_elements_text(
          coalesce(p_payload->'distributionTypes','[]'::jsonb)))))
        or candidate.evidence_fingerprint is distinct from p_payload->>'evidenceFingerprint');
  end if;

  insert into public.growth_opportunity_evidence(opportunity_id,source_change_id,classification_id,source_id,
    evidence_type,excerpt,observed_at)
  select opportunity_row.id,cited_change.id,cited_classification.id,cited_source.id,
    evidence.value->>'type',evidence.value->>'excerpt',cited_classification.classified_at
  from jsonb_array_elements(p_payload->'evidence') evidence(value)
  join public.source_changes cited_change on cited_change.id=(evidence.value->>'sourceChangeId')::uuid
  join public.source_catalog cited_source on cited_source.id=(evidence.value->>'sourceId')::uuid and cited_source.id=cited_change.source_id
  join public.source_change_classifications cited_classification on cited_classification.id=(evidence.value->>'classificationId')::uuid
    and cited_classification.change_id=cited_change.id
  on conflict(opportunity_id,source_change_id,classification_id,evidence_type,excerpt) do nothing;
  if should_update and (p_payload->>'publicationReady')::boolean
    and p_payload->>'decision' in ('PUBLIC_PAGE','HUB_UPDATE','DISTRIBUTION_ONLY') then
    for evidence_row in select value from jsonb_array_elements(coalesce(p_payload->'distributionTypes','[]'::jsonb)) loop
      insert into public.growth_distribution_candidates(opportunity_id,candidate_type,status,suggested_angle,
        safe_claim_boundaries,freshness,evidence_fingerprint)
      values(opportunity_row.id,evidence_row#>>'{}','candidate',p_payload->>'suggestedAngle',
        array(select jsonb_array_elements_text(p_payload->'safeClaimBoundaries')),p_payload->>'freshness',p_payload->>'evidenceFingerprint')
      on conflict(opportunity_id,candidate_type) do update set
        status='candidate',suggested_angle=excluded.suggested_angle,safe_claim_boundaries=excluded.safe_claim_boundaries,
        freshness=excluded.freshness,evidence_fingerprint=excluded.evidence_fingerprint,updated_at=now()
      where public.growth_distribution_candidates.status in ('candidate','stale');
    end loop;
  end if;
  return jsonb_build_object('topicId',topic_row.id,'opportunityId',opportunity_row.id,
    'evaluationId',eval_id,'evaluationInserted',inserted_evaluation,'current',should_update,
    'canonicalSlug',topic_row.canonical_slug);
end;
$$;
revoke all on function public.record_growth_evaluation(jsonb) from public,anon,authenticated;
grant execute on function public.record_growth_evaluation(jsonb) to service_role;

create function private.enqueue_growth_evaluation()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.status='classified' and new.material then
    insert into public.growth_evaluation_queue(classification_id,source_change_id,evaluator_version,packet_schema_version,policy_version)
    values(new.id,new.change_id,'growth-rules-v1',1,'growth-policy-v1') on conflict do nothing;
  else
    update public.growth_evaluation_queue set status='completed',lease_token=null,lease_expires_at=null,
      last_error_category='no_longer_eligible',updated_at=now()
    where classification_id=new.id and status in ('queued','claimed','failed');
  end if;
  return new;
end;
$$;
revoke all on function private.enqueue_growth_evaluation() from public,anon,authenticated;
create trigger source_change_growth_evaluation_queue
  after insert or update on public.source_change_classifications
  for each row execute function private.enqueue_growth_evaluation();

insert into public.growth_evaluation_queue(classification_id,source_change_id,evaluator_version,packet_schema_version,policy_version)
select cls.id,cls.change_id,'growth-rules-v1',1,'growth-policy-v1'
from public.source_change_classifications cls
where cls.status='classified' and cls.material and cls.classified_at>=now()-interval '365 days'
order by cls.classified_at desc,cls.id desc
limit 500
on conflict(classification_id,evaluator_version,packet_schema_version,policy_version) do nothing;

create function public.claim_growth_evaluation_batch(p_limit integer default 25)
returns table(queue_id uuid,classification_id uuid,source_change_id uuid,lease_token uuid,attempts integer)
language plpgsql security invoker set search_path = '' as $$
begin
  if p_limit is null or p_limit<1 or p_limit>100 then
    raise exception 'Invalid growth batch size' using errcode='22023';
  end if;
  update public.growth_evaluation_queue set status='failed',lease_token=null,lease_expires_at=null,
    last_error_category='attempt_limit_reached',updated_at=now()
  where status='claimed' and lease_expires_at<now() and attempts>=5;
  update public.growth_evaluation_queue queue set status='completed',lease_token=null,lease_expires_at=null,
    last_error_category='no_longer_eligible',updated_at=now()
  where queue.status in ('queued','failed') and not exists(
    select 1 from public.source_change_classifications cls
    join public.source_changes change on change.id=cls.change_id
    join public.source_catalog source on source.id=change.source_id and source.enabled
    join public.dependency_catalog provider on provider.id=source.dependency_id and provider.enabled
    where cls.id=queue.classification_id and cls.change_id=queue.source_change_id
      and cls.status='classified' and cls.material);
  return query
  with selected as (
    select q.id from public.growth_evaluation_queue q
    where (q.status='queued' or (q.status='failed' and q.attempts<5)
      or (q.status='claimed' and q.lease_expires_at<now() and q.attempts<5))
      and q.available_at<=now()
    order by q.available_at,q.created_at,q.id
    for update skip locked limit p_limit
  )
  update public.growth_evaluation_queue q set status='claimed',attempts=q.attempts+1,
    lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes',updated_at=now()
  from selected where q.id=selected.id
  returning q.id,q.classification_id,q.source_change_id,q.lease_token,q.attempts;
end;
$$;
revoke all on function public.claim_growth_evaluation_batch(integer) from public,anon,authenticated;
grant execute on function public.claim_growth_evaluation_batch(integer) to service_role;

create function public.complete_growth_evaluation_queue(p_queue_id uuid,p_lease_token uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare changed integer;
begin
  update public.growth_evaluation_queue set status='completed',lease_token=null,lease_expires_at=null,
    last_error_category=null,updated_at=now()
  where id=p_queue_id and status='claimed' and lease_token=p_lease_token and lease_expires_at>now();
  get diagnostics changed=row_count;
  return changed=1;
end;
$$;
revoke all on function public.complete_growth_evaluation_queue(uuid,uuid) from public,anon,authenticated;
grant execute on function public.complete_growth_evaluation_queue(uuid,uuid) to service_role;

create function public.fail_growth_evaluation_queue(p_queue_id uuid,p_lease_token uuid,p_error_category text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare changed integer;
begin
  if p_error_category is null or p_error_category not in ('packet_unavailable','unsafe_public_packet','persistence_failed','evaluation_failed') then
    raise exception 'Invalid growth error category' using errcode='22023';
  end if;
  update public.growth_evaluation_queue set status='failed',lease_token=null,lease_expires_at=null,
    available_at=now()+make_interval(secs=>least(3600,30*(2^greatest(attempts-1,0))::integer)),
    last_error_category=p_error_category,updated_at=now()
  where id=p_queue_id and status='claimed' and lease_token=p_lease_token and lease_expires_at>now();
  get diagnostics changed=row_count;
  return changed=1;
end;
$$;
revoke all on function public.fail_growth_evaluation_queue(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fail_growth_evaluation_queue(uuid,uuid,text) to service_role;
