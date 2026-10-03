-- Internal-only Search Console and first-party Growth Engine feedback data.
create table public.growth_search_console_oauth_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  browser_hash text not null check (browser_hash ~ '^[0-9a-f]{64}$'),
  verifier_ciphertext text not null,
  verifier_nonce text not null,
  verifier_authentication_tag text not null,
  verifier_key_version integer not null check (verifier_key_version > 0),
  actor_token_ciphertext text not null,
  actor_token_nonce text not null,
  actor_token_authentication_tag text not null,
  actor_token_key_version integer not null check (actor_token_key_version > 0),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index growth_search_console_oauth_expiry_idx
  on public.growth_search_console_oauth_states(expires_at) where consumed_at is null;
alter table public.growth_search_console_oauth_states enable row level security;
revoke all on public.growth_search_console_oauth_states from public,anon,authenticated;
grant all on public.growth_search_console_oauth_states to service_role;

create table public.growth_search_console_connection (
  id text primary key check (id = 'auterim'),
  property text not null check (property = 'sc-domain:auterim.com'),
  lifecycle_state text not null default 'disconnected'
    check (lifecycle_state in ('connected','degraded','reauth_required','revoked','disconnected')),
  health_state text not null default 'unknown'
    check (health_state in ('healthy','degraded','reauth_required','revoked','unknown')),
  scopes text[] not null default '{}',
  ciphertext text,
  nonce text,
  authentication_tag text,
  key_version integer,
  access_expires_at timestamptz,
  credential_version bigint not null default 1 check (credential_version > 0),
  connected_by uuid references auth.users(id) on delete set null,
  connected_at timestamptz,
  last_checked_at timestamptz,
  last_sync_at timestamptz,
  last_sync_status text not null default 'never'
    check (last_sync_status in ('never','complete','partial','failed')),
  last_error_category text,
  refresh_lease_token uuid,
  refresh_lease_until timestamptz,
  updated_at timestamptz not null default now(),
  check ((ciphertext is null and nonce is null and authentication_tag is null and key_version is null)
      or (ciphertext is not null and nonce is not null and authentication_tag is not null and key_version > 0)),
  check ((lifecycle_state in ('connected','degraded') and ciphertext is not null)
      or lifecycle_state in ('reauth_required','revoked','disconnected'))
);
alter table public.growth_search_console_connection enable row level security;
revoke all on public.growth_search_console_connection from public,anon,authenticated;
grant all on public.growth_search_console_connection to service_role;

create table public.growth_search_console_metrics (
  id bigint generated always as identity primary key,
  metric_key text not null unique check (metric_key ~ '^[0-9a-f]{64}$'),
  property text not null check (property = 'sc-domain:auterim.com'),
  metric_date date not null,
  query_fingerprint text not null check (query_fingerprint ~ '^[0-9a-f]{64}$'),
  query_fingerprint_key_version integer not null check (query_fingerprint_key_version > 0),
  query_topic_match boolean not null,
  page_url text not null check (char_length(page_url) <= 2048),
  clicks integer not null check (clicks >= 0),
  impressions integer not null check (impressions >= 0),
  ctr numeric(8,7) not null check (ctr >= 0 and ctr <= 1),
  average_position numeric(8,3) not null check (average_position >= 0),
  ingestion_version integer not null default 1 check (ingestion_version > 0),
  observed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(metric_date,query_fingerprint,query_fingerprint_key_version,page_url)
);
create index growth_search_metrics_date_idx on public.growth_search_console_metrics(metric_date desc);
create index growth_search_metrics_page_idx on public.growth_search_console_metrics(page_url,metric_date desc);
create index growth_search_metrics_query_idx on public.growth_search_console_metrics(query_fingerprint,query_fingerprint_key_version,metric_date desc);
alter table public.growth_search_console_metrics enable row level security;
revoke all on public.growth_search_console_metrics from public,anon,authenticated;
grant all on public.growth_search_console_metrics to service_role;

