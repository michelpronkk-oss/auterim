-- Add durable, bounded runner admission correlation and successful signed-result identity.
-- Existing workers keep calling the original diagnostic RPC; this release adds a v2
-- entry point without changing its signature. No runner requests are dispatched here.
alter table public.fix_verification_runs
  add column runner_job_id text,
  add column runner_request_fingerprint text,
  add column runner_result_fingerprint text,
  add column runner_protocol text,
  add column runner_version text,
  add column runner_image text,
  add column runner_result_signature_validated boolean;

alter table public.fix_verification_runs
  add constraint fix_verification_runner_evidence_consistent check (
    (
      runner_job_id is null
      and runner_request_fingerprint is null
      and runner_result_fingerprint is null
      and runner_protocol is null
      and runner_version is null
      and runner_image is null
      and runner_result_signature_validated is null
    )
    or (
      runner_job_id is not null
      and runner_request_fingerprint is not null
      and runner_result_fingerprint is not null
      and runner_protocol is not null
      and runner_version is not null
      and runner_image is not null
      and runner_result_signature_validated is not null
      and runner_job_id ~ '^[a-f0-9]{64}$'
      and runner_request_fingerprint ~ '^[a-f0-9]{64}$'
      and runner_result_fingerprint ~ '^[a-f0-9]{64}$'
      and runner_protocol = 'm1578-verification-runner-v1'
      and runner_version = 'm1578-runner-v1'
      and runner_image = 'node:24.8.0-alpine3.22@sha256:3e843c608bb5232f39ecb2b25e41214b958b0795914707374c8acc28487dea17'
      and runner_result_signature_validated is true
    )
  );

alter table public.fix_stage_runner_diagnostic_events
  add column job_id text,
  add column request_fingerprint text,
  add column admission_state text;

alter table public.fix_stage_runner_diagnostic_events
  drop constraint fix_stage_runner_diagnostic_events_failure_category_check,
  add constraint fix_stage_runner_diagnostic_events_failure_category_check check (
    failure_category in (
      'runner_request_invalid', 'runner_unavailable', 'runner_queue_full',
      'runner_state_temporarily_unavailable', 'runner_transport_ambiguous',
      'runner_poll_timeout', 'runner_timeout_when_execution_may_continue',
      'runner_auth_failed', 'runner_protocol_unsupported', 'runner_result_invalid',
      'snapshot_identity_mismatch', 'patch_identity_mismatch', 'cache_identity_mismatch',
      'cache_signature_invalid', 'cache_tree_invalid', 'verification_unsupported',
      'verification_failed'
    )
  ),
  add constraint fix_stage_runner_diagnostic_correlation_check check (
    (
      job_id is null and request_fingerprint is null and admission_state is null
    )
    or (
      admission_state is not null
      and admission_state in ('not_sent', 'unconfirmed', 'rejected', 'accepted')
      and ((job_id is null) = (request_fingerprint is null))
      and (job_id is null or job_id ~ '^[a-f0-9]{64}$')
      and (request_fingerprint is null or request_fingerprint ~ '^[a-f0-9]{64}$')
      and (admission_state <> 'accepted' or job_id is not null)
    )
  );
