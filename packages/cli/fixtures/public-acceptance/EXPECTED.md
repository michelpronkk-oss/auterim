# Public CLI acceptance fixture

This synthetic fixture contains no credentials or customer data. The expected offline discovery is:

- Providers: Supabase and Stripe.
- Seven observations: three each for Stripe and Supabase, across `package_manifest`, `import_reference`, and `environment_variable_name`; one providerless `framework_runtime` observation.
- Source files uploaded: none.
- Network requests during `connect --dry-run`: zero.
- Product scope: the submitted observations are associated with the explicitly selected Test Product. Discovery remains unconfirmed and must not create protected dependency or repository intent.
