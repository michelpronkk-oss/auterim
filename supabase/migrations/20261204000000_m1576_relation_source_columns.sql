alter table public.code_relations
  add column if not exists evidence_start_column integer,
  add column if not exists evidence_end_column integer;

do $$ begin
  if exists (select 1 from pg_constraint where conname = 'code_relations_evidence_columns_check'
    and conrelid = 'public.code_relations'::regclass) then
    alter table public.code_relations drop constraint code_relations_evidence_columns_check;
  end if;
  alter table public.code_relations add constraint code_relations_evidence_columns_check check (
    (evidence_start_column is null and evidence_end_column is null)
    or (evidence_start_column > 0 and evidence_end_column > 0
      and (evidence_end_line > evidence_start_line or evidence_end_column >= evidence_start_column))
  );
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
  unprovenanced_v2_relations integer;
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
  select count(*) into unprovenanced_v2_relations
  from public.code_relations r
  join public.code_analysis_runs a on a.id=r.analysis_run_id
  where r.analysis_run_id=p_analysis_run_id
    and a.analyzer_version='code-intelligence-v2'
    and (r.evidence_path is null or r.evidence_start_line is null
      or r.evidence_end_line is null or r.evidence_start_column is null
      or r.evidence_end_column is null or r.extractor_type is null);
  if actual_entities <> p_persisted_entity_count
    or actual_relations <> p_persisted_relation_count
    or actual_references <> p_persisted_reference_count
    or actual_skips <> p_persisted_skip_count
    or unprovenanced_v2_relations <> 0 then
    raise exception 'Code analysis persisted counts or v2 relation provenance do not match' using errcode='23514';
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
