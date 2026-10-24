-- M15.79 (2/7): append-only, versioned per-Product coverage certificates.
-- The TypeScript evaluators (src/lib/coverage-certification) compute component states.
-- The issuing RPC is the only writer and acts as a guard: it binds the stored components to
-- their fingerprint, requires every current subject of the Product, rejects any component
-- that claims more than the evidence it references supports, and derives dimension states,
-- the overall state and the claim level itself. Certificates are never updated or deleted.

create table public.product_coverage_certificates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null,
  contract_version text not null check (contract_version = 'coverage-cert-v1'),
  sequence integer not null check (sequence > 0),
  issued_at timestamptz not null default now(),
  valid_until timestamptz,
  dependency_sources_state text not null
    check (dependency_sources_state in ('complete','partial','unsupported','unknown')),
  repository_code_state text not null
    check (repository_code_state in ('complete','partial','unsupported','unknown')),
  deployment_exposure_state text not null
    check (deployment_exposure_state in ('complete','partial','unsupported','unknown')),
  runtime_signals_state text not null
    check (runtime_signals_state in ('complete','partial','unsupported','unknown')),
  overall_state text not null check (overall_state in ('complete','partial','unsupported','unknown')),
  claim_level text not null check (claim_level in (
    'deployment_verified_protection','code_verified_protection','partial_protection','unverified'
  )),
  components_fingerprint text not null check (components_fingerprint ~ '^[a-f0-9]{64}$'),
  component_count integer not null check (component_count between 0 and 500),
  supersedes_certificate_id uuid,
  constraint product_coverage_certificates_product_fkey
    foreign key (product_id, workspace_id)
    references public.workspace_products(id, workspace_id) on delete cascade,
  constraint product_coverage_certificates_sequence_key unique (product_id, sequence),
  constraint product_coverage_certificates_id_workspace_key unique (id, workspace_id),
  constraint product_coverage_certificates_supersedes_fkey
    foreign key (supersedes_certificate_id, workspace_id)
    references public.product_coverage_certificates(id, workspace_id),
  constraint product_coverage_certificates_supersedes_order
    check ((sequence = 1) = (supersedes_certificate_id is null))
);
create index product_coverage_certificates_latest_idx
  on public.product_coverage_certificates(workspace_id, product_id, sequence desc);

create table public.product_coverage_certificate_components (
  id uuid primary key default gen_random_uuid(),
  certificate_id uuid not null,
  workspace_id uuid not null,
  dimension text not null check (dimension in (
    'dependency_sources','repository_code','deployment_exposure','runtime_signals'
  )),
  subject_type text not null check (subject_type in (
    'workspace_dependency','product_repository','deployment_surface','runtime_provider'
  )),
  subject_id text not null check (char_length(subject_id) between 1 and 100),
  state text not null check (state in ('complete','partial','unsupported','unknown')),
  reason text not null check (reason ~ '^[a-z_]{1,64}$'),
  evidence_refs jsonb not null default '[]'::jsonb check (
    jsonb_typeof(evidence_refs) = 'array' and jsonb_array_length(evidence_refs) <= 20
      and octet_length(evidence_refs::text) <= 4096
  ),
  expires_at timestamptz,
  constraint product_coverage_certificate_components_certificate_fkey
    foreign key (certificate_id, workspace_id)
    references public.product_coverage_certificates(id, workspace_id) on delete cascade,
  constraint product_coverage_certificate_components_subject_key
    unique (certificate_id, dimension, subject_type, subject_id)
);
create index product_coverage_certificate_components_certificate_idx
  on public.product_coverage_certificate_components(workspace_id, certificate_id);

create function private.reject_coverage_certificate_mutation()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'coverage_certificate_immutable' using errcode = '23514';
end;
$$;
revoke all on function private.reject_coverage_certificate_mutation() from public, anon, authenticated;
create trigger product_coverage_certificates_immutable
  before update or delete on public.product_coverage_certificates
  for each row execute function private.reject_coverage_certificate_mutation();
create trigger product_coverage_certificate_components_immutable
  before update or delete on public.product_coverage_certificate_components
  for each row execute function private.reject_coverage_certificate_mutation();

alter table public.product_coverage_certificates enable row level security;
alter table public.product_coverage_certificate_components enable row level security;
revoke all on public.product_coverage_certificates from public, anon, authenticated, service_role;
revoke all on public.product_coverage_certificate_components from public, anon, authenticated, service_role;
grant select on public.product_coverage_certificates to authenticated, service_role;
grant select on public.product_coverage_certificate_components to authenticated, service_role;

