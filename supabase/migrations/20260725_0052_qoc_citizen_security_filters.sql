drop function if exists public.qoc_citizen_security_media(uuid, text, integer, integer, text);

create or replace function public.qoc_citizen_security_media(
  p_target_user_id uuid,
  p_origin text default 'ALL',
  p_media_kind text default 'ALL',
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_page integer default 1,
  p_page_size integer default 24,
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
  v_page_size integer := greatest(1, least(coalesce(p_page_size, 24), 50));
  v_items jsonb;
  v_total bigint;
  v_request_id uuid;
begin
  with media as (
    select
      'chat:' || a.id::text as media_id,
      'CHAT'::text as origin,
      a.message_id::text as origin_resource_id,
      coalesce(nullif(a.mime_type, ''), 'application/octet-stream') as mime_type,
      coalesce(nullif(a.file_name, ''), 'Archivo de chat') as file_name,
      a.size_bytes,
      coalesce(a.attached_at, a.created_at) as uploaded_at,
      'NOT_ANALYZED'::text as analysis_status
    from public.chat_attachments a
    where a.thread_id in (
      select c.conversation_id
      from security_citizen.v_conversations c
      where c.target_user_id = p_target_user_id
    )
    union all
    select
      'community:' || p.id::text,
      'POST',
      p.id::text,
      case when nullif(p.video_url, '') is not null then 'video/*' else 'image/*' end,
      'Archivo de publicacion',
      null,
      p.created_at,
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
      'Archivo de publicacion oficial',
      null,
      p.created_at,
      'NOT_ANALYZED'
    from public.official_posts p
    where p.profile_id = p_target_user_id
      and p.deleted_at is null
      and nullif(p.media_url, '') is not null
  ), classified as (
    select
      media.*,
      case
        when lower(mime_type) like 'image/%' then 'IMAGE'
        when lower(mime_type) like 'video/%' then 'VIDEO'
        when lower(mime_type) like 'audio/%' then 'AUDIO'
        when lower(mime_type) = 'application/pdf'
          or lower(mime_type) like '%word%'
          or lower(mime_type) like '%document%'
          or lower(mime_type) like '%sheet%'
          or lower(mime_type) like '%excel%'
          or lower(mime_type) like '%presentation%'
          or lower(mime_type) like '%powerpoint%'
          or lower(mime_type) like 'text/%'
        then 'DOCUMENT'
        else 'FILE'
      end as media_kind
    from media
  ), filtered as (
    select *
    from classified
    where (upper(coalesce(p_origin, 'ALL')) = 'ALL' or origin = upper(p_origin))
      and (upper(coalesce(p_media_kind, 'ALL')) = 'ALL' or media_kind = upper(p_media_kind))
      and (p_date_from is null or uploaded_at >= p_date_from)
      and (p_date_to is null or uploaded_at <= p_date_to)
  )
  select count(*) into v_total from filtered;

  with media as (
    select
      'chat:' || a.id::text as media_id,
      'CHAT'::text as origin,
      a.message_id::text as origin_resource_id,
      coalesce(nullif(a.mime_type, ''), 'application/octet-stream') as mime_type,
      coalesce(nullif(a.file_name, ''), 'Archivo de chat') as file_name,
      a.size_bytes,
      coalesce(a.attached_at, a.created_at) as uploaded_at,
      'NOT_ANALYZED'::text as analysis_status
    from public.chat_attachments a
    where a.thread_id in (
      select c.conversation_id
      from security_citizen.v_conversations c
      where c.target_user_id = p_target_user_id
    )
    union all
    select
      'community:' || p.id::text, 'POST', p.id::text,
      case when nullif(p.video_url, '') is not null then 'video/*' else 'image/*' end,
      'Archivo de publicacion', null, p.created_at, 'NOT_ANALYZED'
    from public.community_posts p
    where coalesce(p.profile_id, p.author_id) = p_target_user_id
      and coalesce(nullif(p.image_url, ''), nullif(p.video_url, '')) is not null
    union all
    select
      'official:' || p.id::text, 'POST', p.id::text,
      coalesce(nullif(p.media_type, ''), 'application/octet-stream'),
      'Archivo de publicacion oficial', null, p.created_at, 'NOT_ANALYZED'
    from public.official_posts p
    where p.profile_id = p_target_user_id
      and p.deleted_at is null
      and nullif(p.media_url, '') is not null
  ), classified as (
    select
      media.*,
      case
        when lower(mime_type) like 'image/%' then 'IMAGE'
        when lower(mime_type) like 'video/%' then 'VIDEO'
        when lower(mime_type) like 'audio/%' then 'AUDIO'
        when lower(mime_type) = 'application/pdf'
          or lower(mime_type) like '%word%'
          or lower(mime_type) like '%document%'
          or lower(mime_type) like '%sheet%'
          or lower(mime_type) like '%excel%'
          or lower(mime_type) like '%presentation%'
          or lower(mime_type) like '%powerpoint%'
          or lower(mime_type) like 'text/%'
        then 'DOCUMENT'
        else 'FILE'
      end as media_kind
    from media
  ), filtered as (
    select *
    from classified
    where (upper(coalesce(p_origin, 'ALL')) = 'ALL' or origin = upper(p_origin))
      and (upper(coalesce(p_media_kind, 'ALL')) = 'ALL' or media_kind = upper(p_media_kind))
      and (p_date_from is null or uploaded_at >= p_date_from)
      and (p_date_to is null or uploaded_at <= p_date_to)
    order by uploaded_at desc
    offset (v_page - 1) * v_page_size
    limit v_page_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'mediaId', m.media_id,
    'origin', m.origin,
    'originResourceId', m.origin_resource_id,
    'mimeType', m.mime_type,
    'mediaKind', m.media_kind,
    'fileName', m.file_name,
    'uploadedAt', m.uploaded_at,
    'sizeBytes', m.size_bytes,
    'hasExif', false,
    'hasExifGps', false,
    'analysisStatus', m.analysis_status,
    'openRequiresAudit', true
  ) order by m.uploaded_at desc), '[]'::jsonb)
  into v_items
  from filtered m;

  v_request_id := security_citizen.log_access(
    'MEDIA_LIST_VIEW', 'MEDIA_OBJECT', null, p_target_user_id, p_reason,
    jsonb_build_object(
      'origin', p_origin,
      'mediaKind', p_media_kind,
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

drop function if exists public.qoc_citizen_security_audit(uuid, text, integer, integer, text);

create or replace function public.qoc_citizen_security_audit(
  p_target_user_id uuid default null,
  p_action text default null,
  p_person_query text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_page integer default 1,
  p_page_size integer default 25,
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
  v_page_size integer := greatest(1, least(coalesce(p_page_size, 25), 100));
  v_query text := nullif(trim(coalesce(p_person_query, '')), '');
  v_total bigint;
  v_items jsonb;
  v_request_id uuid;
begin
  select count(*) into v_total
  from security_citizen.access_audit_events e
  where (p_target_user_id is null or e.target_user_id = p_target_user_id)
    and (p_action is null or p_action = '' or e.action = p_action)
    and (p_date_from is null or e.occurred_at >= p_date_from)
    and (p_date_to is null or e.occurred_at <= p_date_to)
    and (
      v_query is null
      or e.actor_display_name ilike '%' || v_query || '%'
      or e.target_display_name ilike '%' || v_query || '%'
      or e.actor_user_id::text = v_query
      or e.target_user_id::text = v_query
    );

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
    select *
    from security_citizen.access_audit_events e
    where (p_target_user_id is null or e.target_user_id = p_target_user_id)
      and (p_action is null or p_action = '' or e.action = p_action)
      and (p_date_from is null or e.occurred_at >= p_date_from)
      and (p_date_to is null or e.occurred_at <= p_date_to)
      and (
        v_query is null
        or e.actor_display_name ilike '%' || v_query || '%'
        or e.target_display_name ilike '%' || v_query || '%'
        or e.actor_user_id::text = v_query
        or e.target_user_id::text = v_query
      )
    order by e.occurred_at desc
    offset (v_page - 1) * v_page_size
    limit v_page_size
  ) e;

  v_request_id := security_citizen.log_access(
    case when p_target_user_id is null then 'AUDIT_GLOBAL_VIEW' else 'AUDIT_PROFILE_VIEW' end,
    'AUDIT_LOG', null, p_target_user_id, p_reason,
    jsonb_build_object(
      'action', p_action,
      'personQuery', case when v_query is null then null else '[FILTERED]' end,
      'dateFrom', p_date_from,
      'dateTo', p_date_to,
      'page', v_page
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

revoke all on function public.qoc_citizen_security_media(uuid, text, text, timestamptz, timestamptz, integer, integer, text) from public, anon;
revoke all on function public.qoc_citizen_security_audit(uuid, text, text, timestamptz, timestamptz, integer, integer, text) from public, anon;
grant execute on function public.qoc_citizen_security_media(uuid, text, text, timestamptz, timestamptz, integer, integer, text) to authenticated;
grant execute on function public.qoc_citizen_security_audit(uuid, text, text, timestamptz, timestamptz, integer, integer, text) to authenticated;
