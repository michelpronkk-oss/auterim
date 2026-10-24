-- M15.79 (4a/7): append-only Production exposure assessments.
-- One row records whether one impact-graph build's analysed code runs in Production on one of
-- the Product's deployment surfaces. The outcome is computed here from current rows by the same
-- rule as assessExposure() in src/lib/coverage-certification; the issuing RPC accepts a claim
-- only when it equals that outcome for the exact evidence and sync attempt it cites. Existing
-- impact_graph_builds and fix_runs rows are not changed: their exposure stays 'unknown'.
--
-- "What runs in Production" is the evidence row for the surface's current Production
-- deployment (deployment_surfaces.current_production_deployment_id, written by every sync),
-- never the most recently observed row: one sync writes every observed deployment, previews
-- included, with the same observed_at.

-- Composite keys so assessments can bind their sync attempt to the surface and their
-- evidence row to the workspace, Product, surface and repository. Both are additive.
alter table public.deployment_sync_attempts
  add constraint deployment_sync_attempts_id_surface_key unique (id, workspace_id, deployment_surface_id);
alter table public.product_deployment_evidence
  add constraint product_deployment_evidence_id_scope_key
    unique (id, workspace_id, protected_product_id, deployment_surface_id, repository_id);

create table public.impact_exposure_assessments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  graph_build_id uuid not null,
  source_change_id uuid not null,
  product_id uuid not null,
  repository_id uuid not null,
  analysis_commit_sha text not null check (analysis_commit_sha ~ '^[a-f0-9]{40,64}$'),
  deployment_surface_id uuid not null,
  product_deployment_evidence_id uuid,
  deployment_sync_attempt_id uuid,
  deployed_commit_sha text check (deployed_commit_sha is null or deployed_commit_sha ~ '^[A-Fa-f0-9]{40,64}$'),
  exposure_state text not null check (exposure_state in ('proven','disproven','unknown')),
  reason text not null check (reason in (
    'deployed_commit_contains_impacted_code','complete_negative_analysis_at_deployed_commit',
    'deployment_not_production_verified','analysis_commit_not_deployed','graph_evidence_incomplete'
  )),
  contract_version text not null check (contract_version = 'exposure-v1'),
  sequence integer not null check (sequence > 0),
  supersedes_assessment_id uuid,
  assessed_at timestamptz not null default now(),
  valid_until timestamptz,
  constraint impact_exposure_graph_scope_fkey
    foreign key (graph_build_id, source_change_id, product_id, repository_id, analysis_commit_sha)
    references public.impact_graph_builds(id, source_change_id, product_id, repository_id, commit_sha)
    on delete cascade,
  constraint impact_exposure_graph_workspace_fkey
    foreign key (graph_build_id, workspace_id)
    references public.impact_graph_builds(id, workspace_id) on delete cascade,
  constraint impact_exposure_product_fkey
    foreign key (product_id, workspace_id)
    references public.workspace_products(id, workspace_id) on delete cascade,
  constraint impact_exposure_surface_fkey
    foreign key (deployment_surface_id, workspace_id)
    references public.deployment_surfaces(id, workspace_id) on delete cascade,
  constraint impact_exposure_sync_fkey
    foreign key (deployment_sync_attempt_id, workspace_id, deployment_surface_id)
    references public.deployment_sync_attempts(id, workspace_id, deployment_surface_id) on delete cascade,
  constraint impact_exposure_evidence_fkey
    foreign key (product_deployment_evidence_id, workspace_id, product_id, deployment_surface_id, repository_id)
    references public.product_deployment_evidence(id, workspace_id, protected_product_id, deployment_surface_id, repository_id)
    on delete cascade,
  constraint impact_exposure_id_workspace_key unique (id, workspace_id),
  constraint impact_exposure_supersedes_fkey
    foreign key (supersedes_assessment_id, workspace_id)
    references public.impact_exposure_assessments(id, workspace_id),
  constraint impact_exposure_sequence_key unique (graph_build_id, deployment_surface_id, sequence),
  constraint impact_exposure_supersedes_order
    check ((sequence = 1) = (supersedes_assessment_id is null)),
  -- Each state has exactly its own reasons.
  constraint impact_exposure_state_reason check (
    (exposure_state = 'proven' and reason = 'deployed_commit_contains_impacted_code')
    or (exposure_state = 'disproven' and reason = 'complete_negative_analysis_at_deployed_commit')
    or (exposure_state = 'unknown' and reason in (
      'deployment_not_production_verified','analysis_commit_not_deployed','graph_evidence_incomplete'))
  ),
  -- A definite state always names its evidence, the analysed commit and an expiry.
  constraint impact_exposure_definite_evidence check (
    exposure_state = 'unknown'
    or (product_deployment_evidence_id is not null and deployment_sync_attempt_id is not null
        and lower(deployed_commit_sha) = analysis_commit_sha and valid_until is not null)
  ),
  constraint impact_exposure_unknown_no_expiry check (exposure_state <> 'unknown' or valid_until is null)
);
create index impact_exposure_assessments_latest_idx
  on public.impact_exposure_assessments(workspace_id, graph_build_id, deployment_surface_id, sequence desc);