create or replace function public.complete_fix_stage_with_runner_diagnostics(
  p_stage_id uuid,
  p_claim_token uuid,
  p_result text,
  p_failure_category text,
  p_retryable boolean,
  p_diagnostics jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_stage public.fix_stage_queue%rowtype;
  v_run public.fix_runs%rowtype;
  v_event public.fix_stage_runner_diagnostic_events%rowtype;
  v_item jsonb;
  v_transition jsonb;
  v_expected_retryable boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_result not in ('failed', 'retry')
    or p_failure_category is null
    or p_failure_category not in (
      'runner_unavailable', 'runner_queue_full', 'runner_state_temporarily_unavailable',
      'runner_transport_ambiguous', 'runner_poll_timeout', 'runner_timeout_when_execution_may_continue',
      'runner_request_invalid', 'runner_auth_failed', 'runner_protocol_unsupported', 'runner_result_invalid',
      'snapshot_identity_mismatch', 'patch_identity_mismatch', 'cache_identity_mismatch',
      'cache_signature_invalid', 'cache_tree_invalid', 'verification_unsupported', 'verification_failed'
    ) then
    raise exception 'invalid_fix_runner_diagnostic_event' using errcode = '22023';
  end if;
  if jsonb_typeof(p_diagnostics) is distinct from 'array' then
    raise exception 'invalid_fix_runner_diagnostic_event' using errcode = '22023';
  end if;
  if jsonb_array_length(p_diagnostics) > 4 or octet_length(p_diagnostics::text) > 4096 then
    raise exception 'invalid_fix_runner_diagnostic_event' using errcode = '22023';
  end if;

  v_expected_retryable := p_failure_category in (
    'runner_unavailable', 'runner_queue_full', 'runner_state_temporarily_unavailable',
    'runner_transport_ambiguous', 'runner_poll_timeout', 'runner_timeout_when_execution_may_continue'
  );
  if p_retryable is distinct from v_expected_retryable
    or p_result is distinct from (case when v_expected_retryable then 'retry' else 'failed' end) then
    raise exception 'fix_runner_diagnostic_retry_mismatch' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_diagnostics) as x(value) loop
    if jsonb_typeof(v_item) <> 'object'
      or (v_item - array['phase','httpStatus','responseCategory','reason','identityField']) <> '{}'::jsonb
      or not (v_item ?& array['phase','httpStatus','responseCategory','reason'])
      or jsonb_typeof(v_item->'phase') <> 'string'
      or v_item->>'phase' not in ('admission','poll','resubmission','result_validation','result_signature','response_decode')
      or jsonb_typeof(v_item->'httpStatus') not in ('null','number')
      or (jsonb_typeof(v_item->'httpStatus') = 'number' and (v_item->>'httpStatus') !~ '^[0-9]{3}$')
      or (jsonb_typeof(v_item->'httpStatus') = 'number' and (v_item->>'httpStatus')::integer not between 100 and 599)
      or jsonb_typeof(v_item->'responseCategory') not in ('null','string')
      or (jsonb_typeof(v_item->'responseCategory') = 'string' and v_item->>'responseCategory' not in (
        'unrecognized','runner_request_invalid','runner_authentication_failed','runner_protocol_unsupported',
        'verification_job_invalid','verification_job_identity_invalid','verification_job_identity_mismatch',
        'verification_request_fingerprint_mismatch','verification_runner_capability_expired',
        'verification_runner_image_mismatch','verification_command_identity_mismatch',
        'verification_patch_identity_mismatch','verification_cache_artifact_mismatch',
        'verification_cache_identity_mismatch','verification_cache_signature_invalid',
        'verification_artifact_url_invalid','verification_artifact_origin_invalid','verification_artifact_size_limit',
        'verification_artifact_unavailable','verification_artifact_read_failed','verification_artifact_fingerprint_mismatch',
        'verification_snapshot_artifact_path_invalid','verification_patch_artifact_path_invalid',
        'verification_cache_artifact_path_invalid','verification_snapshot_symlink_forbidden',
        'verification_snapshot_special_file_forbidden','verification_snapshot_empty','verification_snapshot_secret_detected',
        'verification_cache_symlink_forbidden','verification_cache_special_file_forbidden',
        'verification_cache_tree_invalid','verification_cache_tree_fingerprint_mismatch',
        'verification_cache_tree_file_count_mismatch','verification_cache_tree_byte_count_mismatch',
        'verification_patch_unsafe','verification_patch_secret_detected','verification_patch_outside_plan',
        'verification_patch_conflict','verification_job_id_conflict','verification_runner_state_corrupt',
        'verification_runner_state_unavailable','verification_runner_queue_full','verification_runner_job_store_full',
        'verification_command_unsupported','verification_command_failed','verification_runner_execution_failed',
        'verification_runner_cleanup_failed','verification_job_not_found','runner_route_not_found'
      ))
      or jsonb_typeof(v_item->'reason') <> 'string'
      or v_item->>'reason' not in (
        'http_error','request_schema_invalid','request_capability_expired','accepted_identity_mismatch','response_body_invalid','response_body_too_large',
        'response_body_unavailable','result_schema_invalid','result_identity_mismatch',
        'result_fingerprint_mismatch','result_signature_missing','result_signature_mismatch','transport_ambiguous'
      )
      or (v_item ? 'identityField' and (
        jsonb_typeof(v_item->'identityField') <> 'string'
        or v_item->>'identityField' not in (
          'jobId','requestFingerprint','workspaceId','productId','repositoryId','repositoryIdentity',
          'baseCommitSha','patchId','snapshotFingerprint','patchFingerprint','cacheIdentityKey',
          'cacheTreeSha256','runtimeImage','profileId','profileVersion'
        )
      )) then
      raise exception 'invalid_fix_runner_diagnostic_payload' using errcode = '22023';
    end if;
  end loop;

  select * into v_stage from public.fix_stage_queue q
  where q.id = p_stage_id and q.stage = 'verify_patch' and q.status = 'claimed'
    and q.claim_token = p_claim_token and q.lease_expires_at > now()
  for update;
  if not found then raise exception 'fix_stage_claim_lost' using errcode = '40001'; end if;
  select * into v_run from public.fix_runs r
  where r.id = v_stage.fix_run_id and r.workspace_id = v_stage.workspace_id;
  if not found then raise exception 'fix_run_not_found' using errcode = 'P0002'; end if;

  select * into v_event from public.fix_stage_runner_diagnostic_events e
  where e.stage_id = v_stage.id and e.claim_token = p_claim_token;
  if found then
    if v_event.fix_run_id <> v_run.id or v_event.workspace_id <> v_run.workspace_id
      or v_event.attempt_number <> v_stage.attempt_count or v_event.failure_category <> p_failure_category
      or v_event.retryable <> p_retryable or v_event.diagnostics <> p_diagnostics then
      raise exception 'fix_runner_diagnostic_replay_conflict' using errcode = '23505';
    end if;
  else
    insert into public.fix_stage_runner_diagnostic_events (
      fix_run_id, workspace_id, stage_id, claim_token, attempt_number,
      failure_category, retryable, diagnostics
    ) values (
      v_run.id, v_run.workspace_id, v_stage.id, p_claim_token, v_stage.attempt_count,
      p_failure_category, p_retryable, p_diagnostics
    ) returning * into v_event;
  end if;

  v_transition := public.complete_fix_stage(p_stage_id, p_claim_token, p_result, p_failure_category);
  return jsonb_build_object(
    'status', 'recorded',
    'diagnosticEventId', v_event.id,
    'attemptNumber', v_event.attempt_number,
    'transition', v_transition
  );
