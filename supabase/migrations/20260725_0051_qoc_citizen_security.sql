-- QOC citizen-security vertical slice.
-- Sensitive data remains behind audited SECURITY DEFINER RPCs. The direct
-- lookup workflow is explicitly a demo mode and can be disabled independently.

create schema if not exists security_citizen;
revoke all on schema security_citizen from public, anon, authenticated;

insert into public.qoc_feature_flags(key, description, enabled, rollout_percent)
values
  ('security_citizen', 'Módulo auditado de Seguridad ciudadana', true, 100),
  ('security_citizen_direct_access_demo', 'Consulta directa sin expediente para demostración', true, 100)
on conflict (key) do update
set description = excluded.description,
    enabled = excluded.enabled,
    rollout_percent = excluded.rollout_percent,
    updated_at = now();

create table if not exists security_citizen.access_audit_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  actor_user_id uuid not null,
  actor_profile_id uuid not null,
  actor_display_name text,
  actor_roles text[] not null default '{}',
  target_user_id uuid,
  target_display_name text,
  action text not null,
  resource_type text not null,
  resource_id text,
  request_id uuid not null,
  success boolean not null default true,
  error_code text,
  reason text,
  filters jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  previous_event_hash text,
  event_hash text not null
);

create index if not exists security_access_audit_target_idx
  on security_citizen.access_audit_events(target_user_id, occurred_at desc);
create index if not exists security_access_audit_actor_idx
  on security_citizen.access_audit_events(actor_profile_id, occurred_at desc);
create index if not exists security_access_audit_action_idx
  on security_citizen.access_audit_events(action, occurred_at desc);

create or replace function security_citizen.prevent_audit_mutation()
returns trigger
language plpgsql
set search_path = security_citizen, pg_temp
as $$
begin
  raise exception 'security_audit_events_are_immutable' using errcode = '42501';
end;
$$;

drop trigger if exists trg_security_audit_immutable on security_citizen.access_audit_events;
create trigger trg_security_audit_immutable
before update or delete on security_citizen.access_audit_events
for each row execute function security_citizen.prevent_audit_mutation();

create or replace view security_citizen.v_users as
select
  p.id as user_id,
  p.auth_user_id,
  coalesce(nullif(p.display_name, ''), nullif(p.nombre, ''), 'Usuario de Qüata') as display_name,
  coalesce(nullif(p.avatar_url, ''), nullif(p.avatar, '')) as avatar_url,
  coalesce(nullif(p.phone_e164, ''), nullif(p.phone, ''), nullif(p.telefono, '')) as phone,
  p.country_code,
  p.phone_local,
  coalesce(nullif(p.neighborhood, ''), nullif(p.barrio, '')) as neighborhood,
  coalesce(p.account_status, 'active') as account_status,
  p.is_official,
  p.is_admin,
  p.created_at,
  p.last_login_at
from public.community_profiles p;

create or replace view security_citizen.v_conversations as
select
  cp.profile_id as target_user_id,
  t.id as conversation_id,
  coalesce(t.type, 'private') as conversation_type,
  coalesce(nullif(t.title, ''), nullif(t.subject, ''), 'Conversación') as title,
  t.created_at,
  t.last_message_at,
  t.last_message_preview
from public.chat_participants cp
join public.chat_threads t on t.id = cp.thread_id
where t.deleted_at is null;

create or replace view security_citizen.v_messages as
select
  m.id as message_id,
  m.thread_id as conversation_id,
  m.sender_profile_id as author_user_id,
  m.body,
  m.created_at,
  m.updated_at,
  m.edited_at,
  m.deleted_at,
  m.reply_to_message_id
from public.chat_messages m;

create or replace function security_citizen.assert_access(p_capability text default 'citizen.security.read')
returns uuid
language plpgsql
stable
security definer
set search_path = public, security_citizen, pg_temp
as $$
declare
  v_actor uuid := public.qoc_current_profile_id();
begin
  if auth.uid() is null or v_actor is null then
    raise exception 'security_unauthenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.qoc_feature_flags f
    where f.key = 'security_citizen' and f.enabled and f.rollout_percent > 0
  ) then
    raise exception 'security_module_disabled' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.qoc_user_roles r
    where r.profile_id = v_actor
      and r.active
      and (r.expires_at is null or r.expires_at > now())
      and (
        r.role_key in ('superadmin', 'national_admin')
        or r.permissions ? '*'
        or r.permissions ? p_capability
      )
  ) then
    raise exception 'security_access_denied' using errcode = '42501';
  end if;
  return v_actor;
end;
$$;

