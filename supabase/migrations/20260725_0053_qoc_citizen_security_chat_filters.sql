drop function if exists public.qoc_citizen_security_conversations(uuid, text, boolean, boolean, timestamptz, timestamptz, integer, integer, text);

create or replace function public.qoc_citizen_security_conversations(
  p_target_user_id uuid,
  p_type text default 'ALL',
  p_participant_query text default null,
  p_has_attachments boolean default null,
  p_has_location boolean default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_page integer default 1,
  p_page_size integer default 30,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, security_citizen, pg_temp
as $$
declare
  v_actor uuid := security_citizen.assert_access();
  v_page integer := greatest(1, coalesce(p_page, 1));
  v_page_size integer := greatest(1, least(coalesce(p_page_size, 30), 30));
  v_query text := nullif(trim(coalesce(p_participant_query, '')), '');
  v_total bigint;
  v_items jsonb;
  v_request_id uuid;
begin
  if not exists(select 1 from security_citizen.v_users where user_id = p_target_user_id) then
    raise exception 'security_user_not_found' using errcode = 'P0002';
  end if;

  with candidates as (
    select
      c.*,
      (select count(*) from public.chat_messages m
       where m.thread_id = c.conversation_id and m.sender_profile_id = p_target_user_id) as target_message_count,
      exists(select 1 from public.chat_attachments a where a.thread_id = c.conversation_id) as has_attachments,
      exists(select 1 from public.chat_sos_events s where s.thread_id = c.conversation_id) as has_location,
      (select count(*) from public.chat_participants cp where cp.thread_id = c.conversation_id) as participant_count,
      (select string_agg(coalesce(p.display_name, p.nombre, 'Usuario'), ', ' order by coalesce(p.display_name, p.nombre, 'Usuario'))
       from public.chat_participants cp
       join public.community_profiles p on p.id = cp.profile_id
       where cp.thread_id = c.conversation_id) as participants_preview,
      (select string_agg(coalesce(p.display_name, p.nombre, 'Usuario'), ', ' order by coalesce(p.display_name, p.nombre, 'Usuario'))
       from public.chat_participants cp
       join public.community_profiles p on p.id = cp.profile_id
       where cp.thread_id = c.conversation_id
         and cp.profile_id <> p_target_user_id
         and cp.left_at is null) as recipients_preview
    from security_citizen.v_conversations c
    where c.target_user_id = p_target_user_id
      and (upper(coalesce(p_type, 'ALL')) = 'ALL' or upper(c.conversation_type) = upper(p_type))
      and (p_date_from is null or c.last_message_at >= p_date_from)
      and (p_date_to is null or c.last_message_at <= p_date_to)
      and (
        v_query is null
        or exists(
          select 1
          from public.chat_participants cp
          join public.community_profiles p on p.id = cp.profile_id
          where cp.thread_id = c.conversation_id
            and cp.profile_id <> p_target_user_id
            and (
              coalesce(p.display_name, p.nombre, '') ilike '%' || v_query || '%'
              or coalesce(p.barrio, p.neighborhood, '') ilike '%' || v_query || '%'
            )
        )
      )
  ), filtered as (
    select *
    from candidates
    where (p_has_attachments is null or has_attachments = p_has_attachments)
      and (p_has_location is null or has_location = p_has_location)
  )
  select count(*) into v_total from filtered;

  with candidates as (
    select
      c.*,
      (select count(*) from public.chat_messages m
       where m.thread_id = c.conversation_id and m.sender_profile_id = p_target_user_id) as target_message_count,
      exists(select 1 from public.chat_attachments a where a.thread_id = c.conversation_id) as has_attachments,
      exists(select 1 from public.chat_sos_events s where s.thread_id = c.conversation_id) as has_location,
      (select count(*) from public.chat_participants cp where cp.thread_id = c.conversation_id) as participant_count,
      (select string_agg(coalesce(p.display_name, p.nombre, 'Usuario'), ', ' order by coalesce(p.display_name, p.nombre, 'Usuario'))
       from public.chat_participants cp
       join public.community_profiles p on p.id = cp.profile_id
       where cp.thread_id = c.conversation_id) as participants_preview,
      (select string_agg(coalesce(p.display_name, p.nombre, 'Usuario'), ', ' order by coalesce(p.display_name, p.nombre, 'Usuario'))
       from public.chat_participants cp
       join public.community_profiles p on p.id = cp.profile_id
       where cp.thread_id = c.conversation_id
         and cp.profile_id <> p_target_user_id
         and cp.left_at is null) as recipients_preview
    from security_citizen.v_conversations c
    where c.target_user_id = p_target_user_id
      and (upper(coalesce(p_type, 'ALL')) = 'ALL' or upper(c.conversation_type) = upper(p_type))
      and (p_date_from is null or c.last_message_at >= p_date_from)
      and (p_date_to is null or c.last_message_at <= p_date_to)
      and (
        v_query is null
        or exists(
          select 1
          from public.chat_participants cp
          join public.community_profiles p on p.id = cp.profile_id
          where cp.thread_id = c.conversation_id
            and cp.profile_id <> p_target_user_id
            and (
              coalesce(p.display_name, p.nombre, '') ilike '%' || v_query || '%'
              or coalesce(p.barrio, p.neighborhood, '') ilike '%' || v_query || '%'
            )
        )
      )
  ), filtered as (
    select *
    from candidates
    where (p_has_attachments is null or has_attachments = p_has_attachments)
      and (p_has_location is null or has_location = p_has_location)
    order by last_message_at desc nulls last
    offset (v_page - 1) * v_page_size
    limit v_page_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'conversationId', page.conversation_id,
    'conversationType', page.conversation_type,
    'title', coalesce(nullif(page.recipients_preview, ''), nullif(page.title, ''), 'Conversacion'),
    'participantCount', page.participant_count,
    'participantsPreview', page.participants_preview,
    'recipientsPreview', page.recipients_preview,
    'lastMessagePreview', page.last_message_preview,
    'lastMessageAt', page.last_message_at,
    'targetUserMessageCount', page.target_message_count,
    'hasAttachments', page.has_attachments,
    'hasLocation', page.has_location
  ) order by page.last_message_at desc nulls last), '[]'::jsonb)
  into v_items
  from filtered page;

  v_request_id := security_citizen.log_access(
    'CONVERSATION_LIST_VIEW', 'CONVERSATION', null, p_target_user_id, p_reason,
    jsonb_build_object(
      'type', p_type,
      'participantQuery', case when v_query is null then null else '[FILTERED]' end,
      'dateFrom', p_date_from,
      'dateTo', p_date_to,
      'page', v_page,
      'pageSize', v_page_size
    ),
    jsonb_build_object('resultCount', jsonb_array_length(v_items))
  );

  return jsonb_build_object(
    'requestId', v_request_id,
    'items', v_items,
    'page', v_page,
    'pageSize', v_page_size,
    'total', v_total
  );
end;
$$;

revoke all on function public.qoc_citizen_security_conversations(uuid, text, text, boolean, boolean, timestamptz, timestamptz, integer, integer, text) from public, anon;
grant execute on function public.qoc_citizen_security_conversations(uuid, text, text, boolean, boolean, timestamptz, timestamptz, integer, integer, text) to authenticated;
