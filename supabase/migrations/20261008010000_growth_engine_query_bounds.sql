create index if not exists growth_opportunities_global_recent_idx
  on public.growth_opportunities(last_evaluated_at desc,id desc);
create index if not exists growth_topics_global_created_idx
  on public.growth_topics(created_at desc,id desc);
create index if not exists growth_distribution_global_created_idx
  on public.growth_distribution_candidates(created_at desc,id desc);

create or replace function public.claim_growth_evaluation_batch(p_limit integer default 25)
returns table(queue_id uuid,classification_id uuid,source_change_id uuid,lease_token uuid,attempts integer)
language plpgsql security invoker set search_path = '' as $$
begin
  if p_limit is null or p_limit<1 or p_limit>100 then
    raise exception 'Invalid growth batch size' using errcode='22023';
  end if;

  with obsolete as (
    select queue.id from public.growth_evaluation_queue queue
    where queue.status in ('queued','failed') and not exists(
      select 1 from public.source_change_classifications cls
      join public.source_changes change on change.id=cls.change_id
      join public.source_catalog source on source.id=change.source_id and source.enabled
      join public.dependency_catalog provider on provider.id=source.dependency_id and provider.enabled
      where cls.id=queue.classification_id and cls.change_id=queue.source_change_id
        and cls.status='classified' and cls.material)
    order by queue.created_at,queue.id
    for update skip locked
    limit 100
  )
  update public.growth_evaluation_queue queue set status='completed',lease_token=null,lease_expires_at=null,
    last_error_category='no_longer_eligible',updated_at=now()
  from obsolete where queue.id=obsolete.id;

  update public.growth_evaluation_queue set status='failed',lease_token=null,lease_expires_at=null,
    last_error_category='attempt_limit_reached',updated_at=now()
  where status='claimed' and lease_expires_at<now() and attempts>=5;

  return query
  with selected as (
    select q.id from public.growth_evaluation_queue q
    where (q.status='queued' or (q.status='failed' and q.attempts<5)
      or (q.status='claimed' and q.lease_expires_at<now() and q.attempts<5))
      and q.available_at<=now()
      and exists(
        select 1 from public.source_change_classifications cls
        join public.source_changes change on change.id=cls.change_id
        join public.source_catalog source on source.id=change.source_id and source.enabled
        join public.dependency_catalog provider on provider.id=source.dependency_id and provider.enabled
        where cls.id=q.classification_id and cls.change_id=q.source_change_id
          and cls.status='classified' and cls.material)
    order by q.available_at,q.created_at,q.id
    for update skip locked limit p_limit
  )
  update public.growth_evaluation_queue q set status='claimed',attempts=q.attempts+1,
    lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes',updated_at=now()
  from selected where q.id=selected.id
  returning q.id,q.classification_id,q.source_change_id,q.lease_token,q.attempts;
end;
$$;
revoke all on function public.claim_growth_evaluation_batch(integer) from public,anon,authenticated;
grant execute on function public.claim_growth_evaluation_batch(integer) to service_role;
