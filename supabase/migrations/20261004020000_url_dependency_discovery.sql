-- Auterim Milestone 5: public URL evidence produces suggested candidates only.

create table public.dependency_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  company_id uuid not null,
  website_url text not null check (website_url ~ '^https?://[^/?#]+(/[^?#]*)?$'),
  trigger_run_id text not null check (char_length(trigger_run_id) between 1 and 255),
  attempt_number integer not null check (attempt_number between 1 and 100),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  error_category text check (error_category is null or char_length(error_category) <= 80),
  candidate_count integer check (candidate_count is null or candidate_count between 0 and 100),
  evidence_count integer check (evidence_count is null or evidence_count between 0 and 500),
  deep_pass_requested boolean not null default false,
  deep_scripts_fetched integer check (deep_scripts_fetched is null or deep_scripts_fetched between 0 and 4),
  deep_bytes_fetched integer check (deep_bytes_fetched is null or deep_bytes_fetched between 0 and 393216),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint dependency_discovery_runs_company_workspace_fkey
    foreign key (company_id, workspace_id)
    references public.companies (id, workspace_id) on delete cascade,
  constraint dependency_discovery_runs_trigger_attempt_key unique (trigger_run_id, attempt_number),
  constraint dependency_discovery_runs_id_workspace_key unique (id, workspace_id),
  constraint dependency_discovery_runs_finished_check check (
    (status = 'running' and finished_at is null) or
    (status <> 'running' and finished_at is not null)
  )
);

create index dependency_discovery_runs_company_idx
  on public.dependency_discovery_runs (company_id, started_at desc);

create table public.dependency_discovery_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  run_id uuid not null,
  provider_slug text not null references public.dependency_catalog (slug) on delete restrict,
  signature_key text not null check (signature_key ~ '^[a-z0-9-]{1,100}$'),
  signal_type text not null check (signal_type in (
    'response_header', 'script_host', 'script_path', 'document_host', 'embedded_url', 'markup_marker'
  )),
  strength text not null check (strength in ('strong', 'medium', 'weak')),
  source_origin text not null check (source_origin ~ '^https?://[^/?#]+$'),
  created_at timestamptz not null default now(),
  constraint dependency_discovery_evidence_run_workspace_fkey
    foreign key (run_id, workspace_id)
    references public.dependency_discovery_runs (id, workspace_id) on delete cascade,
  constraint dependency_discovery_evidence_run_signal_key
    unique (run_id, provider_slug, signature_key, source_origin)
);

create index dependency_discovery_evidence_workspace_idx
  on public.dependency_discovery_evidence (workspace_id, run_id);

create table public.discovered_dependencies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  company_id uuid not null,
  dependency_id uuid not null references public.dependency_catalog (id) on delete restrict,
  status text not null default 'candidate' check (status in ('candidate', 'confirmed', 'rejected')),
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  confidence_label text not null check (confidence_label in ('low', 'medium', 'high')),
  evidence_summary jsonb not null default '[]'::jsonb check (
    jsonb_typeof(evidence_summary) = 'array' and jsonb_array_length(evidence_summary) <= 50
    and octet_length(evidence_summary::text) <= 8192
  ),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discovered_dependencies_company_workspace_fkey
    foreign key (company_id, workspace_id)
    references public.companies (id, workspace_id) on delete cascade,
  constraint discovered_dependencies_company_provider_key unique (company_id, dependency_id)
);

create index discovered_dependencies_workspace_status_idx
  on public.discovered_dependencies (workspace_id, status, last_seen_at desc);

create trigger discovered_dependencies_set_updated_at
  before update on public.discovered_dependencies
  for each row execute function private.set_updated_at();

alter table public.dependency_discovery_runs enable row level security;
alter table public.dependency_discovery_evidence enable row level security;
alter table public.discovered_dependencies enable row level security;

revoke all on public.dependency_discovery_runs, public.dependency_discovery_evidence,
  public.discovered_dependencies from public, anon, authenticated;
grant select on public.dependency_discovery_runs, public.dependency_discovery_evidence,
  public.discovered_dependencies to authenticated;
grant all on public.dependency_discovery_runs, public.dependency_discovery_evidence,
  public.discovered_dependencies to service_role;

