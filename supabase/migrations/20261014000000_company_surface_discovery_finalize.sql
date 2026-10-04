-- Company-surface RPC and coverage changes after discovery coverage prerequisites.
alter table public.dependency_discovery_runs
  drop constraint if exists dependency_discovery_runs_coverage_check,
  add constraint dependency_discovery_runs_coverage_check
    check (jsonb_typeof(coverage) = 'object' and octet_length(coverage::text) <= 32768);

alter table public.dependency_discovery_evidence
  drop constraint if exists dependency_discovery_evidence_surface_host_check,
  add constraint dependency_discovery_evidence_surface_host_check check (
    surface_host = lower(surface_host) and char_length(surface_host) between 1 and 253
    and surface_host !~ '[/@?#]'
    and (
      position(':' in surface_host) = 0
      or (
        surface_host like '[%' and surface_host like '%]'
        and family(substring(surface_host from 2 for char_length(surface_host) - 2)::inet) = 6
      )
    )
  );

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
  p_coverage jsonb default '{}'::jsonb
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
    ) then
    raise exception 'Discovery result is invalid' using errcode = '22023';
  end if;
  if p_status = 'failed' and (jsonb_array_length(p_evidence) <> 0 or jsonb_array_length(p_candidates) <> 0) then
    raise exception 'Failed discovery cannot contain evidence or candidates' using errcode = '22023';
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
  uuid, uuid, uuid, text, text, boolean, integer, integer, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_url_dependency_discovery_run(
  uuid, uuid, uuid, text, text, boolean, integer, integer, jsonb, jsonb, jsonb
) to service_role;

-- Keep internal surface hosts and suppression detail out of the customer onboarding response.
create or replace function public.get_onboarding_status_with_discovery_coverage(p_workspace_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_set(
    status.value,
    '{discovery,coverage}',
    (coalesce(latest.coverage, '{}'::jsonb) - 'company') || case
      when latest.coverage ? 'company' then jsonb_build_object(
        'company', jsonb_build_object(
          'surfacesObserved', latest.coverage #> '{company,surfacesObserved}',
          'surfacesSelected', latest.coverage #> '{company,surfacesSelected}',
          'surfacesScanned', latest.coverage #> '{company,surfacesScanned}',
          'providersSuggested', latest.coverage #> '{company,providersSuggested}',
          'providersSuppressed', latest.coverage #> '{company,providersSuppressed}'
        )
      )
      else '{}'::jsonb
    end,
    true
  )
  from lateral (select public.get_onboarding_status(p_workspace_id) as value) status
  left join lateral (
    select run.coverage
    from public.dependency_discovery_runs run
    where run.workspace_id = p_workspace_id
      and run.company_id = (status.value #>> '{company,id}')::uuid
    order by run.started_at desc, run.id desc
    limit 1
  ) latest on true
$$;

revoke all on function public.get_onboarding_status_with_discovery_coverage(uuid) from public, anon;
grant execute on function public.get_onboarding_status_with_discovery_coverage(uuid) to authenticated;
