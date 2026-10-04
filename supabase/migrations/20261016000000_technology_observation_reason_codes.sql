alter table public.technology_observations
  drop constraint if exists technology_observations_suppression_reason_check,
  add constraint technology_observations_suppression_reason_check check (
    suppression_reason is null or suppression_reason in (
      'SUPPRESSED_NON_PROTECTABLE', 'FRAMEWORK', 'LIBRARY', 'BUILD_TOOL', 'MARKETING_ONLY',
      'GENERIC_CDN', 'WEAK_EVIDENCE', 'CORRELATED_EVIDENCE', 'OPTIONAL_INTEGRATION',
      'INTEGRATION_DIRECTORY', 'UNSUPPORTED_PROVIDER', 'DERIVED_ONLY', 'CONFLICTED_EVIDENCE'
    )
  );
