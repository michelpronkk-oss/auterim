-- Keep protection history consistent for proposals created by async remediation workers.
-- The existing API route uses proposal_fingerprint as the same workspace-scoped dedupe key.
create function private.record_remediation_proposal_value_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_impact_assessment_id uuid;
begin
  select run.impact_assessment_id
    into v_impact_assessment_id
  from public.preflight_runs run
  where run.id = new.preflight_run_id
    and run.workspace_id = new.workspace_id;

  if v_impact_assessment_id is null then
    return new;
  end if;

  insert into public.protection_value_events (
    workspace_id,
    event_kind,
    impact_assessment_id,
    preflight_run_id,
    remediation_proposal_id,
    dedupe_key,
    metadata
  ) values (
    new.workspace_id,
    'remediation_generated',
    v_impact_assessment_id,
    new.preflight_run_id,
    new.id,
    new.proposal_fingerprint,
    jsonb_build_object('proposalKind', new.proposal_kind)
  )
  on conflict (workspace_id, event_kind, dedupe_key) do nothing;

  return new;
end;
$$;

revoke all on function private.record_remediation_proposal_value_event() from public, anon, authenticated;

create trigger remediation_proposals_record_value_event
  after insert on public.remediation_proposals
  for each row execute function private.record_remediation_proposal_value_event();
