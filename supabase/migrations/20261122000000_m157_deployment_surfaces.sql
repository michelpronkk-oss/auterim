-- M15.7: provider-neutral deployment surfaces and immutable deployment observations.
-- This migration creates no Product mappings or fabricated deployment evidence.

alter table public.connector_providers drop constraint if exists connector_providers_provider_check;
alter table public.connector_providers add constraint connector_providers_provider_check
  check (provider in ('github','slack','linear','sentry','vercel'));
alter table public.preflight_findings
  add constraint preflight_findings_id_workspace_key unique (id, workspace_id);

insert into public.connector_providers(provider, display_name)
values ('vercel', 'Vercel')
on conflict (provider) do nothing;

insert into public.connector_provider_capabilities(provider, capability)
values ('vercel', 'CAN_READ_DEPLOYMENT_CONTEXT')
on conflict (provider, capability) do nothing;

create table public.deployment_surfaces (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  installation_id uuid not null,
  provider text not null default 'vercel' check (provider = 'vercel'),
  external_project_id text not null check (octet_length(external_project_id) between 1 and 200),
  project_name text not null check (octet_length(project_name) between 1 and 100),
  environment_scope text not null check (environment_scope in ('production','preview','custom','all')),
  safe_metadata jsonb not null default '{}'::jsonb check (octet_length(safe_metadata::text) <= 1500),
  current_production_deployment_id text,
  last_successful_sync_at timestamptz,
  last_attempt_at timestamptz,
  last_attempt_status text check (last_attempt_status is null or last_attempt_status in ('succeeded','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (installation_id, workspace_id)
    references public.connector_installations(id, workspace_id) on delete cascade,
  unique (installation_id, external_project_id, environment_scope),
  unique (id, workspace_id)
);

create index deployment_surfaces_workspace_idx
  on public.deployment_surfaces(workspace_id, project_name, environment_scope);
create index deployment_surfaces_installation_idx
  on public.deployment_surfaces(workspace_id, installation_id, external_project_id);

alter table public.deployment_surfaces enable row level security;
revoke all on public.deployment_surfaces from public, anon;
grant select on public.deployment_surfaces to authenticated, service_role;
grant all on public.deployment_surfaces to service_role;
create policy deployment_surfaces_member_read
  on public.deployment_surfaces for select to authenticated
  using (exists (
    select 1 from public.workspace_members member
    where member.workspace_id = deployment_surfaces.workspace_id
      and member.user_id = (select auth.uid())
  ));

create table public.workspace_product_deployment_surfaces (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  protected_product_id uuid not null,
  deployment_surface_id uuid not null,
  repository_id uuid not null,
  provenance text not null check (provenance in ('protected_repository_identity','user_confirmed')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (protected_product_id, workspace_id)
    references public.workspace_products(id, workspace_id) on delete cascade,
  foreign key (deployment_surface_id, workspace_id)
    references public.deployment_surfaces(id, workspace_id) on delete cascade,
  foreign key (repository_id, workspace_id)
    references public.repositories(id, workspace_id) on delete cascade,
  unique (protected_product_id, deployment_surface_id)
);

create index workspace_product_deployment_surfaces_product_idx
  on public.workspace_product_deployment_surfaces(workspace_id, protected_product_id, deployment_surface_id);
create index workspace_product_deployment_surfaces_surface_idx
  on public.workspace_product_deployment_surfaces(workspace_id, deployment_surface_id);

alter table public.workspace_product_deployment_surfaces enable row level security;
revoke all on public.workspace_product_deployment_surfaces from public, anon;
grant select on public.workspace_product_deployment_surfaces to authenticated, service_role;
grant all on public.workspace_product_deployment_surfaces to service_role;
create policy workspace_product_deployment_surfaces_member_read
  on public.workspace_product_deployment_surfaces for select to authenticated
  using (exists (
    select 1 from public.workspace_members member
    where member.workspace_id = workspace_product_deployment_surfaces.workspace_id
      and member.user_id = (select auth.uid())
  ));

create table public.deployment_observations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  deployment_surface_id uuid not null,
  external_deployment_id text not null check (octet_length(external_deployment_id) between 1 and 200),
  environment_type text not null check (environment_type in ('production','preview','custom','unknown')),
  deployment_state text not null check (deployment_state in ('queued','building','ready','error','canceled','unknown')),
  commit_sha text check (commit_sha is null or commit_sha ~ '^[A-Fa-f0-9]{40,64}$'),
  source_repository_owner text check (source_repository_owner is null or octet_length(source_repository_owner) <= 100),
  source_repository_name text check (source_repository_name is null or octet_length(source_repository_name) <= 100),
  source_branch text check (source_branch is null or octet_length(source_branch) <= 255),
  deployment_url text check (
    deployment_url is null or (
      deployment_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~!$&''()*+,;=:@%/-]*)?$'
      and octet_length(deployment_url) <= 500
    )
  ),
  provider_created_at timestamptz,
  provider_ready_at timestamptz,
  observed_at timestamptz not null default now(),
  provenance text not null default 'vercel_rest_api' check (provenance = 'vercel_rest_api'),
  verification_state text not null check (verification_state in ('observed','mapped','commit_verified','production_verified','inconclusive','historical')),
  safe_metadata jsonb not null default '{}'::jsonb check (octet_length(safe_metadata::text) <= 1500),
  foreign key (deployment_surface_id, workspace_id)
    references public.deployment_surfaces(id, workspace_id) on delete cascade,
  unique (deployment_surface_id, external_deployment_id),
  unique (id, workspace_id)
);