create or replace function security_citizen.log_access(
  p_action text,
  p_resource_type text,
  p_resource_id text default null,
  p_target_user_id uuid default null,
  p_reason text default null,
  p_filters jsonb default '{}'::jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, security_citizen, pg_temp
as $$
declare
  v_actor uuid := security_citizen.assert_access(
    case when p_action in ('AUDIT_GLOBAL_VIEW') then 'citizen.security.audit' else 'citizen.security.read' end
  );
  v_request_id uuid := gen_random_uuid();
  v_previous_hash text;
  v_event_hash text;
  v_actor_name text;
  v_target_name text;
  v_roles text[];
begin
  select display_name into v_actor_name from security_citizen.v_users where user_id = v_actor;
  select display_name into v_target_name from security_citizen.v_users where user_id = p_target_user_id;
  select coalesce(array_agg(distinct role_key), '{}') into v_roles
  from public.qoc_user_roles
  where profile_id = v_actor and active and (expires_at is null or expires_at > now());

  select event_hash into v_previous_hash
  from security_citizen.access_audit_events
  order by occurred_at desc, id desc
  limit 1;

  v_event_hash := md5(concat_ws(
    '|', coalesce(v_previous_hash, ''), v_request_id::text, auth.uid()::text,
    v_actor::text, coalesce(p_target_user_id::text, ''), p_action,
    p_resource_type, coalesce(p_resource_id, ''), clock_timestamp()::text
  ));

  insert into security_citizen.access_audit_events(
    actor_user_id, actor_profile_id, actor_display_name, actor_roles,
    target_user_id, target_display_name, action, resource_type, resource_id,
    request_id, reason, filters, metadata, previous_event_hash, event_hash
  ) values (
    auth.uid(), v_actor, v_actor_name, v_roles,
    p_target_user_id, v_target_name, p_action, p_resource_type, p_resource_id,
    v_request_id, nullif(trim(coalesce(p_reason, '')), ''), coalesce(p_filters, '{}'::jsonb),
    coalesce(p_metadata, '{}'::jsonb), v_previous_hash, v_event_hash
  );

  perform public.qoc_write_audit(
    'citizen_security.' || lower(p_action),
    lower(p_resource_type),
    coalesce(p_resource_id, p_target_user_id::text),
    null,
    jsonb_build_object('requestId', v_request_id, 'targetUserId', p_target_user_id),
    p_reason
  );
  return v_request_id;
end;
$$;

create or replace function public.qoc_citizen_security_config()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, security_citizen, pg_temp
as $$
declare
  v_actor uuid := security_citizen.assert_access();
begin
  return jsonb_build_object(
    'enabled', true,
    'directAccessDemo', coalesce((
      select enabled from public.qoc_feature_flags
      where key = 'security_citizen_direct_access_demo'
    ), false),
    'requireReason', false,
    'maxDateRangeDays', 365,
    'locationLinkMaxHours', 72,
    'actorProfileId', v_actor
  );
end;
$$;

create or replace function public.qoc_citizen_security_search(
  p_query text,
  p_page integer default 1,
  p_page_size integer default 20,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, security_citizen, pg_temp
as $$
declare
  v_actor uuid := security_citizen.assert_access();
  v_query text := trim(regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g'));
  v_page integer := greatest(1, coalesce(p_page, 1));
  v_page_size integer := greatest(1, least(coalesce(p_page_size, 20), 20));
  v_total bigint;
  v_items jsonb;
  v_request_id uuid;
begin
  if char_length(v_query) < 2 and v_query !~* '^[0-9a-f-]{32,36}$' then
    raise exception 'security_search_too_short' using errcode = '22023';
  end if;
  if char_length(v_query) > 50 then
    raise exception 'security_search_too_long' using errcode = '22023';
  end if;

  select count(*) into v_total
  from security_citizen.v_users u
  where concat_ws(' ', u.user_id, u.display_name, u.phone, u.phone_local, u.neighborhood)
    ilike '%' || v_query || '%';

  select coalesce(jsonb_agg(row_data order by sort_name), '[]'::jsonb)
  into v_items
  from (
    select
      lower(u.display_name) as sort_name,
      jsonb_build_object(
        'userId', u.user_id,
        'displayName', u.display_name,
        'avatarUrl', u.avatar_url,
        'maskedPhone', case
          when char_length(coalesce(u.phone, '')) > 4
            then left(u.phone, greatest(1, least(4, char_length(u.phone) - 4)))
              || ' •••• ' || right(u.phone, 4)
          else 'Número no disponible'
        end,
        'neighborhood', coalesce(u.neighborhood, 'Sin barrio declarado'),
        'accountStatus', u.account_status,
        'lastActivityAt', u.last_login_at
      ) as row_data
    from security_citizen.v_users u
    where concat_ws(' ', u.user_id, u.display_name, u.phone, u.phone_local, u.neighborhood)
      ilike '%' || v_query || '%'
    order by
      case when u.display_name ilike v_query || '%' then 0 else 1 end,
      lower(u.display_name)
    offset (v_page - 1) * v_page_size
    limit v_page_size
  ) rows;

  v_request_id := security_citizen.log_access(
    'USER_SEARCH', 'USER', null, null, p_reason,
    jsonb_build_object('queryHash', md5(lower(v_query)), 'page', v_page, 'pageSize', v_page_size),
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

create or replace function public.qoc_citizen_security_open_profile(
  p_target_user_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, security_citizen, pg_temp
as $$
declare
  v_actor uuid := security_citizen.assert_access();
  v_profile jsonb;
  v_summary jsonb;
  v_request_id uuid;
begin
  select jsonb_build_object(
    'userId', u.user_id,
    'displayName', u.display_name,
    'avatarUrl', u.avatar_url,
    'phone', u.phone,
    'countryCode', u.country_code,
    'phoneLocal', u.phone_local,
    'neighborhood', coalesce(u.neighborhood, 'Sin barrio declarado'),
    'registeredAt', u.created_at,
    'lastActivityAt', u.last_login_at,
    'accountStatus', u.account_status,
    'isOfficial', u.is_official,
    'isAdmin', u.is_admin
  ) into v_profile
  from security_citizen.v_users u
  where u.user_id = p_target_user_id;

  if v_profile is null then
    raise exception 'security_user_not_found' using errcode = 'P0002';
  end if;

  select jsonb_build_object(
    'conversationCount', (
      select count(distinct c.conversation_id)
      from security_citizen.v_conversations c where c.target_user_id = p_target_user_id
    ),
    'messagesSent', (
      select count(*) from security_citizen.v_messages m where m.author_user_id = p_target_user_id
    ),
    'messagesReceived', (
      select count(*)
      from security_citizen.v_messages m
      where m.conversation_id in (
        select c.conversation_id from security_citizen.v_conversations c
        where c.target_user_id = p_target_user_id
      ) and m.author_user_id is distinct from p_target_user_id
    ),
    'sosEventCount', (
      select count(*) from public.chat_sos_events s where s.profile_id = p_target_user_id
    ),
    'communityPostCount', (
      select count(*) from public.community_posts p
      where coalesce(p.profile_id, p.author_id) = p_target_user_id
    ),
    'mediaCount', (
      select count(*)
      from public.chat_attachments a
      where a.thread_id in (
        select c.conversation_id from security_citizen.v_conversations c
        where c.target_user_id = p_target_user_id
      )
    ),
    'firstEvidenceAt', least(
      (select min(s.created_at) from public.chat_sos_events s where s.profile_id = p_target_user_id),
      (select min(p.created_at) from public.community_posts p where coalesce(p.profile_id, p.author_id) = p_target_user_id)
    ),
    'lastEvidenceAt', greatest(
      (select max(s.created_at) from public.chat_sos_events s where s.profile_id = p_target_user_id),
      (select max(p.created_at) from public.community_posts p where coalesce(p.profile_id, p.author_id) = p_target_user_id)
    )
  ) into v_summary;

  v_request_id := security_citizen.log_access(
    'PROFILE_OPEN', 'PROFILE', p_target_user_id::text, p_target_user_id, p_reason,
    '{}'::jsonb, jsonb_build_object('summaryReturned', true)
  );
  return jsonb_build_object('requestId', v_request_id, 'profile', v_profile, 'summary', v_summary);
end;
$$;

create or replace function public.qoc_citizen_security_conversations(
  p_target_user_id uuid,
  p_type text default 'ALL',
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
       from public.chat_participants cp join public.community_profiles p on p.id = cp.profile_id
       where cp.thread_id = c.conversation_id) as participants_preview
    from security_citizen.v_conversations c
    where c.target_user_id = p_target_user_id
      and (upper(coalesce(p_type, 'ALL')) = 'ALL' or upper(c.conversation_type) = upper(p_type))
      and (p_date_from is null or c.last_message_at >= p_date_from)
      and (p_date_to is null or c.last_message_at <= p_date_to)
  ), filtered as (
    select * from candidates
    where (p_has_attachments is null or has_attachments = p_has_attachments)
      and (p_has_location is null or has_location = p_has_location)
  )
  select count(*), coalesce(jsonb_agg(jsonb_build_object(
    'conversationId', page.conversation_id,
    'conversationType', page.conversation_type,
    'title', page.title,
    'participantCount', page.participant_count,
    'participantsPreview', page.participants_preview,
    'lastMessagePreview', page.last_message_preview,
    'lastMessageAt', page.last_message_at,
    'targetUserMessageCount', page.target_message_count,
    'hasAttachments', page.has_attachments,
    'hasLocation', page.has_location
  ) order by page.last_message_at desc nulls last), '[]'::jsonb)
  into v_total, v_items
  from (
    select * from filtered
    order by last_message_at desc nulls last
    offset (v_page - 1) * v_page_size
    limit v_page_size
  ) page;

  -- The count above intentionally reflects the current page when aggregated
  -- together; calculate the complete count separately for pagination.
  select count(*) into v_total
  from security_citizen.v_conversations c
  where c.target_user_id = p_target_user_id
    and (upper(coalesce(p_type, 'ALL')) = 'ALL' or upper(c.conversation_type) = upper(p_type))
    and (p_date_from is null or c.last_message_at >= p_date_from)
    and (p_date_to is null or c.last_message_at <= p_date_to)
    and (p_has_attachments is null or exists(
      select 1 from public.chat_attachments a where a.thread_id = c.conversation_id
    ) = p_has_attachments)
    and (p_has_location is null or exists(
      select 1 from public.chat_sos_events s where s.thread_id = c.conversation_id
    ) = p_has_location);

  v_request_id := security_citizen.log_access(
    'CONVERSATION_LIST_VIEW', 'CONVERSATION', null, p_target_user_id, p_reason,
    jsonb_build_object('type', p_type, 'page', v_page, 'pageSize', v_page_size),
    jsonb_build_object('resultCount', jsonb_array_length(v_items))
  );
  return jsonb_build_object(
    'requestId', v_request_id, 'items', v_items,
    'page', v_page, 'pageSize', v_page_size, 'total', v_total
  );
end;
$$;

create or replace function public.qoc_citizen_security_conversation(
  p_target_user_id uuid,
  p_conversation_id bigint,
  p_query text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_author_mode text default 'ANY',
  p_has_attachment boolean default null,
  p_page integer default 1,
  p_page_size integer default 50,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, security_citizen, pg_temp
as $$
declare
  v_actor uuid := security_citizen.assert_access();
  v_query text := trim(coalesce(p_query, ''));
  v_page integer := greatest(1, coalesce(p_page, 1));
  v_page_size integer := greatest(1, least(coalesce(p_page_size, 50), 50));
  v_total bigint;
  v_thread jsonb;
  v_participants jsonb;
  v_messages jsonb;
  v_request_id uuid;
begin
  if not exists(
    select 1 from security_citizen.v_conversations
    where target_user_id = p_target_user_id and conversation_id = p_conversation_id
  ) then
    raise exception 'security_resource_not_linked_to_target' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'conversationId', t.id,
    'type', coalesce(t.type, 'private'),
    'title', coalesce(nullif(t.title, ''), nullif(t.subject, ''), 'Conversación'),
    'createdAt', t.created_at,
    'lastMessageAt', t.last_message_at
  ) into v_thread
  from public.chat_threads t where t.id = p_conversation_id and t.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', p.id,
    'displayName', coalesce(p.display_name, p.nombre, 'Usuario'),
    'avatarUrl', coalesce(p.avatar_url, p.avatar),
    'role', cp.role,
    'joinedAt', cp.joined_at,
    'leftAt', cp.left_at
  ) order by coalesce(p.display_name, p.nombre, 'Usuario')), '[]'::jsonb)
  into v_participants
  from public.chat_participants cp
  join public.community_profiles p on p.id = cp.profile_id
  where cp.thread_id = p_conversation_id;

  select count(*) into v_total
  from public.chat_messages m
  where m.thread_id = p_conversation_id
    and (p_date_from is null or m.created_at >= p_date_from)
    and (p_date_to is null or m.created_at <= p_date_to)
    and (v_query = '' or coalesce(m.body, '') ilike '%' || v_query || '%')
    and (
      upper(coalesce(p_author_mode, 'ANY')) = 'ANY'
      or (upper(p_author_mode) = 'TARGET_ONLY' and m.sender_profile_id = p_target_user_id)
      or (upper(p_author_mode) = 'OTHERS_ONLY' and m.sender_profile_id is distinct from p_target_user_id)
    )
    and (p_has_attachment is null or exists(
      select 1 from public.chat_attachments a where a.message_id = m.id
    ) = p_has_attachment);

  select coalesce(jsonb_agg(payload order by created_at), '[]'::jsonb)
  into v_messages
  from (
    select m.created_at, jsonb_build_object(
      'messageId', m.id,
      'authorUserId', m.sender_profile_id,
      'authorDisplayName', coalesce(sender.display_name, sender.nombre, 'Usuario'),
      'authorAvatarUrl', coalesce(sender.avatar_url, sender.avatar),
      'sentAt', m.created_at,
      'serverReceivedAt', m.created_at,
      'type', case
        when exists(select 1 from public.chat_sos_events s where s.message_id = m.id) then 'SOS'
        when exists(select 1 from public.chat_attachments a where a.message_id = m.id) then 'ATTACHMENT'
        else 'TEXT'
      end,
      'text', case when m.deleted_at is not null then '[DELETED]' else coalesce(m.body, '') end,
      'edited', m.edited_at is not null,
      'deleted', m.deleted_at is not null,
      'replyToMessageId', m.reply_to_message_id,
      'attachments', coalesce((
        select jsonb_agg(jsonb_build_object(
          'mediaId', 'chat:' || a.id::text,
          'name', coalesce(a.file_name, 'Adjunto'),
          'mimeType', a.mime_type,
          'sizeBytes', a.size_bytes,
          'thumbnail', a.thumb,
          'openRequiresAudit', true
        ) order by a.id)
        from public.chat_attachments a where a.message_id = m.id
      ), '[]'::jsonb),
      'location', (
        select jsonb_build_object(
          'latitude', case when s.latitude = 0 and s.longitude = 0 then null else s.latitude end,
          'longitude', case when s.latitude = 0 and s.longitude = 0 then null else s.longitude end,
          'accuracyMeters', s.accuracy_m
        ) from public.chat_sos_events s where s.message_id = m.id limit 1
      )
    ) as payload
    from public.chat_messages m
    left join public.community_profiles sender on sender.id = m.sender_profile_id
    where m.thread_id = p_conversation_id
      and (p_date_from is null or m.created_at >= p_date_from)
      and (p_date_to is null or m.created_at <= p_date_to)
      and (v_query = '' or coalesce(m.body, '') ilike '%' || v_query || '%')
      and (
        upper(coalesce(p_author_mode, 'ANY')) = 'ANY'
        or (upper(p_author_mode) = 'TARGET_ONLY' and m.sender_profile_id = p_target_user_id)
        or (upper(p_author_mode) = 'OTHERS_ONLY' and m.sender_profile_id is distinct from p_target_user_id)
      )
      and (p_has_attachment is null or exists(
        select 1 from public.chat_attachments a where a.message_id = m.id
      ) = p_has_attachment)
    order by m.created_at desc, m.id desc
    offset (v_page - 1) * v_page_size
    limit v_page_size
  ) messages_page;

  v_request_id := security_citizen.log_access(
    case when v_query = '' then 'CONVERSATION_OPEN' else 'MESSAGE_SEARCH' end,
    'CONVERSATION', p_conversation_id::text, p_target_user_id, p_reason,
    jsonb_build_object(
      'queryHash', case when v_query = '' then null else md5(lower(v_query)) end,
      'page', v_page, 'pageSize', v_page_size, 'authorMode', p_author_mode
    ),
    jsonb_build_object('messageCount', jsonb_array_length(v_messages))
  );
  return jsonb_build_object(
    'requestId', v_request_id,
    'conversation', v_thread,
    'participants', v_participants,
    'messages', v_messages,
    'page', v_page, 'pageSize', v_page_size, 'total', v_total
  );
end;
$$;

create or replace function public.qoc_citizen_security_location_timeline(
  p_target_user_id uuid,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_sources text[] default null,
  p_only_coordinates boolean default false,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, security_citizen, pg_temp
as $$
declare
  v_actor uuid := security_citizen.assert_access();
  v_events jsonb;
  v_request_id uuid;
begin
  if p_date_from is not null and p_date_to is not null and (
    p_date_from > p_date_to or p_date_to - p_date_from > interval '365 days'
  ) then
    raise exception 'security_date_range_too_large' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(event order by observed_at desc nulls last), '[]'::jsonb)
  into v_events
  from (
    select p.created_at as observed_at, jsonb_build_object(
      'evidenceId', 'neighborhood:' || p.id::text,
      'sourceType', 'PROFILE_NEIGHBORHOOD',
      'observedAt', null,
      'receivedAt', p.created_at,
      'placeLabel', coalesce(p.neighborhood, p.barrio),
      'latitude', null,
      'longitude', null,
      'accuracyMeters', null,
      'geometryType', 'NONE',
      'reliability', 'CONTEXT_ONLY',
      'reliabilityReasons', jsonb_build_array('Barrio autodeclarado en el perfil'),
      'sourceResourceType', 'PROFILE',
      'sourceResourceId', p.id,
      'preview', 'Contexto territorial declarado; no representa movimiento.',
      'warnings', jsonb_build_array('No se muestra como punto exacto.')
    ) as event
    from public.community_profiles p
    where p.id = p_target_user_id
      and coalesce(nullif(p.neighborhood, ''), nullif(p.barrio, '')) is not null
      and not p_only_coordinates
      and (p_sources is null or 'PROFILE_NEIGHBORHOOD' = any(p_sources))

    union all

    select s.created_at, jsonb_build_object(
      'evidenceId', 'sos:' || s.id::text,
      'sourceType', 'SOS_LOCATION',
      'observedAt', s.created_at,
      'receivedAt', s.created_at,
      'placeLabel', 'Ubicación asociada a alerta SOS',
      'latitude', case when s.latitude = 0 and s.longitude = 0 then null else s.latitude end,
      'longitude', case when s.latitude = 0 and s.longitude = 0 then null else s.longitude end,
      'accuracyMeters', s.accuracy_m,
      'geometryType', case when s.latitude is null or s.longitude is null or (s.latitude = 0 and s.longitude = 0) then 'NONE' else 'POINT' end,
      'reliability', case when s.latitude is null or s.longitude is null or (s.latitude = 0 and s.longitude = 0) then 'LOW' else 'HIGH' end,
      'reliabilityReasons', jsonb_build_array('Coordenadas almacenadas por el sistema SOS'),
      'sourceResourceType', 'SOS_EVENT',
      'sourceResourceId', s.id,
      'conversationId', s.thread_id,
      'messageId', s.message_id,
      'preview', s.message,
      'warnings', case
        when s.latitude is null or s.longitude is null or (s.latitude = 0 and s.longitude = 0)
          then jsonb_build_array('La alerta no conserva coordenadas válidas.')
        else jsonb_build_array('Ubicación declarada por el dispositivo; no implica seguimiento en tiempo real.')
      end
    )
    from public.chat_sos_events s
    where s.profile_id = p_target_user_id
      and (p_date_from is null or s.created_at >= p_date_from)
      and (p_date_to is null or s.created_at <= p_date_to)
      and (not p_only_coordinates or (
        s.latitude is not null and s.longitude is not null and not (s.latitude = 0 and s.longitude = 0)
      ))
      and (p_sources is null or 'SOS_LOCATION' = any(p_sources))

    union all

    select post.created_at, jsonb_build_object(
      'evidenceId', 'post-text:' || post.id::text,
      'sourceType', 'POST_MANUAL_LOCATION_TEXT',
      'observedAt', post.created_at,
      'receivedAt', post.created_at,
      'placeLabel', post.place_label,
      'latitude', null,
      'longitude', null,
      'accuracyMeters', null,
      'geometryType', 'NONE',
      'reliability', 'LOW',
      'reliabilityReasons', jsonb_build_array('Texto geográfico heredado sin coordenadas estructuradas'),
      'sourceResourceType', 'POST',
      'sourceResourceId', post.id,
      'preview', post.preview,
      'warnings', jsonb_build_array('Origen manual o automático desconocido; no se geocodifica ni se dibuja como punto.')
    )
    from (
      select
        p.id, p.created_at,
        substring(coalesce(p.body, p.content, '') from '\[UBICACION:([^\]]+)\]') as place_label,
        left(regexp_replace(coalesce(p.body, p.content, ''), '\[[^\]]+\]', '', 'g'), 240) as preview
      from public.community_posts p
      where coalesce(p.profile_id, p.author_id) = p_target_user_id
        and (p_date_from is null or p.created_at >= p_date_from)
        and (p_date_to is null or p.created_at <= p_date_to)
    ) post
    where nullif(post.place_label, '') is not null
      and not p_only_coordinates
      and (p_sources is null or 'POST_MANUAL_LOCATION_TEXT' = any(p_sources))
  ) evidence;

  v_request_id := security_citizen.log_access(
    'LOCATION_TIMELINE_VIEW', 'LOCATION_TIMELINE', null, p_target_user_id, p_reason,
    jsonb_build_object('dateFrom', p_date_from, 'dateTo', p_date_to, 'sources', p_sources),
    jsonb_build_object('eventCount', jsonb_array_length(v_events))
  );
  return jsonb_build_object(
    'requestId', v_request_id,
    'events', v_events,
    'locationLinkMaxHours', 72,
    'notice', 'Cronología histórica de evidencias; no representa seguimiento en tiempo real ni una ruta confirmada.'
  );
end;
$$;

create or replace function public.qoc_citizen_security_media(
  p_target_user_id uuid,
  p_origin text default 'ALL',
  p_page integer default 1,
  p_page_size integer default 50,
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
  v_page_size integer := greatest(1, least(coalesce(p_page_size, 50), 50));
  v_items jsonb;
  v_total bigint;
  v_request_id uuid;
begin
  with media as (
    select
      'chat:' || a.id::text as media_id,
      'CHAT'::text as origin,
      a.message_id::text as origin_resource_id,
      a.mime_type,
      a.file_name,
      a.size_bytes,
      coalesce(a.attached_at, a.created_at) as uploaded_at,
      a.thumb as thumbnail,
      'NOT_ANALYZED'::text as analysis_status
    from public.chat_attachments a
    where a.thread_id in (
      select c.conversation_id from security_citizen.v_conversations c
      where c.target_user_id = p_target_user_id
    )
    union all
    select
      'community:' || p.id::text,
      'POST',
      p.id::text,
      case when nullif(p.video_url, '') is not null then 'video/*' else 'image/*' end,
      'Archivo de publicación',
      null,
      p.created_at,
      null,
      'NOT_ANALYZED'
    from public.community_posts p
    where coalesce(p.profile_id, p.author_id) = p_target_user_id
      and coalesce(nullif(p.image_url, ''), nullif(p.video_url, '')) is not null
    union all
    select
      'official:' || p.id::text,
      'POST',
      p.id::text,
      coalesce(nullif(p.media_type, ''), 'application/octet-stream'),
      'Archivo de publicación oficial',
      null,
      p.created_at,
      null,
      'NOT_ANALYZED'
    from public.official_posts p
    where p.profile_id = p_target_user_id
      and p.deleted_at is null
      and nullif(p.media_url, '') is not null
  ), filtered as (
    select * from media where upper(coalesce(p_origin, 'ALL')) = 'ALL' or origin = upper(p_origin)
  )
  select count(*) into v_total from filtered;

  with media as (
    select
      'chat:' || a.id::text as media_id, 'CHAT'::text as origin,
      a.message_id::text as origin_resource_id, a.mime_type, a.file_name,
      a.size_bytes, coalesce(a.attached_at, a.created_at) as uploaded_at,
      a.thumb as thumbnail, 'NOT_ANALYZED'::text as analysis_status
    from public.chat_attachments a
    where a.thread_id in (
      select c.conversation_id from security_citizen.v_conversations c
      where c.target_user_id = p_target_user_id
    )
    union all
    select 'community:' || p.id::text, 'POST', p.id::text,
      case when nullif(p.video_url, '') is not null then 'video/*' else 'image/*' end,
      'Archivo de publicación', null, p.created_at, null, 'NOT_ANALYZED'
    from public.community_posts p
    where coalesce(p.profile_id, p.author_id) = p_target_user_id
      and coalesce(nullif(p.image_url, ''), nullif(p.video_url, '')) is not null
    union all
    select 'official:' || p.id::text, 'POST', p.id::text,
      coalesce(nullif(p.media_type, ''), 'application/octet-stream'),
      'Archivo de publicación oficial', null, p.created_at, null, 'NOT_ANALYZED'
    from public.official_posts p
    where p.profile_id = p_target_user_id and p.deleted_at is null and nullif(p.media_url, '') is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'mediaId', m.media_id,
    'origin', m.origin,
    'originResourceId', m.origin_resource_id,
    'mimeType', m.mime_type,
    'fileName', m.file_name,
    'uploadedAt', m.uploaded_at,
    'sizeBytes', m.size_bytes,
    'thumbnail', m.thumbnail,
    'hasExif', false,
    'hasExifGps', false,
    'analysisStatus', m.analysis_status,
    'openRequiresAudit', true
  ) order by m.uploaded_at desc), '[]'::jsonb)
  into v_items
  from (
    select * from media
    where upper(coalesce(p_origin, 'ALL')) = 'ALL' or origin = upper(p_origin)
    order by uploaded_at desc
    offset (v_page - 1) * v_page_size
    limit v_page_size
  ) m;

  v_request_id := security_citizen.log_access(
    'MEDIA_LIST_VIEW', 'MEDIA_OBJECT', null, p_target_user_id, p_reason,
    jsonb_build_object('origin', p_origin, 'page', v_page, 'pageSize', v_page_size),
    jsonb_build_object('resultCount', jsonb_array_length(v_items))
  );
  return jsonb_build_object(
    'requestId', v_request_id, 'items', v_items,
    'page', v_page, 'pageSize', v_page_size, 'total', v_total
  );
