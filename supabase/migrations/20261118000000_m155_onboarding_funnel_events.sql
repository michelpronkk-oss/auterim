alter table public.growth_first_party_events
  drop constraint growth_first_party_events_event_type_check,
  add constraint growth_first_party_events_event_type_check
    check (event_type in (
      'homepage_view','stack_scan_started','stack_scan_completed','scan_result_continue',
      'signup_started','signup_completed','protection_activation','github_connect_started',
      'github_connected','trial_started','paid_conversion','product_selected',
      'dependency_confirmed','protection_graph_viewed','first_grounded_value'
    ));