create policy product_coverage_certificates_member_read
  on public.product_coverage_certificates for select to authenticated
  using (exists (
    select 1 from public.workspace_members member
    where member.workspace_id = product_coverage_certificates.workspace_id
      and member.user_id = (select auth.uid())
  ));
create policy product_coverage_certificate_components_member_read
  on public.product_coverage_certificate_components for select to authenticated
  using (exists (
    select 1 from public.workspace_members member
    where member.workspace_id = product_coverage_certificate_components.workspace_id
      and member.user_id = (select auth.uid())
  ));

-- Weakest state; an empty set is 'unknown'. Mirrors weakestState() in evaluate.ts.
create function private.coverage_weakest_state(p_states text[])
returns text language sql immutable set search_path = '' as $$
  select coalesce(
    (select s from unnest(p_states) s
     order by array_position(array['complete','partial','unsupported','unknown'], s) desc
     limit 1),
    'unknown')
$$;

-- Mirrors claimLevelFor() in evaluate.ts; tests compare both over every combination.
create function private.coverage_claim_level(p_sources text, p_code text, p_deployment text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_sources = 'unknown' or p_code = 'unknown' then 'unverified'
    when p_sources <> 'complete' or p_code <> 'complete' then 'partial_protection'
    when p_deployment = 'complete' then 'deployment_verified_protection'
    else 'code_verified_protection'
  end
$$;
revoke all on function private.coverage_weakest_state(text[]) from public, anon, authenticated;
revoke all on function private.coverage_claim_level(text, text, text) from public, anon, authenticated;

create function public.issue_product_coverage_certificate(
  p_workspace_id uuid,
  p_product_id uuid,
  p_contract_version text,
  p_components jsonb,
  p_canonical_text text,
  p_components_fingerprint text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_product public.workspace_products%rowtype;
  v_latest public.product_coverage_certificates%rowtype;
  v_component jsonb;
  v_ref jsonb;
  v_dimension text;
  v_subject_type text;
  v_subject_id text;
  v_state text;
  v_expires_at timestamptz;
  v_dependency public.workspace_dependencies%rowtype;
  v_count integer;
  v_source_types integer;
  v_oldest_success timestamptz;
  v_analysis public.code_analysis_runs%rowtype;
  v_evidence public.product_deployment_evidence%rowtype;
  v_sync_completed timestamptz;
  v_sources text;
  v_code text;
  v_deployment text;
  v_runtime text;
  v_certificate_id uuid;
  v_sequence integer;
  v_claim text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_contract_version is distinct from 'coverage-cert-v1'
    or p_components is null or jsonb_typeof(p_components) <> 'array'
    or jsonb_array_length(p_components) > 500
    or p_components_fingerprint is null or p_components_fingerprint !~ '^[a-f0-9]{64}$'
    or p_canonical_text is null or octet_length(p_canonical_text) > 1048576 then
    raise exception 'coverage_certificate_request_invalid' using errcode = '22023';
  end if;
  -- Bind the stored components to the fingerprint the evaluator computed.
  if p_canonical_text::jsonb is distinct from
      jsonb_build_object('contractVersion', p_contract_version, 'components', p_components)
    or encode(sha256(convert_to(p_canonical_text, 'UTF8')), 'hex') <> p_components_fingerprint then
    raise exception 'coverage_certificate_fingerprint_mismatch' using errcode = '22023';
  end if;

  select * into v_product from public.workspace_products p
  where p.id = p_product_id and p.workspace_id = p_workspace_id
  for update;
  if not found or v_product.status <> 'protected' then
    raise exception 'coverage_certificate_product_invalid' using errcode = '42501';
  end if;

  -- Each component: structure, subject ownership, and no claim stronger than its evidence.
  for v_component in select value from jsonb_array_elements(p_components) loop
    if jsonb_typeof(v_component) <> 'object'
      or (v_component - array['dimension','subjectType','subjectId','state','reason','evidenceRefs','expiresAt']) <> '{}'::jsonb
      or jsonb_typeof(v_component->'evidenceRefs') <> 'array'
      or jsonb_array_length(v_component->'evidenceRefs') > 20 then
      raise exception 'coverage_certificate_component_invalid' using errcode = '22023';
    end if;
    v_dimension := v_component->>'dimension';
    v_subject_type := v_component->>'subjectType';
    v_subject_id := v_component->>'subjectId';
    v_state := v_component->>'state';
    v_expires_at := (v_component->>'expiresAt')::timestamptz;
    if v_state not in ('complete','partial','unsupported','unknown')
      or coalesce(v_component->>'reason', '') !~ '^[a-z_]{1,64}$'
      or (v_dimension, v_subject_type) not in (
        ('dependency_sources','workspace_dependency'), ('repository_code','product_repository'),
        ('deployment_exposure','deployment_surface'), ('runtime_signals','runtime_provider')) then
      raise exception 'coverage_certificate_component_invalid' using errcode = '22023';
    end if;

    if v_dimension = 'dependency_sources' then
      select * into v_dependency from public.workspace_dependencies d
      where d.id::text = v_subject_id and d.workspace_id = p_workspace_id
        and d.protected_product_id = p_product_id and d.monitoring_enabled;
      if not found then
        raise exception 'coverage_certificate_subject_invalid' using errcode = '42501';
      end if;
      if v_state in ('complete','partial') then
        -- Every enabled provider source must be referenced and freshly scanned.
        select count(*), count(distinct s.source_type), min(s.last_success_at)
          into v_count, v_source_types, v_oldest_success
        from public.source_catalog s
        where s.dependency_id = v_dependency.dependency_id and s.enabled
          and s.source_mode = 'provider';
        if v_count = 0
          or v_count <> (select count(distinct r->>'id') from jsonb_array_elements(v_component->'evidenceRefs') r
                         where r->>'kind' = 'source'
                           and exists (select 1 from public.source_catalog s
                                       where s.id::text = r->>'id' and s.dependency_id = v_dependency.dependency_id
                                         and s.enabled and s.source_mode = 'provider'))
          or exists (select 1 from public.source_catalog s
                     where s.dependency_id = v_dependency.dependency_id and s.enabled
                       and s.source_mode = 'provider'
                       and (s.last_success_at is null or s.last_success_at < now() - interval '48 hours'))
          or (v_state = 'complete' and v_source_types < 3)
          or v_expires_at is null or v_expires_at > v_oldest_success + interval '48 hours' then
          raise exception 'coverage_certificate_claim_exceeds_evidence' using errcode = '42501';
        end if;
      end if;
    elsif v_dimension = 'repository_code' then
      if not exists (select 1 from public.workspace_product_repositories m
                     where m.workspace_id = p_workspace_id and m.protected_product_id = p_product_id
                       and m.repository_id::text = v_subject_id and m.status = 'active') then
        raise exception 'coverage_certificate_subject_invalid' using errcode = '42501';
      end if;
      if v_state in ('complete','partial') then
        v_ref := (select r from jsonb_array_elements(v_component->'evidenceRefs') r
                  where r->>'kind' = 'code_analysis_run' limit 1);
        select * into v_analysis from public.code_analysis_runs a
        where v_ref is not null and a.id::text = v_ref->>'id' and a.workspace_id = p_workspace_id
          and a.repository_id::text = v_subject_id
          and (a.product_id is null or a.product_id = p_product_id);
        if not found or v_analysis.status <> 'completed'
          or v_analysis.commit_sha is distinct from v_ref->>'commitSha'
          or (v_state = 'complete' and v_analysis.coverage_state <> 'complete')
          or (v_state = 'partial' and v_analysis.coverage_state not in ('complete','partial')) then
          raise exception 'coverage_certificate_claim_exceeds_evidence' using errcode = '42501';
        end if;
      end if;
    elsif v_dimension = 'deployment_exposure' then
      if not exists (select 1 from public.workspace_product_deployment_surfaces l
                     where l.workspace_id = p_workspace_id and l.protected_product_id = p_product_id
                       and l.deployment_surface_id::text = v_subject_id) then
        raise exception 'coverage_certificate_subject_invalid' using errcode = '42501';
      end if;
      if v_state in ('complete','partial') then
        v_ref := (select r from jsonb_array_elements(v_component->'evidenceRefs') r
                  where r->>'kind' = 'product_deployment_evidence' limit 1);
        select * into v_evidence from public.product_deployment_evidence e
        where v_ref is not null and e.id::text = v_ref->>'id' and e.workspace_id = p_workspace_id
          and e.protected_product_id = p_product_id and e.deployment_surface_id::text = v_subject_id;
        select a.completed_at into v_sync_completed from public.deployment_sync_attempts a
        where a.workspace_id = p_workspace_id and a.deployment_surface_id::text = v_subject_id
          and a.status in ('succeeded','failed') and a.completed_at is not null
        order by a.completed_at desc, a.id desc limit 1;
        if v_evidence.id is null
          or v_evidence.verified_commit_sha is distinct from v_ref->>'commitSha'
          or not exists (select 1 from public.deployment_sync_attempts a
                         where a.workspace_id = p_workspace_id and a.deployment_surface_id::text = v_subject_id
                           and a.status = 'succeeded' and a.completed_at = v_sync_completed)
          or v_sync_completed < now() - interval '24 hours'
          or (v_state = 'complete' and v_evidence.verification_state <> 'production_verified')
          or (v_state = 'partial' and v_evidence.verification_state not in ('production_verified','commit_verified'))
          or v_expires_at is null or v_expires_at > v_sync_completed + interval '24 hours' then
          raise exception 'coverage_certificate_claim_exceeds_evidence' using errcode = '42501';
        end if;
        v_evidence := null;
      end if;
    else
      -- No runtime adapter exists in contract v1.
      if v_subject_id <> 'none' or v_state <> 'unknown' then
        raise exception 'coverage_certificate_claim_exceeds_evidence' using errcode = '42501';
      end if;
    end if;
  end loop;

  -- Every current subject of the Product must be present; omission cannot strengthen a claim.
  if exists (
      select d.id::text from public.workspace_dependencies d
      where d.workspace_id = p_workspace_id and d.protected_product_id = p_product_id and d.monitoring_enabled
      except select c->>'subjectId' from jsonb_array_elements(p_components) c where c->>'dimension' = 'dependency_sources')
    or exists (
      select m.repository_id::text from public.workspace_product_repositories m
      where m.workspace_id = p_workspace_id and m.protected_product_id = p_product_id and m.status = 'active'
      except select c->>'subjectId' from jsonb_array_elements(p_components) c where c->>'dimension' = 'repository_code')
    or exists (
      select l.deployment_surface_id::text from public.workspace_product_deployment_surfaces l
      where l.workspace_id = p_workspace_id and l.protected_product_id = p_product_id
      except select c->>'subjectId' from jsonb_array_elements(p_components) c where c->>'dimension' = 'deployment_exposure') then
    raise exception 'coverage_certificate_subjects_incomplete' using errcode = '42501';
  end if;

  select private.coverage_weakest_state(coalesce(array_agg(c->>'state') filter (where c->>'dimension' = 'dependency_sources'), '{}')),
         private.coverage_weakest_state(coalesce(array_agg(c->>'state') filter (where c->>'dimension' = 'repository_code'), '{}')),
         private.coverage_weakest_state(coalesce(array_agg(c->>'state') filter (where c->>'dimension' = 'deployment_exposure'), '{}')),
         private.coverage_weakest_state(coalesce(array_agg(c->>'state') filter (where c->>'dimension' = 'runtime_signals'), '{}'))
    into v_sources, v_code, v_deployment, v_runtime
  from jsonb_array_elements(p_components) c;
  v_claim := private.coverage_claim_level(v_sources, v_code, v_deployment);

  select * into v_latest from public.product_coverage_certificates c
  where c.workspace_id = p_workspace_id and c.product_id = p_product_id
  order by c.sequence desc limit 1;
  if found and v_latest.components_fingerprint = p_components_fingerprint then
    return jsonb_build_object('status', 'unchanged', 'certificateId', v_latest.id,
      'sequence', v_latest.sequence, 'claimLevel', v_latest.claim_level);
  end if;
  v_sequence := coalesce(v_latest.sequence, 0) + 1;

  insert into public.product_coverage_certificates (
    workspace_id, product_id, contract_version, sequence, valid_until,
    dependency_sources_state, repository_code_state, deployment_exposure_state, runtime_signals_state,
    overall_state, claim_level, components_fingerprint, component_count, supersedes_certificate_id
  ) values (
    p_workspace_id, p_product_id, p_contract_version, v_sequence,
    (select min((c->>'expiresAt')::timestamptz) from jsonb_array_elements(p_components) c),
    v_sources, v_code, v_deployment, v_runtime,
    private.coverage_weakest_state(array[v_sources, v_code, v_deployment]), v_claim,
    p_components_fingerprint, jsonb_array_length(p_components), v_latest.id
  ) returning id into v_certificate_id;

  insert into public.product_coverage_certificate_components (
    certificate_id, workspace_id, dimension, subject_type, subject_id, state, reason, evidence_refs, expires_at
  )
  select v_certificate_id, p_workspace_id, c->>'dimension', c->>'subjectType', c->>'subjectId',
    c->>'state', c->>'reason', c->'evidenceRefs', (c->>'expiresAt')::timestamptz
  from jsonb_array_elements(p_components) c;

  return jsonb_build_object('status', 'issued', 'certificateId', v_certificate_id,
    'sequence', v_sequence, 'claimLevel', v_claim);
end;
$$;
revoke all on function public.issue_product_coverage_certificate(uuid, uuid, text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.issue_product_coverage_certificate(uuid, uuid, text, jsonb, text, text)
  to service_role;
