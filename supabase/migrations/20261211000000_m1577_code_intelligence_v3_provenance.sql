create or replace function public.require_code_analysis_v3_provenance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'completed' or new.analyzer_version <> 'code-intelligence-v3' then
    return new;
  end if;

  if exists (
    select 1
    from public.code_relations relation
    where relation.analysis_run_id = new.id
      and (relation.evidence_path is null
        or relation.evidence_start_line is null
        or relation.evidence_end_line is null
        or relation.evidence_start_column is null
        or relation.evidence_end_column is null
        or relation.extractor_type is null)
  ) then
    raise exception 'Code analysis v3 relation provenance is incomplete'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.code_external_references reference
    where reference.analysis_run_id = new.id
      and reference.reference_type <> 'package'
      and (reference.start_column is null or reference.end_column is null)
  ) then
    raise exception 'Code analysis v3 external-reference provenance is incomplete'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.require_code_analysis_v3_provenance()
  from public, anon, authenticated;

drop trigger if exists code_analysis_v3_provenance on public.code_analysis_runs;
create trigger code_analysis_v3_provenance
  before update of status on public.code_analysis_runs
  for each row execute function public.require_code_analysis_v3_provenance();
