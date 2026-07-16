-- Paginated QOC read models for official-account operations.

create or replace function public.qoc_official_profiles(
  p_query text default null,
  p_territory text default 'all',
  p_account_type text default 'all',
  p_page integer default 1,
  p_page_size integer default 20
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_page integer := greatest(1, coalesce(p_page, 1));
  v_size integer := greatest(1, least(coalesce(p_page_size, 20), 50));
  v_query text := nullif(btrim(p_query), '');
  v_territory text := coalesce(nullif(btrim(p_territory), ''), 'all');
  v_type text := coalesce(nullif(btrim(p_account_type), ''), 'all');
  v_total integer;
begin
  if not public.qoc_is_authorized() then raise exception 'qoc_access_denied' using errcode = '42501'; end if;

  select count(*) into v_total
  from public.community_profiles p
  where (v_query is null or concat_ws(' ', p.display_name, p.nombre, p.neighborhood, p.barrio) ilike '%' || v_query || '%')
    and (v_territory = 'all' or coalesce(nullif(p.neighborhood, ''), nullif(p.barrio, ''), 'Sin barrio') = v_territory)
    and case v_type
      when 'official' then p.is_official
      when 'admin' then p.is_admin
      when 'official_admin' then p.is_official and p.is_admin
      when 'standard' then not p.is_official and not p.is_admin
      else true
    end;

  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(row_data) from (
      select jsonb_build_object(
        'id', p.id,
        'name', coalesce(p.display_name, p.nombre, 'Cuenta sin nombre'),
        'avatarUrl', coalesce(p.avatar_url, p.avatar),
        'territory', coalesce(nullif(p.neighborhood, ''), nullif(p.barrio, ''), 'Sin barrio'),
        'isOfficial', p.is_official,
        'isAdmin', p.is_admin,
        'followers', coalesce(p.followers_count, 0),
        'following', coalesce(p.following_count, 0),
        'joinedAt', p.created_at,
        'lastLoginAt', p.last_login_at
      ) as row_data
      from public.community_profiles p
      where (v_query is null or concat_ws(' ', p.display_name, p.nombre, p.neighborhood, p.barrio) ilike '%' || v_query || '%')
        and (v_territory = 'all' or coalesce(nullif(p.neighborhood, ''), nullif(p.barrio, ''), 'Sin barrio') = v_territory)
        and case v_type
          when 'official' then p.is_official
          when 'admin' then p.is_admin
          when 'official_admin' then p.is_official and p.is_admin
          when 'standard' then not p.is_official and not p.is_admin
          else true
        end
      order by p.is_official desc, p.is_admin desc, coalesce(p.display_name, p.nombre, '') asc
      offset (v_page - 1) * v_size limit v_size
    ) listed), '[]'::jsonb),
    'territories', coalesce((select jsonb_agg(territory order by territory) from (
      select distinct coalesce(nullif(neighborhood, ''), nullif(barrio, ''), 'Sin barrio') as territory
      from public.community_profiles
    ) territories), '[]'::jsonb),
    'total', v_total,
    'page', v_page,
    'pageSize', v_size
  );
end;
$$;

create or replace function public.qoc_official_posts(
  p_query text default null,
  p_status text default 'all',
  p_post_type text default 'all',
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
  v_total integer;
begin
  if not public.qoc_is_authorized() then raise exception 'qoc_access_denied' using errcode = '42501'; end if;

  select count(*) into v_total
  from public.official_posts o
  left join public.community_profiles p on p.id = o.profile_id
  where (v_query is null or concat_ws(' ', o.title, o.summary, p.display_name, p.nombre) ilike '%' || v_query || '%')
    and (v_type = 'all' or o.post_type = v_type)
    and (v_status = 'all' or case when o.deleted_at is not null then 'deleted' when o.is_published then 'published' else 'draft' end = v_status);

  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(row_data) from (
      select jsonb_build_object(
        'id', o.id,
        'profileId', o.profile_id,
        'title', o.title,
        'summary', o.summary,
        'contentHtml', o.content_html,
        'type', o.post_type,
        'status', case when o.deleted_at is not null then 'deleted' when o.is_published then 'published' else 'draft' end,
        'language', o.language,
        'mediaUrl', o.media_url,
        'mediaType', o.media_type,
        'linkUrl', o.link_url,
        'isLive', o.is_live,
        'publishedAt', coalesce(o.published_at, o.created_at),
        'author', coalesce(p.display_name, p.nombre, 'Cuenta oficial'),
        'authorAvatarUrl', coalesce(p.avatar_url, p.avatar),
        'territory', coalesce(nullif(p.neighborhood, ''), nullif(p.barrio, ''), 'Ámbito nacional')
      ) as row_data
      from public.official_posts o
      left join public.community_profiles p on p.id = o.profile_id
      where (v_query is null or concat_ws(' ', o.title, o.summary, p.display_name, p.nombre) ilike '%' || v_query || '%')
        and (v_type = 'all' or o.post_type = v_type)
        and (v_status = 'all' or case when o.deleted_at is not null then 'deleted' when o.is_published then 'published' else 'draft' end = v_status)
      order by coalesce(o.published_at, o.created_at) desc
      offset (v_page - 1) * v_size limit v_size
    ) listed), '[]'::jsonb),
    'total', v_total,
    'page', v_page,
    'pageSize', v_size
  );
end;
$$;

grant execute on function public.qoc_official_profiles(text,text,text,integer,integer) to authenticated;
grant execute on function public.qoc_official_posts(text,text,text,integer,integer) to authenticated;
