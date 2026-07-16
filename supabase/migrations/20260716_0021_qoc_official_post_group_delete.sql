create or replace function public.qoc_official_posts_delete_group(p_translation_group_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_count integer;
begin
  if not public.qoc_has_capability('official.posts.delete') then raise exception 'qoc_capability_denied' using errcode = '42501'; end if;

  select coalesce(jsonb_agg(to_jsonb(o)), '[]'::jsonb) into v_before
  from public.official_posts o
  where coalesce(o.translation_group_id, o.id) = p_translation_group_id and o.deleted_at is null;

  update public.official_posts
  set deleted_at = now(), updated_at = now()
  where coalesce(translation_group_id, id) = p_translation_group_id and deleted_at is null;
  get diagnostics v_count = row_count;
  if v_count = 0 then raise exception 'qoc_official_post_group_not_found' using errcode = 'P0002'; end if;

  select coalesce(jsonb_agg(to_jsonb(o)), '[]'::jsonb) into v_after
  from public.official_posts o where coalesce(o.translation_group_id, o.id) = p_translation_group_id;
  perform public.qoc_write_audit('official.post.delete_group', 'official_post_translation_group', p_translation_group_id::text, v_before, v_after, 'Eliminación de todas las variantes lingüísticas desde QOC');
  return jsonb_build_object('translationGroupId', p_translation_group_id, 'deletedCount', v_count);
end;
$$;
