-- Recreating the claim routine changed its return type and reset PostgreSQL's default EXECUTE grant.
revoke all on function public.claim_preflight_run(uuid) from public, anon, authenticated;
grant execute on function public.claim_preflight_run(uuid) to service_role;
