create or replace function public.require_code_analysis_v2_reference_spans()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'completed' and new.analyzer_version = 'code-intelligence-v2'
    and exists (
      select 1 from public.code_external_references r
      where r.analysis_run_id = new.id
        and r.reference_type <> 'package'
        and (r.start_column is null or r.end_column is null)
    ) then
    raise exception 'Code analysis v2 external-reference provenance is incomplete'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.require_code_analysis_v2_reference_spans() from public, anon, authenticated;

drop trigger if exists code_analysis_v2_reference_spans on public.code_analysis_runs;
create trigger code_analysis_v2_reference_spans
  before update of status on public.code_analysis_runs
  for each row execute function public.require_code_analysis_v2_reference_spans();