end;
$$;

create or replace function public.qoc_citizen_security_open_media(
  p_target_user_id uuid,
  p_media_id text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, security_citizen, pg_temp
as $$
declare
  v_actor uuid := security_citizen.assert_access();
  v_url text;
  v_mime text;
  v_name text;
  v_request_id uuid;
  v_id text := split_part(p_media_id, ':', 2);
begin
  case split_part(p_media_id, ':', 1)
    when 'chat' then
      select a.file_url, a.mime_type, a.file_name into v_url, v_mime, v_name
      from public.chat_attachments a
      where a.id = v_id::bigint
        and a.thread_id in (
          select c.conversation_id from security_citizen.v_conversations c
          where c.target_user_id = p_target_user_id
        );
    when 'community' then
      select coalesce(nullif(p.video_url, ''), nullif(p.image_url, '')),
        case when nullif(p.video_url, '') is not null then 'video/*' else 'image/*' end,
        'Archivo de publicación'
      into v_url, v_mime, v_name
      from public.community_posts p
      where p.id = v_id::uuid and coalesce(p.profile_id, p.author_id) = p_target_user_id;
    when 'official' then
      select p.media_url, p.media_type, 'Archivo de publicación oficial'
      into v_url, v_mime, v_name
      from public.official_posts p
      where p.id = v_id::uuid and p.profile_id = p_target_user_id and p.deleted_at is null;
    else
      raise exception 'security_invalid_media_id' using errcode = '22023';
  end case;

  if nullif(v_url, '') is null then
    raise exception 'security_storage_object_not_found' using errcode = 'P0002';
  end if;

  v_request_id := security_citizen.log_access(
    'MEDIA_SIGNED_URL_CREATED', 'MEDIA_OBJECT', p_media_id, p_target_user_id, p_reason,
    '{}'::jsonb,
    jsonb_build_object(
      'legacyPublicObject', true,
      'notice', 'Los buckets heredados son públicos; la resolución del enlace queda auditada.'
    )
  );
  return jsonb_build_object(
    'requestId', v_request_id,
    'url', v_url,
    'mimeType', v_mime,
    'fileName', v_name,
    'expiresIn', null,
    'legacyPublicObject', true
  );
end;
$$;

create or replace function public.qoc_citizen_security_audit(
  p_target_user_id uuid default null,
  p_action text default null,
  p_page integer default 1,
  p_page_size integer default 50,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, security_citizen, pg_temp
as $$
declare
  v_actor uuid := security_citizen.assert_access(
    case when p_target_user_id is null then 'citizen.security.audit' else 'citizen.security.read' end
  );
  v_page integer := greatest(1, coalesce(p_page, 1));
  v_page_size integer := greatest(1, least(coalesce(p_page_size, 50), 100));
  v_total bigint;
  v_items jsonb;
  v_request_id uuid;
begin
  select count(*) into v_total
  from security_citizen.access_audit_events e
  where (p_target_user_id is null or e.target_user_id = p_target_user_id)
    and (p_action is null or p_action = '' or e.action = p_action);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id,
    'occurredAt', e.occurred_at,
    'actorDisplayName', e.actor_display_name,
    'actorRoles', e.actor_roles,
    'targetUserId', e.target_user_id,
    'targetDisplayName', e.target_display_name,
    'action', e.action,
    'resourceType', e.resource_type,
    'resourceId', e.resource_id,
    'requestId', e.request_id,
    'success', e.success,
    'reason', e.reason
  ) order by e.occurred_at desc), '[]'::jsonb)
  into v_items
  from (
    select * from security_citizen.access_audit_events e
    where (p_target_user_id is null or e.target_user_id = p_target_user_id)
      and (p_action is null or p_action = '' or e.action = p_action)
    order by e.occurred_at desc
    offset (v_page - 1) * v_page_size
    limit v_page_size
  ) e;

  v_request_id := security_citizen.log_access(
    case when p_target_user_id is null then 'AUDIT_GLOBAL_VIEW' else 'AUDIT_PROFILE_VIEW' end,
    'AUDIT_LOG', null, p_target_user_id, p_reason,
    jsonb_build_object('action', p_action, 'page', v_page),
    jsonb_build_object('resultCount', jsonb_array_length(v_items))
  );
  return jsonb_build_object(
    'requestId', v_request_id, 'items', v_items,
    'page', v_page, 'pageSize', v_page_size, 'total', v_total
  );
