-- Extend only the internal technology-observation vocabulary. Existing rows retain their
-- original values; no source bodies, cookies, or runtime DOM data are added.
alter table public.technology_observations
  drop constraint if exists technology_observations_category_check,
  add constraint technology_observations_category_check check (category in (
    'framework', 'library', 'build_tool', 'hosting', 'monitoring', 'analytics', 'payments',
    'identity', 'database', 'search', 'messaging', 'ai', 'other_service',
    'ui_framework', 'css_framework', 'hosting_infrastructure', 'cdn', 'auth',
    'observability', 'customer_messaging', 'ai_api', 'email', 'storage', 'queue',
    'dev_platform', 'advertising', 'captcha', 'cms', 'other_external_service', 'unknown'
  )),
  drop constraint if exists technology_observations_evidence_family_check,
  add constraint technology_observations_evidence_family_check check (evidence_family in (
    'response_header', 'html_structure', 'script_asset', 'stylesheet_asset',
    'javascript_bundle', 'runtime_network', 'public_config', 'cookie_name', 'html_marker',
    'meta_marker', 'script_url', 'asset_path', 'css_bundle', 'csp_host', 'runtime_global',
    'runtime_dom', 'runtime_script_host', 'runtime_api_host', 'runtime_fetch_host',
    'derived_tech_relationship'
  )),
  drop constraint if exists technology_observations_strength_check,
  add constraint technology_observations_strength_check check (strength in ('strong', 'medium', 'weak', 'derived')),
  drop constraint if exists technology_observations_relationship_check,
  add constraint technology_observations_relationship_check check (relationship in (
    'framework_for', 'built_with', 'hosted_on', 'optional_integration', 'provides_service',
    'unknown', 'derived_from'
  )),
  drop constraint if exists technology_observations_suppression_reason_check,
  add constraint technology_observations_suppression_reason_check check (
    suppression_reason is null or suppression_reason in (
      'framework', 'library', 'build_tool', 'marketing_only', 'weak_evidence',
      'optional_integration', 'non_protectable', 'SUPPRESSED_NON_PROTECTABLE', 'FRAMEWORK',
      'LIBRARY', 'BUILD_TOOL', 'MARKETING_ONLY', 'GENERIC_CDN', 'WEAK_EVIDENCE',
      'CORRELATED_EVIDENCE', 'OPTIONAL_INTEGRATION', 'INTEGRATION_DIRECTORY',
      'UNSUPPORTED_PROVIDER', 'DERIVED_ONLY', 'CONFLICTED_EVIDENCE'
    )
  );
