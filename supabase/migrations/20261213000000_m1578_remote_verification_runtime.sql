-- Private, bounded artifact transport for the dedicated M15.78 verification runner.
-- No authenticated/anonymous storage policies are created; only the trusted
-- server-side Storage client can upload, read, sign, or purge these objects.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'fix-engine-verification-artifacts',
  'fix-engine-verification-artifacts',
  false,
  536870912,
  array['application/gzip', 'application/json', 'application/octet-stream']
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