end;
$$;
create function public.complete_fix_stage_with_runner_diagnostics_v2(
  p_stage_id uuid,
  p_claim_token uuid,
  p_result text,
  p_failure_category text,
  p_retryable boolean,
  p_diagnostics jsonb,
  p_correlation jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_previous text;
  v_result jsonb;
  v_event public.fix_stage_runner_diagnostic_events%rowtype;
  v_job_id text;
  v_request_fingerprint text;
  v_admission_state text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_correlation) is distinct from 'object'
    or (p_correlation - array['jobId','requestFingerprint','admissionState']) <> '{}'::jsonb
    or not (p_correlation ?& array['jobId','requestFingerprint','admissionState'])
    or jsonb_typeof(p_correlation->'admissionState') <> 'string'
    or p_correlation->>'admissionState' not in ('not_sent','unconfirmed','rejected','accepted')
    or jsonb_typeof(p_correlation->'jobId') not in ('null','string')
    or jsonb_typeof(p_correlation->'requestFingerprint') not in ('null','string')
    or (p_correlation->>'jobId' is not null and p_correlation->>'jobId' !~ '^[a-f0-9]{64}$')
    or (p_correlation->>'requestFingerprint' is not null and p_correlation->>'requestFingerprint' !~ '^[a-f0-9]{64}$')
    or ((p_correlation->>'jobId' is null) <> (p_correlation->>'requestFingerprint' is null))
    or (p_correlation->>'admissionState' = 'accepted' and p_correlation->>'jobId' is null)
  then
    raise exception 'invalid_fix_runner_correlation' using errcode = '22023';
  end if;

  v_previous := current_setting('auterim.runner_diagnostic_correlation', true);
  v_job_id := p_correlation->>'jobId';
  v_request_fingerprint := p_correlation->>'requestFingerprint';
  v_admission_state := p_correlation->>'admissionState';
  perform set_config('auterim.runner_diagnostic_correlation', p_correlation::text, true);
  v_result := public.complete_fix_stage_with_runner_diagnostics(
    p_stage_id, p_claim_token, p_result, p_failure_category, p_retryable, p_diagnostics
  );
  perform set_config('auterim.runner_diagnostic_correlation', coalesce(v_previous, ''), true);

  select * into v_event
  from public.fix_stage_runner_diagnostic_events e
  where e.id = (v_result->>'diagnosticEventId')::uuid
  for update;
  if not found
    or v_event.job_id is distinct from v_job_id
    or v_event.request_fingerprint is distinct from v_request_fingerprint
    or v_event.admission_state is distinct from v_admission_state
  then
    raise exception 'fix_runner_correlation_replay_conflict' using errcode = '23505';
  end if;
  return v_result;