create index impact_exposure_assessments_product_idx
  on public.impact_exposure_assessments(workspace_id, product_id, assessed_at desc);

create function private.reject_impact_exposure_mutation()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'impact_exposure_assessment_immutable' using errcode = '23514';
end;
$$;
revoke all on function private.reject_impact_exposure_mutation() from public, anon, authenticated;
create trigger impact_exposure_assessments_immutable
  before update or delete on public.impact_exposure_assessments
  for each row execute function private.reject_impact_exposure_mutation();

alter table public.impact_exposure_assessments enable row level security;
revoke all on public.impact_exposure_assessments from public, anon, authenticated, service_role;
grant select on public.impact_exposure_assessments to authenticated, service_role;
create policy impact_exposure_assessments_member_read
  on public.impact_exposure_assessments for select to authenticated
  using (exists (
    select 1 from public.workspace_members member
    where member.workspace_id = impact_exposure_assessments.workspace_id
      and member.user_id = (select auth.uid())
  ));

-- Mirrors assessExposure(evaluateDeploymentExposure(...)) in evaluate.ts; a test compares both
-- over every input combination. Returns {state, reason}.
create function private.impact_exposure_outcome(
  p_graph_status text,
  p_assessment_state text,
  p_analysis_profile text,
  p_coverage_state text,
  p_analysis_commit_sha text,
  p_evidence_state text,
  p_verified_commit_sha text,
  p_sync_status text,
  p_sync_completed_at timestamptz,
  p_now timestamptz
)
returns text[] language sql immutable set search_path = '' as $$
  select case
    when p_sync_status is distinct from 'succeeded' or p_sync_completed_at is null
      or p_sync_completed_at + interval '24 hours' <= p_now
      or p_evidence_state is distinct from 'production_verified' or p_verified_commit_sha is null
      then array['unknown','deployment_not_production_verified']
    when lower(p_verified_commit_sha) <> lower(p_analysis_commit_sha)
      then array['unknown','analysis_commit_not_deployed']
    when p_graph_status = 'completed' and p_assessment_state = 'evidence_present'
      then array['proven','deployed_commit_contains_impacted_code']
    when p_graph_status = 'completed' and p_assessment_state = 'absence_observed'
      and p_analysis_profile = 'javascript-typescript-v2.3' and p_coverage_state = 'complete'
      then array['disproven','complete_negative_analysis_at_deployed_commit']
    else array['unknown','graph_evidence_incomplete']
  end
