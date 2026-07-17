create or replace function public.qoc_media_library(
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
  v_total integer;
begin
  if not public.qoc_is_authorized() then raise exception 'qoc_access_denied' using errcode = '42501'; end if;

  with listed as (
    select a.*, case
      when coalesce(a.mime_type, '') like 'image/%' then 'image'
      when coalesce(a.mime_type, '') like 'video/%' then 'video'
      when coalesce(a.mime_type, '') like 'audio/%' then 'audio'
      when lower(coalesce(a.ext, '')) in ('pdf','doc','docx','xls','xlsx','ppt','pptx','txt','csv','rtf','odt','ods','odp') then 'document'
      else 'file'
    end as kind
    from public.chat_attachments a
    where v_query is null or concat_ws(' ', a.file_name, a.mime_type, a.ext) ilike '%' || v_query || '%'
  ) select count(*) into v_total from listed where v_kind = 'all' or kind = v_kind;

  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(item_data) from (
      select jsonb_build_object(
        'id', a.id,
        'name', coalesce(a.file_name, 'Archivo sin nombre'),
        'mimeType', coalesce(a.mime_type, 'application/octet-stream'),
        'sizeBytes', a.size_bytes,
        'url', a.file_url,
        'thumbnailUrl', coalesce(a.thumb->>'url', a.thumb->>'publicUrl', a.thumb->>'thumbnail_url'),
        'kind', case
          when coalesce(a.mime_type, '') like 'image/%' then 'image'
          when coalesce(a.mime_type, '') like 'video/%' then 'video'
          when coalesce(a.mime_type, '') like 'audio/%' then 'audio'
          when lower(coalesce(a.ext, '')) in ('pdf','doc','docx','xls','xlsx','ppt','pptx','txt','csv','rtf','odt','ods','odp') then 'document'
          else 'file'
        end,
        'extension', lower(coalesce(a.ext, split_part(a.file_name, '.', array_length(string_to_array(a.file_name, '.'), 1)), '')),
        'createdAt', a.created_at,
        'threadId', a.thread_id,
        'messageId', a.message_id,
        'author', coalesce(p.display_name, p.nombre, 'Usuario de Qüata'),
        'authorAvatarUrl', coalesce(p.avatar_url, p.avatar)
      ) as item_data
      from public.chat_attachments a
      left join public.community_profiles p on p.id = a.uploaded_by_profile_id
      where (v_query is null or concat_ws(' ', a.file_name, a.mime_type, a.ext) ilike '%' || v_query || '%')
        and (v_kind = 'all' or case
          when coalesce(a.mime_type, '') like 'image/%' then 'image'
          when coalesce(a.mime_type, '') like 'video/%' then 'video'
          when coalesce(a.mime_type, '') like 'audio/%' then 'audio'
          when lower(coalesce(a.ext, '')) in ('pdf','doc','docx','xls','xlsx','ppt','pptx','txt','csv','rtf','odt','ods','odp') then 'document'
          else 'file'
        end = v_kind)
      order by a.created_at desc
      offset (v_page - 1) * v_size limit v_size
    ) rows), '[]'::jsonb),
    'total', v_total, 'page', v_page, 'pageSize', v_size
  );
end;
$$;
