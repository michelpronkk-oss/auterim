-- M15.7 security correction: inherited Supabase table grants can include TRUNCATE,
-- which bypasses RLS. Keep authenticated access read-only on deployment evidence.
revoke all privileges on table
  public.deployment_surfaces,
  public.workspace_product_deployment_surfaces,
  public.deployment_observations,
  public.deployment_sync_attempts,
  public.product_deployment_evidence
from public, anon, authenticated;

grant select on table
  public.deployment_surfaces,
  public.workspace_product_deployment_surfaces,
  public.deployment_observations,
  public.deployment_sync_attempts,
  public.product_deployment_evidence
to authenticated;

grant all privileges on table
  public.deployment_surfaces,
  public.workspace_product_deployment_surfaces,
  public.deployment_observations,
  public.deployment_sync_attempts,
  public.product_deployment_evidence
to service_role;