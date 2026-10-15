alter table public.code_analysis_runs
  add column if not exists supported_files_discovered integer not null default 0 check (supported_files_discovered >= 0),
  add column if not exists supported_files_analyzed integer not null default 0 check (supported_files_analyzed >= 0),
  add column if not exists supported_files_skipped_by_bound integer not null default 0 check (supported_files_skipped_by_bound >= 0),
  add column if not exists unsupported_language_files integer not null default 0 check (unsupported_language_files >= 0),
  add column if not exists persisted_entity_count integer not null default 0 check (persisted_entity_count >= 0),
  add column if not exists persisted_relation_count integer not null default 0 check (persisted_relation_count >= 0),
  add column if not exists persisted_reference_count integer not null default 0 check (persisted_reference_count >= 0),
  add column if not exists persisted_skip_count integer not null default 0 check (persisted_skip_count >= 0),
  add column if not exists coverage_reason_counts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(coverage_reason_counts) = 'object');

alter table public.code_relations
  add column if not exists evidence_path text,
  add column if not exists evidence_start_line integer,
  add column if not exists evidence_end_line integer,
  add column if not exists extractor_type text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'code_relations_evidence_span_check'
    and conrelid = 'public.code_relations'::regclass) then
    alter table public.code_relations add constraint code_relations_evidence_span_check check (
    (evidence_path is null and evidence_start_line is null and evidence_end_line is null and extractor_type is null)
    or
    (evidence_path is not null and char_length(evidence_path) between 1 and 1024
      and evidence_start_line is not null and evidence_start_line > 0
      and evidence_end_line is not null and evidence_end_line >= evidence_start_line
      and extractor_type is not null and char_length(extractor_type) between 1 and 80)
    );
  end if;
end $$;

create or replace function public.complete_code_analysis_run_v2(
  p_analysis_run_id uuid,
  p_claim_token uuid,
  p_coverage_state text,
  p_files_discovered integer,
  p_files_analyzed integer,
  p_files_skipped integer,
  p_parse_failures integer,
  p_bytes_analyzed bigint,
  p_supported_files_discovered integer,
  p_supported_files_analyzed integer,
  p_supported_files_skipped_by_bound integer,
  p_unsupported_language_files integer,
  p_coverage_reason_counts jsonb,
  p_persisted_entity_count integer,
  p_persisted_relation_count integer,
  p_persisted_reference_count integer,
  p_persisted_skip_count integer
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  item record;
  actual_entities integer;
  actual_relations integer;
  actual_references integer;
  actual_skips integer;
begin
  if p_coverage_state not in ('complete','partial','unsupported','failed')
    or least(p_files_discovered,p_files_analyzed,p_files_skipped,p_parse_failures,p_bytes_analyzed,
      p_supported_files_discovered,p_supported_files_analyzed,p_supported_files_skipped_by_bound,
      p_unsupported_language_files,p_persisted_entity_count,p_persisted_relation_count,
      p_persisted_reference_count,p_persisted_skip_count) < 0
    or p_files_analyzed > p_files_discovered
    or p_files_skipped > p_files_discovered
    or p_supported_files_analyzed > p_supported_files_discovered
    or p_supported_files_skipped_by_bound > p_supported_files_discovered
    or p_coverage_reason_counts is null
    or jsonb_typeof(p_coverage_reason_counts) <> 'object' then
    raise exception 'Code analysis result is invalid' using errcode='22023';
  end if;
  for item in select key, value from jsonb_each(p_coverage_reason_counts) loop
    if item.key !~ '^[a-z0-9_:-]{1,80}$'
      or jsonb_typeof(item.value) <> 'number'
      or (item.value #>> '{}') !~ '^[0-9]{1,9}$' then
      raise exception 'Code analysis coverage reason counts are invalid' using errcode='22023';
    end if;
  end loop;
  select count(*) into actual_entities from public.code_entities where analysis_run_id=p_analysis_run_id;
  select count(*) into actual_relations from public.code_relations where analysis_run_id=p_analysis_run_id;
  select count(*) into actual_references from public.code_external_references where analysis_run_id=p_analysis_run_id;
  select count(*) into actual_skips from public.code_analysis_skipped_files where analysis_run_id=p_analysis_run_id;
  if actual_entities <> p_persisted_entity_count
    or actual_relations <> p_persisted_relation_count
    or actual_references <> p_persisted_reference_count
    or actual_skips <> p_persisted_skip_count then
    raise exception 'Code analysis persisted fact counts do not match' using errcode='23514';
  end if;
  update public.code_analysis_runs set status='completed',coverage_state=p_coverage_state,
    files_discovered=p_files_discovered,files_analyzed=p_files_analyzed,files_skipped=p_files_skipped,
    parse_failures=p_parse_failures,bytes_analyzed=p_bytes_analyzed,
    supported_files_discovered=p_supported_files_discovered,
    supported_files_analyzed=p_supported_files_analyzed,
    supported_files_skipped_by_bound=p_supported_files_skipped_by_bound,
    unsupported_language_files=p_unsupported_language_files,
    persisted_entity_count=p_persisted_entity_count,
    persisted_relation_count=p_persisted_relation_count,
    persisted_reference_count=p_persisted_reference_count,
    persisted_skip_count=p_persisted_skip_count,
    coverage_reason_counts=p_coverage_reason_counts,
    completed_at=now(),claim_token=null,lease_expires_at=null,failure_category=null
  where id=p_analysis_run_id and status='running' and claim_token=p_claim_token;
  if not found then return exists(select 1 from public.code_analysis_runs where id=p_analysis_run_id and status='completed'); end if;
  update public.code_analysis_route_handoffs set status='completed',completed_at=now()
    where analysis_run_id=p_analysis_run_id and status='queued';
  return true;
end;
$$;

revoke all on function public.complete_code_analysis_run_v2(
  uuid,uuid,text,integer,integer,integer,integer,bigint,integer,integer,integer,integer,jsonb,integer,integer,integer,integer
) from public,anon,authenticated;
grant execute on function public.complete_code_analysis_run_v2(
  uuid,uuid,text,integer,integer,integer,integer,bigint,integer,integer,integer,integer,jsonb,integer,integer,integer,integer
) to service_role;
