-- The current Qüata SOS flow stores canonical alerts in chat_sos_events.
-- Expose a restricted, operator-only read model for the dashboard.
create or replace function public.qoc_sos_alerts(p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 50));
begin
  if not public.qoc_is_authorized() then
    raise exception 'qoc_access_denied' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(alert order by created_at desc)
    from (
      select
        e.created_at,
        jsonb_build_object(
          'id', e.id,
          'threadId', e.thread_id,
          'messageId', e.message_id,
          'message', e.message,
          'latitude', e.latitude,
          'longitude', e.longitude,
          'accuracy', e.accuracy_m,
          'sentCount', e.sent_count,
          'createdAt', e.created_at,
          'sender', coalesce(p.display_name, p.nombre, 'Usuario de Qüata'),
          'recipientCount', (select count(*) from public.chat_sos_recipients r where r.sos_event_id = e.id),
          'status', case when e.created_at > now() - interval '24 hours' then 'active' else 'historical' end
        ) as alert
      from public.chat_sos_events e
      left join public.community_profiles p on p.id = e.profile_id
      order by e.created_at desc
      limit v_limit
    ) recent_alerts
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.qoc_sos_alerts(integer) from public;
grant execute on function public.qoc_sos_alerts(integer) to authenticated;