exception when others then
  perform set_config('auterim.runner_diagnostic_correlation', coalesce(v_previous, ''), true);
  raise;
end;
$$;

revoke all on function public.complete_fix_stage_with_runner_diagnostics_v2(uuid,uuid,text,text,boolean,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_fix_stage_with_runner_diagnostics_v2(uuid,uuid,text,text,boolean,jsonb,jsonb)
  to service_role;

create function private.populate_fix_runner_diagnostic_correlation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_value text;
  v_correlation jsonb;
begin
  v_value := nullif(current_setting('auterim.runner_diagnostic_correlation', true), '');
  if v_value is null then return new; end if;
  begin
    v_correlation := v_value::jsonb;
  exception when others then
    raise exception 'invalid_fix_runner_correlation' using errcode = '22023';
  end;
  if jsonb_typeof(v_correlation) is distinct from 'object'
    or (v_correlation - array['jobId','requestFingerprint','admissionState']) <> '{}'::jsonb
    or not (v_correlation ?& array['jobId','requestFingerprint','admissionState'])
    or jsonb_typeof(v_correlation->'admissionState') <> 'string'
    or v_correlation->>'admissionState' not in ('not_sent','unconfirmed','rejected','accepted')
    or jsonb_typeof(v_correlation->'jobId') not in ('null','string')
    or jsonb_typeof(v_correlation->'requestFingerprint') not in ('null','string')
    or ((v_correlation->>'jobId' is null) <> (v_correlation->>'requestFingerprint' is null))
    or (v_correlation->>'jobId' is not null and v_correlation->>'jobId' !~ '^[a-f0-9]{64}$')
    or (v_correlation->>'requestFingerprint' is not null and v_correlation->>'requestFingerprint' !~ '^[a-f0-9]{64}$')
    or (v_correlation->>'admissionState' = 'accepted' and v_correlation->>'jobId' is null)
  then
    raise exception 'invalid_fix_runner_correlation' using errcode = '22023';
  end if;
  new.job_id := v_correlation->>'jobId';
  new.request_fingerprint := v_correlation->>'requestFingerprint';
  new.admission_state := v_correlation->>'admissionState';
  return new;
end;
$$;
revoke all on function private.populate_fix_runner_diagnostic_correlation() from public, anon, authenticated, service_role;
create trigger fix_runner_diagnostic_correlation_before_insert
  before insert on public.fix_stage_runner_diagnostic_events
  for each row execute function private.populate_fix_runner_diagnostic_correlation();

create function public.record_fix_verification_runner_result(
  p_fix_run_id uuid,
  p_stage_id uuid,
  p_claim_token uuid,
  p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb;
  v_id uuid;
  v_run public.fix_verification_runs%rowtype;
  v_runner jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object'
    or (p_payload - array['patchId','patchFingerprint','profileId','status','checks','diagnosticSummary','durationMs','attemptNumber','runnerEvidence']) <> '{}'::jsonb
  then
    raise exception 'invalid_fix_verification_payload' using errcode = '22023';
  end if;
  v_runner := p_payload->'runnerEvidence';
  if jsonb_typeof(v_runner) is distinct from 'object'
    or (v_runner - array['jobId','requestFingerprint','resultFingerprint','protocolVersion','runnerVersion','runtimeImage','resultSignatureValidated']) <> '{}'::jsonb
    or not (v_runner ?& array['jobId','requestFingerprint','resultFingerprint','protocolVersion','runnerVersion','runtimeImage','resultSignatureValidated'])
    or jsonb_typeof(v_runner->'jobId') <> 'string'
    or jsonb_typeof(v_runner->'requestFingerprint') <> 'string'
    or jsonb_typeof(v_runner->'resultFingerprint') <> 'string'
    or jsonb_typeof(v_runner->'protocolVersion') <> 'string'
    or jsonb_typeof(v_runner->'runnerVersion') <> 'string'
    or jsonb_typeof(v_runner->'runtimeImage') <> 'string'
    or jsonb_typeof(v_runner->'resultSignatureValidated') <> 'boolean'
    or v_runner->>'resultSignatureValidated' <> 'true'
    or jsonb_typeof(v_runner->'jobId') <> 'string'
    or v_runner->>'jobId' !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(v_runner->'requestFingerprint') <> 'string'
    or v_runner->>'requestFingerprint' !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(v_runner->'resultFingerprint') <> 'string'
    or v_runner->>'resultFingerprint' !~ '^[a-f0-9]{64}$'
    or v_runner->>'protocolVersion' <> 'm1578-verification-runner-v1'
    or v_runner->>'runnerVersion' <> 'm1578-runner-v1'
    or v_runner->>'runtimeImage' <> 'node:24.8.0-alpine3.22@sha256:3e843c608bb5232f39ecb2b25e41214b958b0795914707374c8acc28487dea17'
  then
    raise exception 'invalid_fix_verification_runner_evidence' using errcode = '22023';
  end if;
  if (p_payload->>'status') not in ('passed','failed')
    or p_payload->>'patchFingerprint' !~ '^[a-f0-9]{64}$'
    or (p_payload->>'attemptNumber')::integer not between 1 and 3
  then
    raise exception 'invalid_fix_verification_payload' using errcode = '22023';
  end if;

  v_result := public.record_fix_stage_artifact(
    p_fix_run_id, p_stage_id, p_claim_token, 'verification', p_payload - 'runnerEvidence'
  );
  v_id := (v_result->>'recordId')::uuid;
  select * into v_run from public.fix_verification_runs v
    where v.id = v_id and v.fix_run_id = p_fix_run_id
    for update;
  if not found then raise exception 'fix_verification_record_not_found' using errcode = 'P0002'; end if;

  update public.fix_verification_runs
  set runner_job_id = v_runner->>'jobId',
      runner_request_fingerprint = v_runner->>'requestFingerprint',
      runner_result_fingerprint = v_runner->>'resultFingerprint',
      runner_protocol = v_runner->>'protocolVersion',
      runner_version = v_runner->>'runnerVersion',
      runner_image = v_runner->>'runtimeImage',
      runner_result_signature_validated = true
  where id = v_id and fix_run_id = p_fix_run_id and workspace_id = v_run.workspace_id
    and (
      runner_job_id is null
      or (
        runner_job_id = v_runner->>'jobId'
        and runner_request_fingerprint = v_runner->>'requestFingerprint'
        and runner_result_fingerprint = v_runner->>'resultFingerprint'
        and runner_protocol = v_runner->>'protocolVersion'
        and runner_version = v_runner->>'runnerVersion'
        and runner_image = v_runner->>'runtimeImage'
        and runner_result_signature_validated is true
      )
    );
  if not found then raise exception 'fix_verification_runner_replay_conflict' using errcode = '23505'; end if;
  return v_result;
end;
$$;

revoke all on function public.record_fix_verification_runner_result(uuid,uuid,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.record_fix_verification_runner_result(uuid,uuid,uuid,jsonb)
  to service_role;
