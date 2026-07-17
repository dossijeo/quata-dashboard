create or replace function public.qoc_communities(
  p_query text default null,
  p_status text default 'all',
  p_activity text default 'all',
  p_page integer default 1,
  p_page_size integer default 20
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_page integer := greatest(1, coalesce(p_page, 1));
  v_size integer := greatest(1, least(coalesce(p_page_size, 20), 60));
  v_query text := nullif(btrim(p_query), '');
  v_status text := coalesce(nullif(lower(btrim(p_status)), ''), 'all');
  v_activity text := coalesce(nullif(lower(btrim(p_activity)), ''), 'all');
begin
  if not public.qoc_is_authorized() then
    raise exception 'qoc_access_denied' using errcode = '42501';
  end if;

  return (
    with listed as (
      select
        w.id, w.name, w.city, w.description, w.is_active, w.created_at,
        (select count(*) from public.community_members m where m.wall_id = w.id) as member_count,
        (select count(*) from public.community_posts p where p.wall_id = w.id) as post_count,
        (select max(p.created_at) from public.community_posts p where p.wall_id = w.id) as last_post_at
      from public.community_walls w
    ), filtered as (
      select * from listed
      where (v_query is null or concat_ws(' ', name, city, description) ilike '%' || v_query || '%')
        and (v_status = 'all' or (v_status = 'active' and is_active) or (v_status = 'inactive' and not is_active))
        and (v_activity = 'all'
          or (v_activity = 'recent' and last_post_at >= now() - interval '30 days')
          or (v_activity = 'quiet' and (last_post_at is null or last_post_at < now() - interval '30 days')))
    )
    select jsonb_build_object(
      'items', coalesce((select jsonb_agg(row_data) from (
        select jsonb_build_object(
          'id', id, 'name', name, 'city', city, 'description', description,
          'isActive', is_active, 'createdAt', created_at, 'memberCount', member_count,
          'postCount', post_count, 'lastPostAt', last_post_at
        ) as row_data
        from filtered
        order by is_active desc, member_count desc, name asc
        offset (v_page - 1) * v_size limit v_size
      ) paged), '[]'::jsonb),
      'total', (select count(*) from filtered), 'page', v_page, 'pageSize', v_size
    )
  );
end;
$$;
