-- A scan can finish before the request that accepted it is acknowledged in the baseline queue.
-- Preserve that late Trigger run identity without reopening or duplicating completed work.
create or replace function private.mark_baseline_scan_dispatched(
  p_queue_id uuid,
  p_dispatch_attempt integer,
  p_trigger_run_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_id uuid;
  v_queue public.baseline_scan_queue%rowtype;
begin
  if p_trigger_run_id is null or p_trigger_run_id = '' then
    raise exception 'Trigger run identity is required' using errcode = '22023';
  end if;

  select source_id into v_source_id
  from public.baseline_scan_dispatch_claims
  where id = p_queue_id and dispatch_attempt = p_dispatch_attempt;
  if not found then
    raise exception 'Baseline claim was not found' using errcode = 'P0002';
  end if;

  select * into v_queue
  from public.baseline_scan_queue
  where source_id = v_source_id
  for update;
  if not found or v_queue.dispatch_attempt <> p_dispatch_attempt then
    raise exception 'Baseline claim is no longer current' using errcode = '40001';
  end if;

  if v_queue.status = 'complete' then
    if v_queue.trigger_run_id is null then
      update public.baseline_scan_queue
      set trigger_run_id = p_trigger_run_id
      where source_id = v_source_id and status = 'complete' and trigger_run_id is null;
    elsif v_queue.trigger_run_id <> p_trigger_run_id then
      raise exception 'Baseline queue already records a different Trigger run'
        using errcode = '40001';
    end if;
    return;
  end if;

  if v_queue.status = 'dispatched' and v_queue.trigger_run_id = p_trigger_run_id then
    return;
  end if;
  if v_queue.status <> 'dispatching' then
    raise exception 'Baseline claim is no longer current' using errcode = '40001';
  end if;

  update public.baseline_scan_queue
  set status = 'dispatched', dispatch_lease_until = null, trigger_run_id = p_trigger_run_id
  where source_id = v_source_id;
end;
$$;

-- Repair only the canonical OpenAI pricing queue lineage when a completed scan has a persisted
-- run identity but the earlier acknowledgement race left the queue pointer blank.
with latest_successful_scan as (
  select distinct on (run.source_id)
    run.source_id,
    run.trigger_run_id
  from public.scan_runs run
  join public.source_catalog source on source.id = run.source_id
  join public.dependency_catalog dependency on dependency.id = source.dependency_id
  where dependency.slug = 'openai'
    and source.name = 'OpenAI API pricing'
    and source.source_type = 'pricing'
    and source.url = 'https://developers.openai.com/api/docs/pricing'
    and run.status in ('success', 'unchanged', 'changed', 'not_modified')
    and run.trigger_run_id is not null
  order by run.source_id, run.finished_at desc nulls last, run.created_at desc
)
update public.baseline_scan_queue queue
set trigger_run_id = scan.trigger_run_id
from latest_successful_scan scan
where queue.source_id = scan.source_id
  and queue.status = 'complete'
  and queue.trigger_run_id is null;

revoke all on function private.mark_baseline_scan_dispatched(uuid, integer, text)
  from public, anon, authenticated;
grant execute on function private.mark_baseline_scan_dispatched(uuid, integer, text)
  to service_role;
