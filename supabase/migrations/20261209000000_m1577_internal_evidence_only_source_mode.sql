-- M15.77: isolate internal evidence-only source changes from customer actions.
-- Provider sources keep their historical global semantics by default.

alter table public.source_catalog
  add column source_mode text not null default 'provider'
    check (source_mode in ('provider', 'internal_test')),
  add column processing_mode text not null default 'customer'
    check (processing_mode in ('customer', 'evidence_only')),
  add column workspace_id uuid references public.workspaces(id) on delete restrict,
  add column scope_product_id uuid,
  add column internal_acceptance_key text unique
    check (internal_acceptance_key is null or internal_acceptance_key ~ '^[a-z0-9][a-z0-9_-]{7,95}$'),
  add constraint source_catalog_mode_scope_check check (
    (source_mode = 'provider' and processing_mode = 'customer'
      and workspace_id is null and scope_product_id is null and internal_acceptance_key is null)
    or
    (source_mode = 'internal_test' and processing_mode = 'evidence_only'
      and workspace_id is not null and scope_product_id is not null
      and internal_acceptance_key is not null)
  ),
  add constraint source_catalog_scope_product_workspace_fkey
    foreign key (scope_product_id, workspace_id)
    references public.workspace_products(id, workspace_id) on delete restrict;

alter table public.source_changes
  add column source_mode text not null default 'provider'
    check (source_mode in ('provider', 'internal_test')),
  add column processing_mode text not null default 'customer'
    check (processing_mode in ('customer', 'evidence_only')),
  add column workspace_id uuid references public.workspaces(id) on delete restrict,
  add column scope_product_id uuid,
  add column internal_acceptance_key text,
  add constraint source_changes_mode_scope_check check (
    (source_mode = 'provider' and processing_mode = 'customer'
      and workspace_id is null and scope_product_id is null and internal_acceptance_key is null)
    or
    (source_mode = 'internal_test' and processing_mode = 'evidence_only'
      and workspace_id is not null and scope_product_id is not null
      and internal_acceptance_key is not null)
  ),
  add constraint source_changes_scope_product_workspace_fkey
    foreign key (scope_product_id, workspace_id)
    references public.workspace_products(id, workspace_id) on delete restrict;

create index source_changes_internal_scope_idx
  on public.source_changes(workspace_id, scope_product_id, created_at desc)
  where source_mode = 'internal_test';

create function private.copy_source_change_provenance()
returns trigger language plpgsql security definer set search_path = '' as $$
declare s public.source_catalog%rowtype;
begin
  select * into s from public.source_catalog where id = new.source_id;
  if not found then raise exception 'Source provenance is unavailable' using errcode = 'P0002'; end if;
  new.source_mode := s.source_mode;
  new.processing_mode := s.processing_mode;
  new.workspace_id := s.workspace_id;
  new.scope_product_id := s.scope_product_id;
  new.internal_acceptance_key := s.internal_acceptance_key;
  return new;
end;
$$;

create trigger source_changes_copy_provenance
  before insert on public.source_changes
  for each row execute function private.copy_source_change_provenance();

revoke all on function private.copy_source_change_provenance() from public, anon, authenticated;

