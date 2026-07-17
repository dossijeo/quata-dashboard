create or replace function public.qoc_media_library_v2(
  p_library text,
  p_query text default null,
  p_kind text default 'all',
  p_page integer default 1,
  p_page_size integer default 24
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_page integer := greatest(1, coalesce(p_page, 1));
  v_size integer := greatest(1, least(coalesce(p_page_size, 24), 60));
  v_query text := nullif(btrim(p_query), '');
  v_kind text := coalesce(nullif(lower(btrim(p_kind)), ''), 'all');
  v_library text := coalesce(nullif(lower(btrim(p_library)), ''), 'chat');
begin
  if not public.qoc_is_authorized() then
    raise exception 'qoc_access_denied' using errcode = '42501';
  end if;

  return (with media_rows as (
    select
      'chat:' || a.id::text as id,
      coalesce(a.file_name, 'Archivo sin nombre') as name,
      coalesce(a.mime_type, 'application/octet-stream') as mime_type,
      a.size_bytes,
      a.file_url as url,
      coalesce(a.thumb->>'url', a.thumb->>'publicUrl', a.thumb->>'thumbnail_url') as thumbnail_url,
      case
        when coalesce(a.mime_type, '') like 'image/%' then 'image'
        when coalesce(a.mime_type, '') like 'video/%' then 'video'
        when coalesce(a.mime_type, '') like 'audio/%' then 'audio'
        when lower(coalesce(a.ext, '')) in ('pdf','doc','docx','xls','xlsx','ppt','pptx','txt','csv','rtf','odt','ods','odp') then 'document'
        else 'file'
      end as kind,
      lower(coalesce(a.ext, split_part(a.file_name, '.', array_length(string_to_array(a.file_name, '.'), 1)), '')) as extension,
      a.created_at,
      a.thread_id::text as thread_id,
      a.message_id::text as message_id,
      coalesce(p.display_name, p.nombre, 'Usuario de Qüata') as author,
      coalesce(p.avatar_url, p.avatar) as author_avatar_url,
      'chat' as library
    from public.chat_attachments a
    left join public.community_profiles p on p.id = a.uploaded_by_profile_id

    union all

    select
      'community-image:' || cp.id::text,
      'Imagen de publicación',
      'image/*', null, cp.image_url, cp.image_url, 'image',
      lower(coalesce(nullif(split_part(split_part(cp.image_url, '?', 1), '.', array_length(string_to_array(split_part(cp.image_url, '?', 1), '.'), 1)), ''), 'image')),
      cp.created_at, null, null,
      coalesce(p.display_name, p.nombre, 'Usuario de Qüata'), coalesce(p.avatar_url, p.avatar), 'post_images'
    from public.community_posts cp
    left join public.community_profiles p on p.id = coalesce(cp.profile_id, cp.author_id)
    where nullif(btrim(cp.image_url), '') is not null

    union all

    select
      'official-image:' || op.id::text,
      coalesce(nullif(op.title, ''), 'Imagen de publicación oficial'),
      'image/*', null, op.media_url, op.media_url, 'image',
      lower(coalesce(nullif(split_part(split_part(op.media_url, '?', 1), '.', array_length(string_to_array(split_part(op.media_url, '?', 1), '.'), 1)), ''), 'image')),
      coalesce(op.published_at, op.created_at), null, null,
      coalesce(p.display_name, p.nombre, 'Cuenta oficial'), coalesce(p.avatar_url, p.avatar), 'post_images'
    from public.official_posts op
    left join public.community_profiles p on p.id = op.profile_id
    where op.deleted_at is null and op.is_published and lower(coalesce(op.media_type, '')) = 'image' and nullif(btrim(op.media_url), '') is not null

    union all

    select
      'community-video:' || cp.id::text,
      coalesce(nullif(btrim(split_part(split_part(coalesce(cp.body, cp.content, ''), '[MEDIA_TITULO:', 2), ']', 1)), ''), 'Vídeo de publicación'),
      'video/*', null, cp.video_url, null, 'video',
      lower(coalesce(nullif(split_part(split_part(cp.video_url, '?', 1), '.', array_length(string_to_array(split_part(cp.video_url, '?', 1), '.'), 1)), ''), 'video')),
      cp.created_at, null, null,
      coalesce(p.display_name, p.nombre, 'Usuario de Qüata'), coalesce(p.avatar_url, p.avatar), 'post_videos'
    from public.community_posts cp
    left join public.community_profiles p on p.id = coalesce(cp.profile_id, cp.author_id)
    where nullif(btrim(cp.video_url), '') is not null

    union all

    select
      'official-video:' || op.id::text,
      coalesce(nullif(op.title, ''), 'Vídeo de publicación oficial'),
      'video/*', null, op.media_url, null, 'video',
      lower(coalesce(nullif(split_part(split_part(op.media_url, '?', 1), '.', array_length(string_to_array(split_part(op.media_url, '?', 1), '.'), 1)), ''), 'video')),
      coalesce(op.published_at, op.created_at), null, null,
      coalesce(p.display_name, p.nombre, 'Cuenta oficial'), coalesce(p.avatar_url, p.avatar), 'post_videos'
    from public.official_posts op
    left join public.community_profiles p on p.id = op.profile_id
    where op.deleted_at is null and op.is_published and lower(coalesce(op.media_type, '')) = 'video' and nullif(btrim(op.media_url), '') is not null
  ), listed as (
    select * from media_rows
    where library = v_library
      and (v_query is null or concat_ws(' ', name, mime_type, extension, author) ilike '%' || v_query || '%')
      and (v_library <> 'chat' or v_kind = 'all' or kind = v_kind)
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(row_data) from (
      select jsonb_build_object(
        'id', id, 'name', name, 'mimeType', mime_type, 'sizeBytes', size_bytes,
        'url', url, 'thumbnailUrl', thumbnail_url, 'kind', kind, 'extension', extension,
        'createdAt', created_at, 'threadId', thread_id, 'messageId', message_id,
        'author', author, 'authorAvatarUrl', author_avatar_url, 'library', library
      ) as row_data
      from listed
      order by created_at desc nulls last
      offset (v_page - 1) * v_size limit v_size
    ) paged), '[]'::jsonb),
    'total', (select count(*) from listed), 'page', v_page, 'pageSize', v_size
  ));
end;
$$;
