-- A verified official account may use the editorial workspace without becoming
-- an operations administrator. Administrative QOC access stays unchanged.

create or replace function public.qoc_is_editorial_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from public.community_profiles p
    where p.id = public.qoc_current_profile_id() and p.is_official = true
  )
$$;

create or replace function public.qoc_session()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_profile public.community_profiles%rowtype;
begin
  select * into v_profile from public.community_profiles where id = public.qoc_current_profile_id();
  if v_profile.id is null or (not public.qoc_is_authorized() and not public.qoc_is_editorial_user()) then
    raise exception 'qoc_access_denied' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'profile', jsonb_build_object(
      'id', v_profile.id,
      'displayName', coalesce(v_profile.display_name, v_profile.nombre),
      'avatarUrl', coalesce(v_profile.avatar_url, v_profile.avatar),
      'territory', coalesce(nullif(v_profile.neighborhood, ''), nullif(v_profile.barrio, ''), 'Ámbito nacional'),
      'isAdmin', v_profile.is_admin,
      'isOfficial', v_profile.is_official
    ),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object('key', r.role_key, 'scopeType', r.scope_type, 'scopeId', r.scope_id, 'permissions', r.permissions))
      from public.qoc_user_roles r
      where r.profile_id = v_profile.id and r.active
    ), '[]'::jsonb)
  );
end;
$$;

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
  v_profile_id uuid := public.qoc_current_profile_id();
  v_is_operator boolean := public.qoc_is_authorized();
  v_total integer;
begin
  if not v_is_operator and not public.qoc_is_editorial_user() then
    raise exception 'qoc_access_denied' using errcode = '42501';
  end if;

  with groups as (
    select coalesce(o.translation_group_id, o.id) as group_id
    from public.official_posts o left join public.community_profiles p on p.id = o.profile_id
    where v_is_operator or o.profile_id = v_profile_id
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
        where v_is_operator or o.profile_id = v_profile_id
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

create or replace function public.qoc_official_posts_create_variants(
  p_profile_id uuid,
  p_posts jsonb
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_current uuid := public.qoc_current_profile_id();
  v_author uuid := coalesce(p_profile_id, v_current);
  v_is_operator boolean := public.qoc_is_authorized();
  v_group uuid := gen_random_uuid();
  v_post jsonb;
  v_created jsonb := '[]'::jsonb;
  v_row jsonb;
begin
  if not v_is_operator and not public.qoc_is_editorial_user() then
    raise exception 'qoc_access_denied' using errcode = '42501';
  end if;
  if not v_is_operator and v_author <> v_current then
    raise exception 'qoc_official_author_restricted' using errcode = '42501';
  end if;
  if not exists(select 1 from public.community_profiles where id = v_author and is_official) then
    raise exception 'qoc_official_account_required' using errcode = '23514';
  end if;
  if jsonb_typeof(p_posts) <> 'array' or jsonb_array_length(p_posts) = 0 then
    raise exception 'qoc_posts_required' using errcode = '22023';
  end if;

  for v_post in select value from jsonb_array_elements(p_posts)
  loop
    insert into public.official_posts(
      profile_id, title, summary, post_type, content_html, read_more_label,
      media_url, media_type, link_url, is_live, is_published, published_at,
      language, translation_group_id
    ) values (
      v_author, coalesce(nullif(v_post->>'title', ''), 'Comunicado sin título'),
      nullif(v_post->>'summary', ''), coalesce(nullif(v_post->>'postType', ''), 'announcement'),
      coalesce(v_post->>'contentHtml', ''), coalesce(nullif(v_post->>'readMoreLabel', ''), 'read_more'),
      nullif(v_post->>'mediaUrl', ''), nullif(v_post->>'mediaType', ''), nullif(v_post->>'linkUrl', ''),
      coalesce((v_post->>'isLive')::boolean, false), true, now(),
      coalesce(nullif(lower(v_post->>'language'), ''), 'es'), v_group
    ) returning to_jsonb(official_posts.*) into v_row;
    v_created := v_created || jsonb_build_array(v_row);
  end loop;

  perform public.qoc_write_audit('official.post.create', 'official_post_translation_group', v_group::text, null, v_created, null);
  return jsonb_build_object('translationGroupId', v_group, 'posts', v_created);
end;
$$;

create or replace function public.qoc_official_posts_delete_group(p_translation_group_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_current uuid := public.qoc_current_profile_id();
  v_is_operator boolean := public.qoc_is_authorized();
  v_before jsonb;
  v_after jsonb;
  v_count integer;
begin
  if not v_is_operator and not public.qoc_is_editorial_user() then
    raise exception 'qoc_access_denied' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(to_jsonb(o)), '[]'::jsonb) into v_before
  from public.official_posts o
  where coalesce(o.translation_group_id, o.id) = p_translation_group_id
    and o.deleted_at is null and (v_is_operator or o.profile_id = v_current);

  update public.official_posts o set deleted_at = now(), updated_at = now()
  where coalesce(o.translation_group_id, o.id) = p_translation_group_id
    and o.deleted_at is null and (v_is_operator or o.profile_id = v_current);
  get diagnostics v_count = row_count;
  if v_count = 0 then raise exception 'qoc_official_post_group_not_found_or_forbidden' using errcode = 'P0002'; end if;

  select coalesce(jsonb_agg(to_jsonb(o)), '[]'::jsonb) into v_after
  from public.official_posts o where coalesce(o.translation_group_id, o.id) = p_translation_group_id;
  perform public.qoc_write_audit('official.post.delete_group', 'official_post_translation_group', p_translation_group_id::text, v_before, v_after, 'Eliminación desde QOC');
  return jsonb_build_object('translationGroupId', p_translation_group_id, 'deletedCount', v_count);
end;
$$;

-- Approved editorial test account: Gabrielo (+240 680242607).
update public.community_profiles
set is_official = true
where regexp_replace(coalesce(phone_local, phone_e164, phone, ''), '\\D', '', 'g') = '680242607'
  and regexp_replace(coalesce(country_code, code, ''), '\\D', '', 'g') = '240';

grant execute on function public.qoc_is_editorial_user() to authenticated;
grant execute on function public.qoc_session() to authenticated;
grant execute on function public.qoc_official_posts_filtered(text,text,text,text,integer,integer) to authenticated;
grant execute on function public.qoc_official_posts_create_variants(uuid,jsonb) to authenticated;
grant execute on function public.qoc_official_posts_delete_group(uuid) to authenticated;