-- Internal sources are created only for an already protected Product/dependency
-- pair. The idempotency key is durable provenance, not a customer-facing API.
create function public.create_internal_test_source(
  p_workspace_id uuid, p_product_id uuid, p_dependency_id uuid, p_internal_key text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if p_workspace_id is null or p_product_id is null or p_dependency_id is null
    or p_internal_key is null or p_internal_key !~ '^[a-z0-9][a-z0-9_-]{7,95}$' then
    raise exception 'Internal test source identity is invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.workspace_products p
    join public.workspace_dependencies wd
      on wd.workspace_id = p.workspace_id and wd.protected_product_id = p.id
    where p.id = p_product_id and p.workspace_id = p_workspace_id and p.status = 'protected'
      and wd.dependency_id = p_dependency_id and wd.monitoring_enabled
  ) then
    raise exception 'Internal test target is not an active protected Product dependency'
      using errcode = '42501';
  end if;
  select id into v_id from public.source_catalog where internal_acceptance_key = p_internal_key;
  if found then
    if not exists (
      select 1 from public.source_catalog s where s.id = v_id
        and s.source_mode = 'internal_test' and s.processing_mode = 'evidence_only'
        and s.workspace_id = p_workspace_id and s.scope_product_id = p_product_id
        and s.dependency_id = p_dependency_id
    ) then raise exception 'Internal acceptance key is bound to another target' using errcode = '23505'; end if;
    return v_id;
  end if;
  insert into public.source_catalog (
    dependency_id, name, source_type, url, fetch_strategy, enabled,
    source_mode, processing_mode, workspace_id, scope_product_id, internal_acceptance_key
  ) values (
    p_dependency_id, 'internal-test-' || p_internal_key, 'changelog',
    'https://internal-test.invalid/' || p_internal_key, 'http', true,
    'internal_test', 'evidence_only', p_workspace_id, p_product_id, p_internal_key
  ) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.create_internal_test_source(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.create_internal_test_source(uuid, uuid, uuid, text)
  to service_role;

-- Scheduled provider scans must never discover internal acceptance sources.
create or replace function public.list_due_source_ids(
  p_now timestamptz default now(), p_limit integer default 100
)
returns table (source_id uuid) language sql security invoker set search_path = '' as $$
  select source.id
  from public.source_catalog as source
  where source.enabled and source.source_mode = 'provider'
    and source.processing_mode = 'customer'
    and (source.last_checked_at is null
      or source.last_checked_at + make_interval(secs => source.default_interval_seconds) <= p_now)
  order by source.last_checked_at asc nulls first, source.id
  limit least(greatest(coalesce(p_limit, 1), 1), 100);
$$;

-- Preserve the existing global provider queue behavior; internal evidence is
-- explicitly excluded at the queue creation boundary and at later eligibility.
create or replace function private.enqueue_customer_impact_for_dependency(
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
    and source.source_mode = 'provider' and source.processing_mode = 'customer'
  join public.source_changes change on change.source_id = source.id
    and change.source_mode = 'provider' and change.processing_mode = 'customer'
  join public.source_change_classifications classification on classification.change_id = change.id
  where wd.id = p_workspace_dependency_id and wd.monitoring_enabled
    and change.created_at >= coalesce(wd.protection_started_at, wd.created_at)
    and classification.status = 'classified' and classification.material
    and classification.decision_status = 'classified'
    and not exists (
      select 1 from public.source_change_classifications newer
      where newer.change_id = classification.change_id and newer.status = 'classified'
        and (newer.created_at > classification.created_at
          or (newer.created_at = classification.created_at and newer.id > classification.id))
    )
  on conflict (workspace_dependency_id, source_change_classification_id, context_revision) do nothing;
end;
$$;

create or replace function private.enqueue_customer_impacts_on_classification()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status <> 'classified' or not new.material or new.decision_status <> 'classified' then
    return new;
  end if;
  insert into public.customer_impact_dispatch_queue (
    workspace_id, workspace_dependency_id, source_change_classification_id, context_revision
  )
  select wd.workspace_id, wd.id, new.id, coalesce(dc.context_revision, 0)
  from public.source_changes change
  join public.source_catalog source on source.id = change.source_id
    and source.source_mode = 'provider' and source.processing_mode = 'customer'
  join public.workspace_dependencies wd on wd.dependency_id = source.dependency_id
  left join public.dependency_context dc on dc.workspace_dependency_id = wd.id
  where change.id = new.change_id and change.source_mode = 'provider'
    and change.processing_mode = 'customer' and wd.monitoring_enabled
    and change.created_at >= coalesce(wd.protection_started_at, wd.created_at)
    and not exists (
      select 1 from public.source_change_classifications newer
      where newer.change_id = new.change_id and newer.status = 'classified'
        and (newer.created_at > new.created_at or (newer.created_at = new.created_at and newer.id > new.id))
    )
  on conflict (workspace_dependency_id, source_change_classification_id, context_revision) do nothing;
  return new;
end;
$$;

create or replace function private.customer_impact_input_is_eligible(
  p_workspace_dependency_id uuid, p_source_change_classification_id uuid, p_evaluation_mode text
)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(exists (
    select 1 from public.workspace_dependencies wd
    join public.workspace_products product on product.id = wd.protected_product_id
      and product.workspace_id = wd.workspace_id
    join public.source_change_classifications classification on classification.id = p_source_change_classification_id
    join public.source_changes change on change.id = classification.change_id
      and change.source_mode = 'provider' and change.processing_mode = 'customer'
    join public.source_catalog source on source.id = change.source_id
      and source.dependency_id = wd.dependency_id
      and source.source_mode = 'provider' and source.processing_mode = 'customer'
    where wd.id = p_workspace_dependency_id and wd.monitoring_enabled
      and wd.protection_started_at is not null and source.enabled
      and (p_evaluation_mode = 'live' or product.status = 'protected')
      and classification.status = 'classified' and classification.material
      and classification.decision_status = 'classified'
      and not exists (
        select 1 from public.source_change_classifications newer
        where newer.change_id = classification.change_id and newer.status = 'classified'
          and (newer.created_at > classification.created_at
            or (newer.created_at = classification.created_at and newer.id > classification.id))
      )
      and case p_evaluation_mode
        when 'live' then change.created_at >= wd.protection_started_at
        when 'baseline' then change.created_at >= wd.protection_started_at - interval '30 days'
          and change.created_at < wd.protection_started_at
        else false end
  ), false);
$$;

revoke all on function private.customer_impact_input_is_eligible(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function private.customer_impact_input_is_eligible(uuid, uuid, text)
  to service_role;

-- Route intent scope is copied from immutable source-change provenance. Provider
-- rows remain NULL/global; internal rows carry both workspace and Product.
alter table public.intelligence_route_intents add column scope_product_id uuid;
alter table public.intelligence_route_intents
  add constraint intelligence_route_intents_scope_product_workspace_fkey
  foreign key (scope_product_id, workspace_id)
  references public.workspace_products(id, workspace_id) on delete restrict;

create function private.guard_intelligence_route_intent_scope()
returns trigger language plpgsql security definer set search_path = '' as $$
declare c public.source_changes%rowtype;
begin
  select * into c from public.source_changes where id = new.source_change_id;
  if not found then raise exception 'Route source provenance is unavailable' using errcode = 'P0002'; end if;
  if (c.source_mode = 'provider' and c.processing_mode = 'customer'
      and c.workspace_id is null and c.scope_product_id is null
      and new.workspace_id is null and new.scope_product_id is null)
    or (c.source_mode = 'internal_test' and c.processing_mode = 'evidence_only'
      and c.workspace_id is not null and c.scope_product_id is not null
      and new.workspace_id = c.workspace_id and new.scope_product_id = c.scope_product_id) then
    return new;
  end if;
  raise exception 'Route intent scope does not match source provenance' using errcode = '23514';
end;
$$;
create trigger intelligence_route_intents_scope_guard
  before insert or update of source_change_id, workspace_id, scope_product_id
  on public.intelligence_route_intents
  for each row execute function private.guard_intelligence_route_intent_scope();
revoke all on function private.guard_intelligence_route_intent_scope() from public, anon, authenticated;

-- Defense in depth: even a direct service-role call to the analysis/graph RPCs
-- cannot attach an internal intent to another Product or workspace.
create function private.guard_internal_evidence_handoff_scope()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_intent public.intelligence_route_intents%rowtype; v_change public.source_changes%rowtype;
begin
  select * into v_intent from public.intelligence_route_intents where id = new.route_intent_id;
  if not found then raise exception 'Route intent is unavailable' using errcode = 'P0002'; end if;
  select * into v_change from public.source_changes where id = v_intent.source_change_id;
  if not found then raise exception 'Source provenance is unavailable' using errcode = 'P0002'; end if;
  if v_change.source_mode = 'provider' and v_change.processing_mode = 'customer' then
    return new;
  end if;
  if v_change.source_mode = 'internal_test' and v_change.processing_mode = 'evidence_only'
    and new.workspace_id = v_change.workspace_id
    and new.product_id = v_change.scope_product_id
    and v_intent.workspace_id = v_change.workspace_id
    and v_intent.scope_product_id = v_change.scope_product_id then
    return new;
  end if;
  raise exception 'Internal evidence handoff escaped its declared scope' using errcode = '42501';
end;
$$;
create trigger code_analysis_route_handoffs_evidence_scope_guard
  before insert or update of route_intent_id, workspace_id, product_id
  on public.code_analysis_route_handoffs
  for each row execute function private.guard_internal_evidence_handoff_scope();
create trigger impact_graph_builds_evidence_scope_guard
  before insert or update of route_intent_id, workspace_id, product_id
  on public.impact_graph_builds
  for each row execute function private.guard_internal_evidence_handoff_scope();
revoke all on function private.guard_internal_evidence_handoff_scope() from public, anon, authenticated;

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
    raise exception 'Router version is invalid' using errcode = '22023';
  end if;
  select * into c from public.source_changes where id = p_source_change_id;
  if not found then raise exception 'Source change not found' using errcode = 'P0002'; end if;
  if (c.source_mode = 'internal_test' and (c.processing_mode <> 'evidence_only'
      or c.workspace_id is null or c.scope_product_id is null))
    or (c.source_mode = 'provider' and (c.processing_mode <> 'customer'
      or c.workspace_id is not null or c.scope_product_id is not null)) then
    raise exception 'Source change provenance is invalid' using errcode = '22023';
  end if;
  select * into d from public.change_intelligence_decisions
    where source_change_id = p_source_change_id and status = 'completed'
    order by created_at desc limit 1;
  if not found then raise exception 'Completed intelligence decision not found' using errcode = 'P0002'; end if;
  if d.proposed_route = 'uncertain' and d.proposed_policy_state = 'suppress_candidate' then
    raise exception 'Uncertain decisions cannot be suppressed' using errcode = '22023';
  end if;
  if d.proposed_policy_state = 'suppress_candidate' and (
    d.proposed_route <> 'docs_noise'
    or coalesce(d.evidence_quality->>'sourceCriticality','standard') = 'critical'
    or coalesce((d.evidence_quality->>'incomplete')::boolean,true)
  ) then raise exception 'Unsafe intelligence suppression rejected' using errcode = '22023'; end if;
  target := public.resolve_intelligence_route_target(d.proposed_route,d.proposed_policy_state);
  if target is null then raise exception 'Intelligence route is invalid' using errcode = '22023'; end if;
  initial_status := case when d.proposed_policy_state = 'suppress_candidate' then 'suppressed'
    when d.proposed_policy_state = 'continue_candidate' then 'pending' else 'queued' end;
  effective_policy_version := coalesce(d.active_policy_version,d.policy_version);
  idem := 'intelligence-router-v1:' || md5(d.source_change_id::text || ':' || d.id::text || ':' || effective_policy_version || ':' || p_router_version);
  insert into public.intelligence_route_intents (
    workspace_id, scope_product_id, source_change_id, intelligence_decision_id,
    policy_version, engine_version, router_version, provider, requested_model, response_model,
    route, policy_state, route_target, route_status, reason, evidence_fingerprint,
    idempotency_key, completed_at
  ) values (
    c.workspace_id, c.scope_product_id, d.source_change_id, d.id,
    effective_policy_version, d.engine_version, p_router_version, d.provider, d.model, d.response_model,
    d.proposed_route, d.proposed_policy_state, target, initial_status,
    coalesce(d.policy_reason,'policy_decision'), d.evidence_fingerprint, idem,
    case when initial_status = 'suppressed' then now() else null end
  ) on conflict (source_change_id,intelligence_decision_id,policy_version,router_version) do nothing;
  get diagnostics inserted_count = row_count;
  select * into r from public.intelligence_route_intents
    where source_change_id = d.source_change_id and intelligence_decision_id = d.id
      and policy_version = effective_policy_version and router_version = p_router_version;
  if r.workspace_id is distinct from c.workspace_id or r.scope_product_id is distinct from c.scope_product_id then
    raise exception 'Existing route intent scope differs from immutable source provenance' using errcode = '23514';
  end if;
  if r.route_target = 'evidence_escalation' and r.route_status in ('queued','dispatching','dispatched') then
    insert into public.intelligence_evidence_escalations(route_intent_id,last_reason)
      values (r.id, coalesce(r.reason,'evidence_escalation')) on conflict (route_intent_id) do nothing;
  end if;
  return jsonb_build_object('id',r.id,'sourceChangeId',r.source_change_id,'decisionId',r.intelligence_decision_id,
    'workspaceId',r.workspace_id,'productId',r.scope_product_id,'route',r.route,
    'policyState',r.policy_state,'policyVersion',r.policy_version,'routeTarget',r.route_target,
    'routeStatus',r.route_status,'idempotencyKey',r.idempotency_key,'replayed',inserted_count = 0);
end;
$$;

create or replace function public.list_code_intelligence_route_targets(p_route_intent_id uuid)
returns table(workspace_id uuid, product_id uuid, repository_id uuid, owner text, name text,
  default_branch text, external_id bigint, installation_id bigint)
language plpgsql security invoker set search_path = '' as $$
declare v_intent public.intelligence_route_intents%rowtype;
begin
  select * into v_intent from public.intelligence_route_intents intent
  where intent.id = p_route_intent_id and intent.route_status = 'pending'
    and intent.route_target in ('dependency_product_impact','dependency_impact_repository_exposure_candidate',
      'contract_exposure_analysis','repository_dependency_exposure_analysis',
      'contract_repository_exposure_analysis','integration_auth_risk_analysis');
  if not found then raise exception 'Code intelligence route intent is not eligible' using errcode = '22023'; end if;
  if not exists (
    select 1 from public.source_changes change
    where change.id = v_intent.source_change_id
      and ((change.source_mode = 'provider' and change.processing_mode = 'customer'
          and change.workspace_id is null and change.scope_product_id is null
          and v_intent.workspace_id is null and v_intent.scope_product_id is null)
        or (change.source_mode = 'internal_test' and change.processing_mode = 'evidence_only'
          and change.workspace_id is not null and change.scope_product_id is not null
          and v_intent.workspace_id = change.workspace_id
          and v_intent.scope_product_id = change.scope_product_id))
  ) then raise exception 'Route intent scope does not match source provenance' using errcode = '23514'; end if;
  return query
    select mapping.workspace_id,mapping.protected_product_id,repository.id,repository.owner,repository.name,
      repository.default_branch,repository.external_id,connection.installation_id
    from public.intelligence_route_intents intent
    join public.source_changes source_change on source_change.id = intent.source_change_id
    join public.source_catalog source on source.id = source_change.source_id
    join public.dependency_catalog dependency on dependency.id = source.dependency_id and dependency.enabled
    join public.workspace_dependencies workspace_dependency on workspace_dependency.dependency_id = dependency.id
      and workspace_dependency.monitoring_enabled
      and source_change.created_at >= coalesce(workspace_dependency.protection_started_at,workspace_dependency.created_at)
      and (intent.workspace_id is null or workspace_dependency.workspace_id = intent.workspace_id)
      and (intent.scope_product_id is null or workspace_dependency.protected_product_id = intent.scope_product_id)
    join public.workspace_product_repositories mapping on mapping.workspace_id = workspace_dependency.workspace_id
      and mapping.protected_product_id = workspace_dependency.protected_product_id and mapping.status = 'active'
    join public.workspace_products product on product.id = mapping.protected_product_id
      and product.workspace_id = mapping.workspace_id and product.status = 'protected'
    join public.repositories repository on repository.id = mapping.repository_id
      and repository.workspace_id = mapping.workspace_id and repository.status = 'available'
    join public.repository_connections connection on connection.id = repository.connection_id
      and connection.workspace_id = repository.workspace_id and connection.status = 'connected'
      and connection.provider = 'github'
    where intent.id = p_route_intent_id
    order by mapping.workspace_id,mapping.protected_product_id,repository.id
    limit 51;
end;
$$;

revoke all on function public.create_internal_test_source(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.create_internal_test_source(uuid, uuid, uuid, text)
  to service_role;
