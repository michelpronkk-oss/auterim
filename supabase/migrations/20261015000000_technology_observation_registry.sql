-- Versioned, bounded public technology observations are separate from protectable dependency
-- candidates. Details are readable/writable only through trusted server operations.
create table public.technology_observations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  run_id uuid not null,
  technology_slug text not null check (technology_slug ~ '^[a-z0-9-]{1,80}$'),
  technology_name text not null check (char_length(technology_name) between 1 and 100),
  category text not null check (category in (
    'framework', 'library', 'build_tool', 'hosting', 'monitoring', 'analytics', 'payments',
    'identity', 'database', 'search', 'messaging', 'ai', 'other_service'
  )),
  fingerprint_id text not null check (fingerprint_id ~ '^[a-z0-9-]{1,120}$'),
  registry_version text not null check (registry_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]{1,3}$'),
  evidence_family text not null check (evidence_family in (
    'response_header', 'html_structure', 'script_asset', 'stylesheet_asset',
    'javascript_bundle', 'runtime_network', 'public_config'
  )),
  strength text not null check (strength in ('strong', 'medium', 'weak')),
  relationship text not null check (relationship in (
    'framework_for', 'built_with', 'hosted_on', 'optional_integration', 'provides_service', 'unknown'
  )),
  protectability text not null check (protectability in ('protectable', 'non_protectable', 'unknown')),
  status text not null check (status in ('weak', 'supported', 'strong', 'conflicted', 'suppressed', 'unknown')),
  disposition text not null check (disposition in ('observed', 'suggested', 'suppressed')),
  suppression_reason text check (suppression_reason is null or suppression_reason in (
    'framework', 'library', 'build_tool', 'marketing_only', 'weak_evidence',
    'optional_integration', 'non_protectable'
  )),
  surface_type text not null check (surface_type in (
    'ROOT_MARKETING', 'PRODUCT_APP', 'AUTH_APP', 'DASHBOARD', 'CUSTOMER_PORTAL',
    'FIRST_PARTY_API', 'DOCS', 'BLOG', 'STATUS', 'SUPPORT', 'INTEGRATION_DIRECTORY', 'UNKNOWN'
  )),
  surface_host text not null check (
    surface_host = lower(surface_host) and char_length(surface_host) between 1 and 253
    and surface_host !~ '[/@?#]'
  ),
  source_host text not null check (
    source_host = lower(source_host) and char_length(source_host) between 1 and 253
    and source_host !~ '[/@?#]'
  ),
  created_at timestamptz not null default now(),
  constraint technology_observations_run_workspace_fkey
    foreign key (run_id, workspace_id)
    references public.dependency_discovery_runs (id, workspace_id) on delete cascade,
  constraint technology_observations_run_fingerprint_key
    unique (run_id, surface_type, surface_host, technology_slug, fingerprint_id, source_host)
);

create index technology_observations_run_idx
  on public.technology_observations (workspace_id, run_id, technology_slug);

alter table public.technology_observations enable row level security;
revoke all on public.technology_observations from public, anon, authenticated;
grant all on public.technology_observations to service_role;

drop function public.complete_url_dependency_discovery_run(
  uuid, uuid, uuid, text, text, boolean, integer, integer, jsonb, jsonb, jsonb
);