create table public.growth_first_party_events (
  event_id uuid primary key default gen_random_uuid(),
  event_key text unique check (event_key is null or event_key ~ '^[0-9a-f]{64}$'),
  event_type text not null check (event_type in (
    'homepage_view','stack_scan_started','stack_scan_completed','scan_result_continue',
    'signup_started','signup_completed','protection_activation','github_connect_started',
    'github_connected','trial_started','paid_conversion'
  )),
  event_source text not null check (event_source in ('browser','server')),
  occurred_at timestamptz not null default now(),
  utm_source text check (utm_source is null or char_length(utm_source) <= 100),
  utm_medium text check (utm_medium is null or char_length(utm_medium) <= 100),
  utm_campaign text check (utm_campaign is null or char_length(utm_campaign) <= 100),
  landing_path text check (landing_path is null or (char_length(landing_path) <= 160 and landing_path ~ '^/[a-zA-Z0-9/_-]*$')),
  attribution_confidence text not null default 'unknown'
    check (attribution_confidence in ('first_touch','last_touch','unknown')),
  created_at timestamptz not null default now()
);
create index growth_first_party_event_type_time_idx on public.growth_first_party_events(event_type,occurred_at desc);
alter table public.growth_first_party_events enable row level security;
revoke all on public.growth_first_party_events from public,anon,authenticated;
grant all on public.growth_first_party_events to service_role;

create table public.growth_public_event_ingest_buckets (
  bucket_start timestamptz primary key,
  request_count integer not null check (request_count between 1 and 120)
);
alter table public.growth_public_event_ingest_buckets enable row level security;
revoke all on public.growth_public_event_ingest_buckets from public,anon,authenticated;
grant all on public.growth_public_event_ingest_buckets to service_role;

