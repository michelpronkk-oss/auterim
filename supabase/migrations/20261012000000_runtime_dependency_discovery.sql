-- Record bounded browser-network observations as distinct public discovery evidence families.
alter table public.dependency_discovery_evidence
  drop constraint dependency_discovery_evidence_signal_type_check;

alter table public.dependency_discovery_evidence
  add constraint dependency_discovery_evidence_signal_type_check
  check (signal_type in (
    'response_header',
    'script_host',
    'script_path',
    'document_host',
    'embedded_url',
    'markup_marker',
    'resource_host',
    'csp_host',
    'api_endpoint',
    'js_sdk',
    'redirect_host',
    'runtime_host',
    'runtime_script_host',
    'runtime_api_host'
  ));