create index deployment_observations_workspace_idx
  on public.deployment_observations(workspace_id, deployment_surface_id, observed_at desc, id desc);
create index deployment_observations_commit_idx
  on public.deployment_observations(workspace_id, commit_sha, environment_type, deployment_state);

alter table public.deployment_observations enable row level security;
revoke all on public.deployment_observations from public, anon;
grant select on public.deployment_observations to authenticated, service_role;
grant all on public.deployment_observations to service_role;
create policy deployment_observations_member_read
  on public.deployment_observations for select to authenticated
  using (exists (
    select 1 from public.workspace_members member
    where member.workspace_id = deployment_observations.workspace_id
      and member.user_id = (select auth.uid())
  ));

create table public.deployment_sync_attempts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  deployment_surface_id uuid not null,
  status text not null check (status in ('running','succeeded','failed')),
  error_category text check (error_category is null or error_category in ('auth_required','permission_missing','resource_missing','rate_limited','provider_unavailable','unknown_safe')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  observed_count integer not null default 0 check (observed_count between 0 and 100),
  foreign key (deployment_surface_id, workspace_id)
    references public.deployment_surfaces(id, workspace_id) on delete cascade,
  unique (id, workspace_id)
);
create index deployment_sync_attempts_surface_idx
  on public.deployment_sync_attempts(workspace_id, deployment_surface_id, started_at desc, id desc);
alter table public.deployment_sync_attempts enable row level security;
revoke all on public.deployment_sync_attempts from public, anon;
grant select on public.deployment_sync_attempts to authenticated, service_role;
grant all on public.deployment_sync_attempts to service_role;
create policy deployment_sync_attempts_member_read
  on public.deployment_sync_attempts for select to authenticated
  using (exists (
    select 1 from public.workspace_members member
    where member.workspace_id = deployment_sync_attempts.workspace_id
      and member.user_id = (select auth.uid())
  ));

-- Verification is Product-specific: one provider deployment may be associated with
-- multiple explicitly protected Products, each with independent repository evidence.
create table public.product_deployment_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  protected_product_id uuid not null,
  deployment_surface_id uuid not null,
  deployment_observation_id uuid not null,
  repository_id uuid not null,
  preflight_finding_id uuid,
  verification_state text not null check (verification_state in ('mapped','commit_verified','production_verified','inconclusive','historical')),
  verified_commit_sha text check (verified_commit_sha is null or verified_commit_sha ~ '^[A-Fa-f0-9]{40,64}$'),
  observed_at timestamptz not null default now(),
  safe_metadata jsonb not null default '{}'::jsonb check (octet_length(safe_metadata::text) <= 1000),
  foreign key (protected_product_id, workspace_id)
    references public.workspace_products(id, workspace_id) on delete cascade,
  foreign key (deployment_surface_id, workspace_id)
    references public.deployment_surfaces(id, workspace_id) on delete cascade,
  foreign key (deployment_observation_id, workspace_id)
    references public.deployment_observations(id, workspace_id) on delete cascade,
  foreign key (repository_id, workspace_id)
    references public.repositories(id, workspace_id) on delete cascade,
  foreign key (preflight_finding_id, workspace_id)
    references public.preflight_findings(id, workspace_id) on delete cascade,
  unique (protected_product_id, deployment_observation_id, repository_id)
);
create index product_deployment_evidence_product_recent_idx
  on public.product_deployment_evidence(workspace_id, protected_product_id, observed_at desc, id desc);
create index product_deployment_evidence_surface_idx
  on public.product_deployment_evidence(workspace_id, deployment_surface_id, protected_product_id);
alter table public.product_deployment_evidence enable row level security;
revoke all on public.product_deployment_evidence from public, anon;
grant select on public.product_deployment_evidence to authenticated, service_role;
grant all on public.product_deployment_evidence to service_role;
create policy product_deployment_evidence_member_read
  on public.product_deployment_evidence for select to authenticated
  using (exists (
    select 1 from public.workspace_members member
    where member.workspace_id = product_deployment_evidence.workspace_id
      and member.user_id = (select auth.uid())
  ));
