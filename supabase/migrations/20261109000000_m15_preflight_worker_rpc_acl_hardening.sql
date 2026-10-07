revoke all on function public.list_preflight_dispatch_queue(integer) from public, anon, authenticated;
grant execute on function public.list_preflight_dispatch_queue(integer) to service_role;

revoke all on function public.mark_preflight_dispatch(uuid, text, text) from public, anon, authenticated;
grant execute on function public.mark_preflight_dispatch(uuid, text, text) to service_role;