-- Restricted conversation reader for SOS follow-up in the Operations Center.
create or replace function public.qoc_sos_thread_messages(
  p_thread_id bigint,
  p_limit integer default 500
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 500), 500));
begin
  if not public.qoc_is_authorized() then
    raise exception 'qoc_access_denied' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.chat_sos_events e
    where e.thread_id = p_thread_id
  ) then
    raise exception 'qoc_sos_thread_not_found' using errcode = 'P0002';
  end if;

  return coalesce((
    select jsonb_agg(message order by created_at asc)
    from (
      select
        m.created_at,
        jsonb_build_object(
          'id', m.id,
          'body', coalesce(m.body, ''),
          'createdAt', m.created_at,
          'sender', coalesce(p.display_name, p.nombre, 'Usuario de Qüata'),
          'attachments', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', a.id,
              'url', a.file_url,
              'thumbnail', a.thumb,
              'mimeType', a.mime_type,
              'name', a.file_name,
              'extension', a.ext,
              'sizeBytes', a.size_bytes
            ) order by a.attached_at asc)
            from public.chat_attachments a
            where a.message_id = m.id
          ), '[]'::jsonb),
          'isSos', exists (
            select 1 from public.chat_sos_events e where e.message_id = m.id
          ) or m.body like '[SOS:%'
        ) as message
      from public.chat_messages m
      left join public.community_profiles p on p.id = m.sender_profile_id
      where m.thread_id = p_thread_id
        and m.deleted_at is null
      order by m.created_at asc
      limit v_limit
    ) thread_messages
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.qoc_sos_thread_messages(bigint, integer) from public;
grant execute on function public.qoc_sos_thread_messages(bigint, integer) to authenticated;