create function public.complete_url_dependency_discovery_run(
  p_run_id uuid,
  p_workspace_id uuid,
  p_company_id uuid,
  p_status text,
  p_error_category text,
  p_deep_pass_requested boolean,
  p_deep_scripts_fetched integer,
  p_deep_bytes_fetched integer,
  p_evidence jsonb,
  p_candidates jsonb,
  p_coverage jsonb default '{}'::jsonb,
  p_technology_observations jsonb default '[]'::jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  run_row public.dependency_discovery_runs%rowtype;
  candidate record;
  dependency_id uuid;
begin
  if p_status not in ('completed', 'partial', 'failed')
    or p_error_category is not null and p_error_category !~ '^[a-z_]{1,80}$'
    or p_deep_pass_requested is null
    or p_deep_scripts_fetched is null or p_deep_scripts_fetched not between 0 and 4
    or p_deep_bytes_fetched is null or p_deep_bytes_fetched not between 0 and 393216
    or p_evidence is null or jsonb_typeof(p_evidence) <> 'array'
    or jsonb_array_length(p_evidence) > 500 or octet_length(p_evidence::text) > 262144
    or p_candidates is null or jsonb_typeof(p_candidates) <> 'array'
    or jsonb_array_length(p_candidates) > 100 or octet_length(p_candidates::text) > 65536
    or p_coverage is null or jsonb_typeof(p_coverage) <> 'object'
    or p_coverage->>'outcome' is not null
      and p_coverage->>'outcome' not in ('complete', 'partial', 'empty', 'failed')
    or octet_length(p_coverage::text) > 32768
    or p_coverage ? 'company' and (
      jsonb_typeof(p_coverage->'company') <> 'object'
      or jsonb_typeof(p_coverage->'company'->'surfaces') <> 'array'
      or jsonb_array_length(p_coverage->'company'->'surfaces') > 24
      or jsonb_typeof(p_coverage->'company'->'suppressedObservations') <> 'array'
      or jsonb_array_length(p_coverage->'company'->'suppressedObservations') > 100
      or coalesce(p_coverage->'company'->>'surfacesSelected','') !~ '^[0-3]$'
      or coalesce(p_coverage->'company'->>'surfacesScanned','') !~ '^[0-3]$'
    )
    or p_technology_observations is null
    or jsonb_typeof(p_technology_observations) <> 'array'
    or jsonb_array_length(p_technology_observations) > 250
    or octet_length(p_technology_observations::text) > 131072 then
    raise exception 'Discovery result is invalid' using errcode = '22023';
  end if;
  if p_status = 'failed' and (
    jsonb_array_length(p_evidence) <> 0 or jsonb_array_length(p_candidates) <> 0
    or jsonb_array_length(p_technology_observations) <> 0
  ) then
    raise exception 'Failed discovery cannot contain evidence or observations' using errcode = '22023';
  end if;

  select * into run_row
  from public.dependency_discovery_runs r
  where r.id = p_run_id and r.workspace_id = p_workspace_id and r.company_id = p_company_id
  for update;
  if not found or run_row.status <> 'running' then
    raise exception 'Discovery run is not writable' using errcode = 'P0002';
  end if;

  if p_status in ('completed', 'partial') then
    insert into public.dependency_discovery_evidence (
      workspace_id, run_id, provider_slug, signature_key, signal_type, strength,
      source_origin, surface_type, surface_host
    )
    select p_workspace_id, p_run_id, e.provider_slug, e.signature_key, e.signal_type,
      e.strength, e.source_origin, e.surface_type, e.surface_host
    from jsonb_to_recordset(p_evidence) as e(
      provider_slug text, signature_key text, signal_type text, strength text,
      source_origin text, surface_type text, surface_host text
    );

    insert into public.technology_observations (
      workspace_id, run_id, technology_slug, technology_name, category, fingerprint_id,
      registry_version, evidence_family, strength, relationship, protectability,
      status, disposition, suppression_reason, surface_type, surface_host, source_host
    )
    select p_workspace_id, p_run_id, o.technology_slug, o.technology_name, o.category,
      o.fingerprint_id, o.registry_version, o.evidence_family, o.strength, o.relationship,
      o.protectability, o.status, o.disposition, o.suppression_reason, o.surface_type,
      o.surface_host, o.source_host
    from jsonb_to_recordset(p_technology_observations) as o(
      technology_slug text, technology_name text, category text, fingerprint_id text,
      registry_version text, evidence_family text, strength text, relationship text,
      protectability text, status text, disposition text, suppression_reason text, surface_type text,
      surface_host text, source_host text
    );

    for candidate in
      select * from jsonb_to_recordset(p_candidates) as c(
        provider_slug text, confidence numeric, confidence_label text, evidence_summary jsonb
      )
    loop
      select d.id into dependency_id
      from public.dependency_catalog d
      where d.slug = candidate.provider_slug and d.enabled;
      if dependency_id is not null then
        perform public.upsert_discovered_dependency_candidate(
          p_workspace_id, p_company_id, dependency_id, candidate.confidence,
          candidate.confidence_label, candidate.evidence_summary
        );
      end if;
      dependency_id := null;
    end loop;
  end if;

  update public.dependency_discovery_runs
  set status = p_status,
      error_category = p_error_category,
      candidate_count = jsonb_array_length(p_candidates),
      evidence_count = jsonb_array_length(p_evidence),
      deep_pass_requested = p_deep_pass_requested,
      deep_scripts_fetched = p_deep_scripts_fetched,
      deep_bytes_fetched = p_deep_bytes_fetched,
      coverage = p_coverage,
      finished_at = now()
  where id = p_run_id;
end;
$$;

revoke all on function public.complete_url_dependency_discovery_run(
  uuid, uuid, uuid, text, text, boolean, integer, integer, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_url_dependency_discovery_run(
  uuid, uuid, uuid, text, text, boolean, integer, integer, jsonb, jsonb, jsonb, jsonb
) to service_role;
