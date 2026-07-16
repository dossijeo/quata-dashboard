create or replace function public.qoc_official_posts_filtered(
  p_query text default null,
  p_status text default 'all',
  p_post_type text default 'all',
  p_language text default 'all',
  p_page integer default 1,
  p_page_size integer default 20
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_page integer := greatest(1, coalesce(p_page, 1));
  v_size integer := greatest(1, least(coalesce(p_page_size, 20), 50));
  v_query text := nullif(btrim(p_query), '');
  v_status text := coalesce(nullif(btrim(p_status), ''), 'all');
  v_type text := coalesce(nullif(btrim(p_post_type), ''), 'all');
  v_language text := coalesce(nullif(lower(btrim(p_language)), ''), 'all');
  v_total integer;
begin
  if not public.qoc_is_authorized() then raise exception 'qoc_access_denied' using errcode = '42501'; end if;

  select count(*) into v_total
  from public.official_posts o left join public.community_profiles p on p.id = o.profile_id
  where (v_query is null or concat_ws(' ', o.title, o.summary, p.display_name, p.nombre) ilike '%' || v_query || '%')
    and (v_type = 'all' or o.post_type = v_type)
    and (v_language = 'all' or lower(coalesce(o.language, 'es')) = v_language)
    and (v_status = 'all' or case when o.deleted_at is not null then 'deleted' else 'published' end = v_status);

  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(row_data) from (
      select jsonb_build_object(
        'id', o.id, 'profileId', o.profile_id, 'title', o.title, 'summary', o.summary,
        'contentHtml', o.content_html, 'type', o.post_type,
        'status', case when o.deleted_at is not null then 'deleted' else 'published' end,
        'language', coalesce(lower(o.language), 'es'), 'mediaUrl', o.media_url, 'mediaType', o.media_type,
        'linkUrl', o.link_url, 'isLive', o.is_live, 'publishedAt', coalesce(o.published_at, o.created_at),
        'author', coalesce(p.display_name, p.nombre, 'Cuenta oficial'),
        'authorAvatarUrl', coalesce(p.avatar_url, p.avatar),
        'territory', coalesce(nullif(p.neighborhood, ''), nullif(p.barrio, ''), 'Ámbito nacional')
      ) row_data
      from public.official_posts o left join public.community_profiles p on p.id = o.profile_id
      where (v_query is null or concat_ws(' ', o.title, o.summary, p.display_name, p.nombre) ilike '%' || v_query || '%')
        and (v_type = 'all' or o.post_type = v_type)
        and (v_language = 'all' or lower(coalesce(o.language, 'es')) = v_language)
        and (v_status = 'all' or case when o.deleted_at is not null then 'deleted' else 'published' end = v_status)
      order by coalesce(o.published_at, o.created_at) desc
      offset (v_page - 1) * v_size limit v_size
    ) listed), '[]'::jsonb),
    'total', v_total, 'page', v_page, 'pageSize', v_size
  );
end;
$$;

grant execute on function public.qoc_official_posts_filtered(text,text,text,text,integer,integer) to authenticated;