end;
$$;

revoke all on all functions in schema security_citizen from public, anon, authenticated;
revoke all on function public.qoc_citizen_security_config() from public, anon;
revoke all on function public.qoc_citizen_security_search(text, integer, integer, text) from public, anon;
revoke all on function public.qoc_citizen_security_open_profile(uuid, text) from public, anon;
revoke all on function public.qoc_citizen_security_conversations(uuid, text, boolean, boolean, timestamptz, timestamptz, integer, integer, text) from public, anon;
revoke all on function public.qoc_citizen_security_conversation(uuid, bigint, text, timestamptz, timestamptz, text, boolean, integer, integer, text) from public, anon;
revoke all on function public.qoc_citizen_security_location_timeline(uuid, timestamptz, timestamptz, text[], boolean, text) from public, anon;
revoke all on function public.qoc_citizen_security_media(uuid, text, integer, integer, text) from public, anon;
revoke all on function public.qoc_citizen_security_open_media(uuid, text, text) from public, anon;
revoke all on function public.qoc_citizen_security_audit(uuid, text, integer, integer, text) from public, anon;

grant execute on function public.qoc_citizen_security_config() to authenticated;
grant execute on function public.qoc_citizen_security_search(text, integer, integer, text) to authenticated;
grant execute on function public.qoc_citizen_security_open_profile(uuid, text) to authenticated;
grant execute on function public.qoc_citizen_security_conversations(uuid, text, boolean, boolean, timestamptz, timestamptz, integer, integer, text) to authenticated;
grant execute on function public.qoc_citizen_security_conversation(uuid, bigint, text, timestamptz, timestamptz, text, boolean, integer, integer, text) to authenticated;
grant execute on function public.qoc_citizen_security_location_timeline(uuid, timestamptz, timestamptz, text[], boolean, text) to authenticated;
grant execute on function public.qoc_citizen_security_media(uuid, text, integer, integer, text) to authenticated;
grant execute on function public.qoc_citizen_security_open_media(uuid, text, text) to authenticated;
grant execute on function public.qoc_citizen_security_audit(uuid, text, integer, integer, text) to authenticated;
