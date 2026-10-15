alter table public.code_external_references
  add column if not exists start_column integer,
  add column if not exists end_column integer;

do $$ begin
  if exists (select 1 from pg_constraint where conname = 'code_external_references_source_columns_check'
    and conrelid = 'public.code_external_references'::regclass) then
    alter table public.code_external_references drop constraint code_external_references_source_columns_check;
  end if;
  alter table public.code_external_references add constraint code_external_references_source_columns_check check (
    (start_column is null and end_column is null)
    or (start_column > 0 and end_column > 0
      and (end_line > start_line or end_column >= start_column))
  );
end $$;