create policy dependency_discovery_runs_select_member on public.dependency_discovery_runs
  for select to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member'])));
create policy dependency_discovery_evidence_select_member on public.dependency_discovery_evidence
  for select to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member'])));
create policy discovered_dependencies_select_member on public.discovered_dependencies
  for select to authenticated
  using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member'])));

create function public.upsert_discovered_dependency_candidate(
  p_workspace_id uuid,
  p_company_id uuid,
  p_dependency_id uuid,
  p_confidence numeric,
  p_confidence_label text,
  p_evidence_summary jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  result_id uuid;
begin
  if p_confidence is null or p_confidence < 0 or p_confidence > 1
    or p_confidence_label not in ('low', 'medium', 'high')
    or p_evidence_summary is null or jsonb_typeof(p_evidence_summary) <> 'array'
    or jsonb_array_length(p_evidence_summary) > 50
    or octet_length(p_evidence_summary::text) > 8192 then
    raise exception 'Discovery candidate is invalid' using errcode = '22023';
  end if;

  insert into public.discovered_dependencies (
    workspace_id, company_id, dependency_id, confidence, confidence_label, evidence_summary
  ) values (
    p_workspace_id, p_company_id, p_dependency_id, p_confidence, p_confidence_label, p_evidence_summary
  ) on conflict (company_id, dependency_id) do update set
    confidence = excluded.confidence,
    confidence_label = excluded.confidence_label,
    evidence_summary = excluded.evidence_summary,
    last_seen_at = now()
  where public.discovered_dependencies.status = 'candidate'
    and public.discovered_dependencies.workspace_id = excluded.workspace_id
  returning id into result_id;

  if result_id is null then
    select d.id into result_id
    from public.discovered_dependencies d
    where d.company_id = p_company_id
      and d.dependency_id = p_dependency_id
      and d.workspace_id = p_workspace_id;
  end if;
  return result_id;
end;
$$;

revoke all on function public.upsert_discovered_dependency_candidate(uuid, uuid, uuid, numeric, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_discovered_dependency_candidate(uuid, uuid, uuid, numeric, text, jsonb)
  to service_role;

create function public.complete_url_dependency_discovery_run(
  p_run_id uuid,
  p_workspace_id uuid,
  p_company_id uuid,
  p_status text,
  p_error_category text,
  p_deep_pass_requested boolean,
  p_deep_scripts_fetched integer,
  p_deep_bytes_fetched integer,
  p_evidence jsonb,
  p_candidates jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  run_row public.dependency_discovery_runs%rowtype;
  candidate record;
  dependency_id uuid;
begin
  if p_status not in ('completed', 'failed')
    or p_error_category is not null and p_error_category !~ '^[a-z_]{1,80}$'
    or p_deep_pass_requested is null
    or p_deep_scripts_fetched is null or p_deep_scripts_fetched not between 0 and 4
    or p_deep_bytes_fetched is null or p_deep_bytes_fetched not between 0 and 393216
    or p_evidence is null or jsonb_typeof(p_evidence) <> 'array'
    or jsonb_array_length(p_evidence) > 500 or octet_length(p_evidence::text) > 262144
    or p_candidates is null or jsonb_typeof(p_candidates) <> 'array'
    or jsonb_array_length(p_candidates) > 100 or octet_length(p_candidates::text) > 65536 then
    raise exception 'Discovery result is invalid' using errcode = '22023';
  end if;
  if p_status = 'failed' and (jsonb_array_length(p_evidence) <> 0 or jsonb_array_length(p_candidates) <> 0) then
    raise exception 'Failed discovery cannot contain evidence or candidates' using errcode = '22023';
  end if;

  select * into run_row
  from public.dependency_discovery_runs r
  where r.id = p_run_id and r.workspace_id = p_workspace_id and r.company_id = p_company_id
  for update;
  if not found or run_row.status <> 'running' then
    raise exception 'Discovery run is not writable' using errcode = 'P0002';
  end if;

  if p_status = 'completed' then
    insert into public.dependency_discovery_evidence (
      workspace_id, run_id, provider_slug, signature_key, signal_type, strength, source_origin
    )
    select
      p_workspace_id, p_run_id, e.provider_slug, e.signature_key, e.signal_type, e.strength, e.source_origin
    from jsonb_to_recordset(p_evidence) as e(
      provider_slug text, signature_key text, signal_type text, strength text, source_origin text
    );

    for candidate in
      select * from jsonb_to_recordset(p_candidates) as c(
        provider_slug text, confidence numeric, confidence_label text, evidence_summary jsonb
      )
    loop
      select d.id into dependency_id
      from public.dependency_catalog d
      where d.slug = candidate.provider_slug and d.enabled;
      if dependency_id is not null then
        perform public.upsert_discovered_dependency_candidate(
          p_workspace_id,
          p_company_id,
          dependency_id,
          candidate.confidence,
          candidate.confidence_label,
          candidate.evidence_summary
        );
      end if;
      dependency_id := null;
    end loop;
  end if;

  update public.dependency_discovery_runs
  set status = p_status,
      error_category = p_error_category,
      candidate_count = jsonb_array_length(p_candidates),
      evidence_count = jsonb_array_length(p_evidence),
      deep_pass_requested = p_deep_pass_requested,
      deep_scripts_fetched = p_deep_scripts_fetched,
      deep_bytes_fetched = p_deep_bytes_fetched,
      finished_at = now()
  where id = p_run_id;
end;
$$;

revoke all on function public.complete_url_dependency_discovery_run(
  uuid, uuid, uuid, text, text, boolean, integer, integer, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_url_dependency_discovery_run(
  uuid, uuid, uuid, text, text, boolean, integer, integer, jsonb, jsonb
) to service_role;

create function public.fail_url_dependency_discovery_run(
  p_run_id uuid,
  p_workspace_id uuid,
  p_error_category text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_error_category is null or p_error_category !~ '^[a-z_]{1,80}$' then
    raise exception 'Discovery failure category is invalid' using errcode = '22023';
  end if;
  update public.dependency_discovery_runs
  set status = 'failed', error_category = p_error_category, finished_at = now()
  where id = p_run_id and workspace_id = p_workspace_id and status = 'running';
end;
$$;

revoke all on function public.fail_url_dependency_discovery_run(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fail_url_dependency_discovery_run(uuid, uuid, text)
  to service_role;

insert into public.dependency_catalog (slug, name, category, website_url, metadata)
values
  ('vercel', 'Vercel', 'infrastructure', 'https://vercel.com', '{"kind":"service"}'::jsonb),
  ('cloudflare', 'Cloudflare', 'infrastructure', 'https://cloudflare.com', '{"kind":"service"}'::jsonb),
  ('netlify', 'Netlify', 'infrastructure', 'https://netlify.com', '{"kind":"service"}'::jsonb),
  ('aws', 'Amazon Web Services', 'infrastructure', 'https://aws.amazon.com', '{"kind":"service"}'::jsonb),
  ('supabase', 'Supabase', 'infrastructure', 'https://supabase.com', '{"kind":"service"}'::jsonb),
  ('firebase', 'Firebase', 'infrastructure', 'https://firebase.google.com', '{"kind":"service"}'::jsonb),
  ('stripe', 'Stripe', 'payments', 'https://stripe.com', '{"kind":"service"}'::jsonb),
  ('clerk', 'Clerk', 'other', 'https://clerk.com', '{"kind":"service"}'::jsonb),
  ('auth0', 'Auth0', 'other', 'https://auth0.com', '{"kind":"service"}'::jsonb),
  ('sentry', 'Sentry', 'developer-tools', 'https://sentry.io', '{"kind":"service"}'::jsonb),
  ('posthog', 'PostHog', 'developer-tools', 'https://posthog.com', '{"kind":"service"}'::jsonb),
  ('segment', 'Segment', 'developer-tools', 'https://segment.com', '{"kind":"service"}'::jsonb),
  ('intercom', 'Intercom', 'communications', 'https://intercom.com', '{"kind":"service"}'::jsonb),
  ('algolia', 'Algolia', 'developer-tools', 'https://algolia.com', '{"kind":"service"}'::jsonb),
  ('shopify', 'Shopify', 'other', 'https://shopify.com', '{"kind":"service"}'::jsonb)
on conflict (slug) do nothing;
