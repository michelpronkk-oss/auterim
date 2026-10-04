-- Surface evidence storage only. Coverage and RPC changes run after their dependencies
-- in 20261014000000_company_surface_discovery_finalize.sql.
alter table public.dependency_discovery_evidence
  add column surface_type text not null default 'ROOT_MARKETING',
  add column surface_host text not null default 'unknown.invalid',
  drop constraint dependency_discovery_evidence_run_signal_key,
  add constraint dependency_discovery_evidence_surface_type_check check (surface_type in (
    'ROOT_MARKETING', 'PRODUCT_APP', 'AUTH_APP', 'DASHBOARD', 'CUSTOMER_PORTAL',
    'FIRST_PARTY_API', 'DOCS', 'BLOG', 'STATUS', 'SUPPORT', 'INTEGRATION_DIRECTORY', 'UNKNOWN'
  )),
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

update public.dependency_discovery_evidence
set surface_host = regexp_replace(source_origin, '^https?://(\[[^]]+\]|[^/:]+).*$','\1')
where surface_host = 'unknown.invalid';

alter table public.dependency_discovery_evidence
  add constraint dependency_discovery_evidence_surface_origin_host_check check (
    surface_host = lower(
      case
        when left(split_part(source_origin, '://', 2), 1) = '[' then
          split_part(split_part(source_origin, '://', 2), ']', 1) || ']'
        else split_part(split_part(source_origin, '://', 2), ':', 1)
      end
    )
  );

alter table public.dependency_discovery_evidence
  add constraint dependency_discovery_evidence_run_signal_key
    unique (run_id, provider_slug, signature_key, source_origin, surface_type, surface_host);

create index dependency_discovery_evidence_surface_idx
  on public.dependency_discovery_evidence (run_id, surface_type, surface_host);