$$;
revoke all on function private.impact_exposure_outcome(text, text, text, text, text, text, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;

create function public.issue_impact_exposure_assessment(
  p_workspace_id uuid,
  p_graph_build_id uuid,
  p_deployment_surface_id uuid,
  p_product_deployment_evidence_id uuid,
  p_deployment_sync_attempt_id uuid,
  p_exposure_state text,
  p_reason text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_graph public.impact_graph_builds%rowtype;
  v_evidence public.product_deployment_evidence%rowtype;
  v_sync public.deployment_sync_attempts%rowtype;
  v_latest public.impact_exposure_assessments%rowtype;
  v_outcome text[];
  v_id uuid;
  v_sequence integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  select * into v_graph from public.impact_graph_builds g
  where g.id = p_graph_build_id and g.workspace_id = p_workspace_id;
  if not found then
    raise exception 'impact_exposure_graph_invalid' using errcode = '42501';
  end if;
  -- The surface must be linked to the graph's Product for the graph's repository.
  if not exists (
      select 1 from public.workspace_product_deployment_surfaces l
      where l.workspace_id = p_workspace_id and l.protected_product_id = v_graph.product_id
        and l.deployment_surface_id = p_deployment_surface_id
        and l.repository_id = v_graph.repository_id) then
    raise exception 'impact_exposure_surface_invalid' using errcode = '42501';
  end if;

  -- One assessment per graph build and surface at a time.
  perform pg_advisory_xact_lock(
    hashtextextended(p_graph_build_id::text || ':' || p_deployment_surface_id::text, 0));

  -- What runs now: the evidence for the surface's current Production deployment and this
  -- graph's repository (at most one row), and the latest finished sync.
  select e.* into v_evidence
  from public.deployment_surfaces s
  join public.deployment_observations o
    on o.workspace_id = s.workspace_id and o.deployment_surface_id = s.id
   and o.external_deployment_id = s.current_production_deployment_id
  join public.product_deployment_evidence e
    on e.deployment_observation_id = o.id and e.workspace_id = s.workspace_id
   and e.protected_product_id = v_graph.product_id and e.deployment_surface_id = s.id
   and e.repository_id = v_graph.repository_id
  where s.id = p_deployment_surface_id and s.workspace_id = p_workspace_id;
  select * into v_sync from public.deployment_sync_attempts a
  where a.workspace_id = p_workspace_id and a.deployment_surface_id = p_deployment_surface_id
    and a.status in ('succeeded','failed') and a.completed_at is not null
  order by a.completed_at desc, a.id desc limit 1;

  v_outcome := private.impact_exposure_outcome(
    v_graph.status, v_graph.assessment_state, v_graph.analysis_profile, v_graph.coverage_state,
    v_graph.commit_sha, v_evidence.verification_state, v_evidence.verified_commit_sha,
    v_sync.status, v_sync.completed_at, now());
  -- The caller's claim must be exactly the outcome for exactly the rows it cites.
  if p_product_deployment_evidence_id is distinct from v_evidence.id
    or p_deployment_sync_attempt_id is distinct from v_sync.id
    or p_exposure_state is distinct from v_outcome[1]
    or p_reason is distinct from v_outcome[2] then
    raise exception 'impact_exposure_assessment_mismatch' using errcode = '22023';
  end if;

  select * into v_latest from public.impact_exposure_assessments x
  where x.workspace_id = p_workspace_id and x.graph_build_id = p_graph_build_id
    and x.deployment_surface_id = p_deployment_surface_id
  order by x.sequence desc limit 1;
  if found
    and v_latest.exposure_state = v_outcome[1] and v_latest.reason = v_outcome[2]
    and v_latest.product_deployment_evidence_id is not distinct from v_evidence.id
    and v_latest.deployment_sync_attempt_id is not distinct from v_sync.id then
    return jsonb_build_object('status', 'unchanged', 'assessmentId', v_latest.id,
      'sequence', v_latest.sequence, 'exposureState', v_latest.exposure_state);
  end if;
  v_sequence := coalesce(v_latest.sequence, 0) + 1;

  insert into public.impact_exposure_assessments (
    workspace_id, graph_build_id, source_change_id, product_id, repository_id, analysis_commit_sha,
    deployment_surface_id, product_deployment_evidence_id, deployment_sync_attempt_id,
    deployed_commit_sha, exposure_state, reason, contract_version, sequence,
    supersedes_assessment_id, valid_until
  ) values (
    p_workspace_id, v_graph.id, v_graph.source_change_id, v_graph.product_id, v_graph.repository_id,
    v_graph.commit_sha, p_deployment_surface_id, v_evidence.id, v_sync.id,
    v_evidence.verified_commit_sha, v_outcome[1], v_outcome[2], 'exposure-v1', v_sequence,
    v_latest.id,
    case when v_outcome[1] in ('proven','disproven') then v_sync.completed_at + interval '24 hours' end
  ) returning id into v_id;

  return jsonb_build_object('status', 'issued', 'assessmentId', v_id,
    'sequence', v_sequence, 'exposureState', v_outcome[1]);
end;
$$;
revoke all on function public.issue_impact_exposure_assessment(uuid, uuid, uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.issue_impact_exposure_assessment(uuid, uuid, uuid, uuid, uuid, text, text)
  to service_role;
