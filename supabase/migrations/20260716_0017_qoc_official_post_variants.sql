create or replace function public.qoc_official_posts_create_variants(
  p_profile_id uuid,
  p_posts jsonb
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_author uuid := coalesce(p_profile_id, public.qoc_current_profile_id());
  v_group uuid := gen_random_uuid();
  v_post jsonb;
  v_created jsonb := '[]'::jsonb;
  v_row jsonb;
begin
  if not public.qoc_is_authorized() or not public.qoc_has_capability('official.posts.create') then
    raise exception 'qoc_access_denied' using errcode = '42501';
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
      v_author,
      coalesce(nullif(v_post->>'title', ''), 'Comunicado sin título'),
      nullif(v_post->>'summary', ''),
      coalesce(nullif(v_post->>'postType', ''), 'announcement'),
      coalesce(v_post->>'contentHtml', ''),
      coalesce(nullif(v_post->>'readMoreLabel', ''), 'read_more'),
      nullif(v_post->>'mediaUrl', ''),
      nullif(v_post->>'mediaType', ''),
      nullif(v_post->>'linkUrl', ''),
      coalesce((v_post->>'isLive')::boolean, false),
      true, now(),
      coalesce(nullif(lower(v_post->>'language'), ''), 'es'),
      v_group
    ) returning to_jsonb(official_posts.*) into v_row;
    v_created := v_created || jsonb_build_array(v_row);
  end loop;

  perform public.qoc_write_audit('official.post.create', 'official_post_translation_group', v_group::text, null, v_created, null);
  return jsonb_build_object('translationGroupId', v_group, 'posts', v_created);
end;
$$;

grant execute on function public.qoc_official_posts_create_variants(uuid,jsonb) to authenticated;
