-- Bounded, append-only runner failure diagnostics. Values are limited to
-- phase/status/category/reason/field names; request/response contents, URLs,
-- headers, signatures, credentials and source bodies are never accepted.
create table public.fix_stage_runner_diagnostic_events (
  id uuid primary key default gen_random_uuid(),
  fix_run_id uuid not null,
  workspace_id uuid not null,
  stage_id uuid not null,
  stage text not null default 'verify_patch' check (stage = 'verify_patch'),
  claim_token uuid not null,
  attempt_number smallint not null check (attempt_number between 1 and 4),
  failure_category text not null check (failure_category in (
    'runner_unavailable', 'runner_queue_full', 'runner_state_temporarily_unavailable',
    'runner_transport_ambiguous', 'runner_poll_timeout', 'runner_timeout_when_execution_may_continue',
    'runner_auth_failed', 'runner_protocol_unsupported', 'runner_result_invalid',
    'snapshot_identity_mismatch', 'patch_identity_mismatch', 'cache_identity_mismatch',
    'cache_signature_invalid', 'cache_tree_invalid', 'verification_unsupported', 'verification_failed'
  )),
  retryable boolean not null,
  diagnostics jsonb not null,
  created_at timestamptz not null default now(),
  constraint fix_stage_runner_diagnostic_scope_fkey
    foreign key (fix_run_id, workspace_id) references public.fix_runs(id, workspace_id) on delete restrict,
  constraint fix_stage_runner_diagnostic_stage_scope_fkey
    foreign key (stage_id, fix_run_id, workspace_id)
    references public.fix_stage_queue(id, fix_run_id, workspace_id) on delete restrict,
  constraint fix_stage_runner_diagnostic_lease_unique unique (stage_id, claim_token),
  constraint fix_stage_runner_diagnostic_payload_bounded check (
    case when jsonb_typeof(diagnostics) = 'array'
      then jsonb_array_length(diagnostics) <= 4 and octet_length(diagnostics::text) <= 4096
      else false end
  ),
  constraint fix_stage_runner_diagnostic_retry_consistency check (
    retryable = (failure_category in (
      'runner_unavailable', 'runner_queue_full', 'runner_state_temporarily_unavailable',
      'runner_transport_ambiguous', 'runner_poll_timeout', 'runner_timeout_when_execution_may_continue'
    ))
  )
);

alter table public.fix_stage_runner_diagnostic_events enable row level security;
revoke all on public.fix_stage_runner_diagnostic_events from public, anon, authenticated, service_role;
grant select on public.fix_stage_runner_diagnostic_events to service_role;

create trigger fix_stage_runner_diagnostic_events_immutable
  before update or delete on public.fix_stage_runner_diagnostic_events
  for each row execute function private.reject_fix_stage_recovery_mutation();

create function public.complete_fix_stage_with_runner_diagnostics(
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
      'runner_auth_failed', 'runner_protocol_unsupported', 'runner_result_invalid',
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
      or jsonb_object_length(v_item) not between 4 and 5
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
        'http_error','accepted_identity_mismatch','response_body_invalid','response_body_too_large',
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

revoke all on function public.complete_fix_stage_with_runner_diagnostics(uuid,uuid,text,text,boolean,jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_fix_stage_with_runner_diagnostics(uuid,uuid,text,text,boolean,jsonb)
  to service_role;