create table public.growth_feedback_opportunities (
  id uuid primary key default gen_random_uuid(),
  opportunity_key text not null unique check (opportunity_key ~ '^[0-9a-f]{64}$'),
  opportunity_type text not null check (opportunity_type in (
    'high_impressions_low_ctr','near_page_one','query_gap','internal_link_opportunity','emerging_cluster','declining_cluster',
    'stale_high_value_page','strong_cluster','weak_conversion','strong_page_weak_conversion','lower_traffic_high_entry_rate','topic_whitespace',
    'distribution_candidate','conversion_attribution_gap'
  )),
  canonical_path text check (canonical_path is null or (char_length(canonical_path) <= 200 and canonical_path ~ '^/[a-zA-Z0-9/_-]*$')),
  topic_key text check (topic_key is null or char_length(topic_key) <= 120),
  status text not null default 'needs_review' check (status in ('needs_review','approved','rejected','stale')),
  evidence jsonb not null default '{}'::jsonb check (octet_length(evidence::text) <= 12000),
  rules_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index growth_feedback_opportunity_review_idx
  on public.growth_feedback_opportunities(status,created_at desc,id desc);
create index growth_feedback_opportunity_type_idx
  on public.growth_feedback_opportunities(opportunity_type,created_at desc);
alter table public.growth_feedback_opportunities enable row level security;
revoke all on public.growth_feedback_opportunities from public,anon,authenticated;
grant all on public.growth_feedback_opportunities to service_role;

create table public.growth_search_console_sync_runs (
  id uuid primary key default gen_random_uuid(),
  run_key text not null unique check (char_length(run_key) between 1 and 160),
  status text not null check (status in ('running','complete','partial','failed')),
  window_start date not null,
  window_end date not null,
  pages_requested integer not null default 0 check (pages_requested between 0 and 5),
  rows_received integer not null default 0 check (rows_received between 0 and 5000),
  rows_upserted integer not null default 0 check (rows_upserted between 0 and 5000),
  error_category text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  check (window_end >= window_start)
);
create index growth_search_sync_runs_started_idx on public.growth_search_console_sync_runs(started_at desc);
alter table public.growth_search_console_sync_runs add column lease_token uuid;
alter table public.growth_search_console_sync_runs add column lease_until timestamptz;
alter table public.growth_search_console_sync_runs enable row level security;
revoke all on public.growth_search_console_sync_runs from public,anon,authenticated;
grant all on public.growth_search_console_sync_runs to service_role;

create or replace function public.claim_growth_search_console_oauth_state(p_state_hash text,p_browser_hash text)
returns table(actor_user_id uuid,verifier_ciphertext text,verifier_nonce text,verifier_authentication_tag text,verifier_key_version integer,actor_token_ciphertext text,actor_token_nonce text,actor_token_authentication_tag text,actor_token_key_version integer)
language plpgsql security invoker set search_path = '' as $$
begin
  return query update public.growth_search_console_oauth_states state
    set consumed_at=now()
    where state.state_hash=p_state_hash and state.browser_hash=p_browser_hash
      and state.expires_at>now() and state.consumed_at is null
    returning state.actor_user_id,state.verifier_ciphertext,state.verifier_nonce,state.verifier_authentication_tag,state.verifier_key_version,state.actor_token_ciphertext,state.actor_token_nonce,state.actor_token_authentication_tag,state.actor_token_key_version;
end;
$$;
revoke all on function public.claim_growth_search_console_oauth_state(text,text) from public,anon,authenticated;
grant execute on function public.claim_growth_search_console_oauth_state(text,text) to service_role;

create or replace function public.persist_growth_search_console_connection(
  p_property text,p_ciphertext text,p_nonce text,p_authentication_tag text,p_key_version integer,
  p_scopes text[],p_actor_user_id uuid,p_access_expires_at timestamptz
) returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_property <> 'sc-domain:auterim.com' or not ('https://www.googleapis.com/auth/webmasters.readonly'=any(p_scopes)) then
    raise exception 'invalid_search_console_connection' using errcode='22023';
  end if;
  insert into public.growth_search_console_connection(id,property,lifecycle_state,health_state,scopes,ciphertext,nonce,authentication_tag,key_version,access_expires_at,credential_version,connected_by,connected_at,updated_at)
  values ('auterim',p_property,'connected','healthy',p_scopes,p_ciphertext,p_nonce,p_authentication_tag,p_key_version,p_access_expires_at,1,p_actor_user_id,now(),now())
  on conflict(id) do update set property=excluded.property,lifecycle_state='connected',health_state='healthy',scopes=excluded.scopes,
    ciphertext=excluded.ciphertext,nonce=excluded.nonce,authentication_tag=excluded.authentication_tag,key_version=excluded.key_version,
    access_expires_at=excluded.access_expires_at,credential_version=public.growth_search_console_connection.credential_version+1,
    connected_by=excluded.connected_by,connected_at=now(),last_error_category=null,updated_at=now();
end;
$$;
revoke all on function public.persist_growth_search_console_connection(text,text,text,text,integer,text[],uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.persist_growth_search_console_connection(text,text,text,text,integer,text[],uuid,timestamptz) to service_role;

create or replace function public.claim_growth_search_console_refresh(p_lease_token uuid)
returns table(lease_token uuid,ciphertext text,nonce text,authentication_tag text,key_version integer,credential_version bigint)
language plpgsql security invoker set search_path = '' as $$
begin
  return query update public.growth_search_console_connection connection
    set refresh_lease_token=p_lease_token,refresh_lease_until=now()+interval '60 seconds',updated_at=now()
    where connection.id='auterim' and connection.lifecycle_state in ('connected','degraded')
      and connection.access_expires_at<=now()+interval '90 seconds'
      and (connection.refresh_lease_until is null or connection.refresh_lease_until<now())
    returning p_lease_token,connection.ciphertext,connection.nonce,connection.authentication_tag,connection.key_version,connection.credential_version;
end;
$$;
revoke all on function public.claim_growth_search_console_refresh(uuid) from public,anon,authenticated;
grant execute on function public.claim_growth_search_console_refresh(uuid) to service_role;

create or replace function public.release_growth_search_console_refresh(p_lease_token uuid,p_health_state text,p_lifecycle_state text,p_error_category text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_count integer;
begin
  if p_health_state not in ('healthy','degraded','reauth_required','revoked','unknown') or p_lifecycle_state not in ('connected','degraded','reauth_required','revoked','disconnected') then
    raise exception 'invalid_search_console_health' using errcode='22023';
  end if;
  update public.growth_search_console_connection set refresh_lease_token=null,refresh_lease_until=null,
    health_state=p_health_state,lifecycle_state=p_lifecycle_state,last_error_category=p_error_category,updated_at=now()
    where id='auterim' and refresh_lease_token=p_lease_token;
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;
revoke all on function public.release_growth_search_console_refresh(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.release_growth_search_console_refresh(uuid,text,text,text) to service_role;

create or replace function public.claim_growth_search_console_sync(p_run_key text,p_window_start date,p_window_end date,p_lease_token uuid)
returns table(run_id uuid,acquired boolean,status text)
language plpgsql security invoker set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.growth_search_console_sync_runs(run_key,status,window_start,window_end,lease_token,lease_until)
    values(p_run_key,'running',p_window_start,p_window_end,p_lease_token,now()+interval '15 minutes')
    on conflict(run_key) do nothing;
  update public.growth_search_console_sync_runs run set status='running',window_start=p_window_start,window_end=p_window_end,
    pages_requested=0,rows_received=0,rows_upserted=0,error_category=null,started_at=now(),completed_at=null,
    lease_token=p_lease_token,lease_until=now()+interval '15 minutes'
    where run.run_key=p_run_key and run.status not in ('complete','partial')
      and (run.lease_until is null or run.lease_until<now());
  select run.id into v_id from public.growth_search_console_sync_runs run where run.run_key=p_run_key;
  return query select run.id,(run.lease_token=p_lease_token),run.status from public.growth_search_console_sync_runs run where run.id=v_id;
end;
$$;
revoke all on function public.claim_growth_search_console_sync(text,date,date,uuid) from public,anon,authenticated;
grant execute on function public.claim_growth_search_console_sync(text,date,date,uuid) to service_role;

create or replace function public.finish_growth_search_console_sync(
  p_run_id uuid,p_lease_token uuid,p_status text,p_pages_requested integer,p_rows_received integer,
  p_rows_upserted integer,p_error_category text,p_completed_at timestamptz
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_count integer;
begin
  if p_status not in ('complete','partial','failed') then
    raise exception 'invalid_growth_search_sync_status' using errcode='22023';
  end if;
  update public.growth_search_console_sync_runs set status=p_status,pages_requested=p_pages_requested,
    rows_received=p_rows_received,rows_upserted=p_rows_upserted,error_category=p_error_category,
    completed_at=p_completed_at,lease_token=null,lease_until=null
    where id=p_run_id and lease_token=p_lease_token and lease_until>now();
  get diagnostics v_count=row_count;
  if v_count <> 1 then return false; end if;
  if p_status in ('complete','partial') then
    update public.growth_search_console_connection set last_sync_at=p_completed_at,last_sync_status=p_status,
      last_checked_at=p_completed_at,health_state=case when p_status='partial' then 'degraded' else 'healthy' end,
      lifecycle_state=case when p_status='partial' then 'degraded' else 'connected' end,
      last_error_category=p_error_category,updated_at=p_completed_at where id='auterim';
  elsif p_error_category='reauth_required' then
    update public.growth_search_console_connection set last_sync_status='failed',last_checked_at=p_completed_at,
      lifecycle_state='reauth_required',health_state='reauth_required',last_error_category=p_error_category,
      updated_at=p_completed_at where id='auterim';
  else
    update public.growth_search_console_connection set last_sync_status='failed',last_checked_at=p_completed_at,
      lifecycle_state='degraded',health_state='degraded',last_error_category=p_error_category,
      updated_at=p_completed_at where id='auterim';
  end if;
  return true;
end;
$$;
revoke all on function public.finish_growth_search_console_sync(uuid,uuid,text,integer,integer,integer,text,timestamptz) from public,anon,authenticated;
grant execute on function public.finish_growth_search_console_sync(uuid,uuid,text,integer,integer,integer,text,timestamptz) to service_role;

create or replace function public.claim_growth_public_conversion_event()
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_count integer;
begin
  insert into public.growth_public_event_ingest_buckets as current_bucket(bucket_start,request_count)
    values(date_trunc('minute',now()),1)
    on conflict(bucket_start) do update set request_count=current_bucket.request_count+1
      where current_bucket.request_count<120
    returning request_count into v_count;
  return v_count is not null;
end;
$$;
revoke all on function public.claim_growth_public_conversion_event() from public,anon,authenticated;
grant execute on function public.claim_growth_public_conversion_event() to service_role;

create or replace function public.record_growth_feedback_candidate(p_payload jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_id uuid;
begin
  if coalesce(p_payload->>'opportunity_key','') !~ '^[0-9a-f]{64}$'
    or p_payload->>'opportunity_type' not in ('high_impressions_low_ctr','near_page_one','query_gap','internal_link_opportunity','emerging_cluster','declining_cluster','stale_high_value_page','strong_cluster','weak_conversion','strong_page_weak_conversion','lower_traffic_high_entry_rate','topic_whitespace','distribution_candidate','conversion_attribution_gap')
    or coalesce(p_payload->>'rules_version','') !~ '^[a-z0-9-]{1,80}$'
    or octet_length(coalesce(p_payload->'evidence','{}'::jsonb)::text)>12000 then
    raise exception 'invalid_growth_feedback_candidate' using errcode='22023';
  end if;
  insert into public.growth_feedback_opportunities(opportunity_key,opportunity_type,canonical_path,topic_key,status,evidence,rules_version)
    values(p_payload->>'opportunity_key',p_payload->>'opportunity_type',nullif(p_payload->>'canonical_path',''),nullif(p_payload->>'topic_key',''),'needs_review',coalesce(p_payload->'evidence','{}'::jsonb),p_payload->>'rules_version')
    on conflict(opportunity_key) do update set evidence=excluded.evidence,rules_version=excluded.rules_version,updated_at=now(),
      status=case when growth_feedback_opportunities.status in ('approved','rejected') then growth_feedback_opportunities.status else 'needs_review' end
    returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.record_growth_feedback_candidate(jsonb) from public,anon,authenticated;
grant execute on function public.record_growth_feedback_candidate(jsonb) to service_role;
