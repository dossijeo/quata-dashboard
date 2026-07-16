-- Treat the localized variants of an official post as one operational unit in QOC.
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

  with groups as (
    select coalesce(o.translation_group_id, o.id) as group_id
    from public.official_posts o left join public.community_profiles p on p.id = o.profile_id
    group by coalesce(o.translation_group_id, o.id)
    having (v_query is null or bool_or(concat_ws(' ', o.title, o.summary, p.display_name, p.nombre) ilike '%' || v_query || '%'))
      and (v_type = 'all' or bool_or(o.post_type = v_type))
      and (v_language = 'all' or bool_or(lower(coalesce(o.language, 'es')) = v_language))
      and (v_status = 'all' or case when bool_or(o.deleted_at is null) then 'published' else 'deleted' end = v_status)
  ) select count(*) into v_total from groups;

  return jsonb_build_object(
    'items', coalesce((
      with groups as (
        select coalesce(o.translation_group_id, o.id) as group_id,
          max(coalesce(o.published_at, o.created_at)) as sort_at,
          array_agg(distinct lower(coalesce(o.language, 'es')) order by lower(coalesce(o.language, 'es'))) as languages,
          case when bool_or(o.deleted_at is null) then 'published' else 'deleted' end as status
        from public.official_posts o left join public.community_profiles p on p.id = o.profile_id
        group by coalesce(o.translation_group_id, o.id)
        having (v_query is null or bool_or(concat_ws(' ', o.title, o.summary, p.display_name, p.nombre) ilike '%' || v_query || '%'))
          and (v_type = 'all' or bool_or(o.post_type = v_type))
          and (v_language = 'all' or bool_or(lower(coalesce(o.language, 'es')) = v_language))
          and (v_status = 'all' or case when bool_or(o.deleted_at is null) then 'published' else 'deleted' end = v_status)
      ), paged as (
        select * from groups order by sort_at desc offset (v_page - 1) * v_size limit v_size
      )
      select coalesce(jsonb_agg(row_data order by sort_at desc), '[]'::jsonb)
      from (
        select paged.sort_at, jsonb_build_object(
          'id', representative.id, 'translationGroupId', paged.group_id, 'profileId', representative.profile_id,
          'title', representative.title, 'summary', representative.summary, 'contentHtml', representative.content_html,
          'type', representative.post_type, 'status', paged.status, 'languages', to_jsonb(paged.languages),
          'mediaUrl', representative.media_url, 'mediaType', representative.media_type, 'linkUrl', representative.link_url,
          'publishedAt', coalesce(representative.published_at, representative.created_at),
          'author', coalesce(profile.display_name, profile.nombre, 'Cuenta oficial'),
          'authorAvatarUrl', coalesce(profile.avatar_url, profile.avatar),
          'territory', coalesce(nullif(profile.neighborhood, ''), nullif(profile.barrio, ''), 'Ámbito nacional')
        ) as row_data
        from paged
        cross join lateral (
          select o.* from public.official_posts o
          where coalesce(o.translation_group_id, o.id) = paged.group_id
          order by case when v_language <> 'all' and lower(coalesce(o.language, 'es')) = v_language then 0 when lower(coalesce(o.language, 'es')) = 'es' then 1 else 2 end,
            coalesce(o.published_at, o.created_at) desc limit 1
        ) representative
        left join public.community_profiles profile on profile.id = representative.profile_id
      ) rows
    ), '[]'::jsonb),
    'total', v_total, 'page', v_page, 'pageSize', v_size
  );
end;
$$;
