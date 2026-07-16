-- Paginated, operator-only territory directory for the Operations Center.
create or replace function public.qoc_territories(
  p_query text default null,
  p_status text default 'all',
  p_activity text default 'all',
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_page integer := greatest(1, coalesce(p_page, 1));
  v_page_size integer := greatest(5, least(coalesce(p_page_size, 20), 50));
  v_query text := nullif(trim(p_query), '');
begin
  if not public.qoc_is_authorized() then
    raise exception 'qoc_access_denied' using errcode = '42501';
  end if;

  return (
    with territory_data as (
      select
        w.id,
        w.name,
        w.slug,
        w.city,
        w.is_active,
        w.created_at,
        (select count(*) from public.community_members m where m.wall_id = w.id) as member_count,
        (select count(*) from public.community_posts p where p.wall_id = w.id) as post_count
      from public.community_walls w
    ), filtered as (
      select *
      from territory_data t
      where (v_query is null or concat_ws(' ', t.name, t.slug, t.city) ilike '%' || v_query || '%')
        and (p_status = 'all' or (p_status = 'active' and t.is_active) or (p_status = 'inactive' and not t.is_active))
        and (p_activity = 'all' or (p_activity = 'with_activity' and t.post_count > 0) or (p_activity = 'without_activity' and t.post_count = 0))
    ), counted as (
      select count(*)::integer as total from filtered
    ), page_rows as (
      select * from filtered order by lower(name), id offset (v_page - 1) * v_page_size limit v_page_size
    )
    select jsonb_build_object(
      'total', (select total from counted),
      'page', v_page,
      'pageSize', v_page_size,
      'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id,
        'name', name,
        'slug', slug,
        'city', city,
        'isActive', is_active,
        'memberCount', member_count,
        'postCount', post_count,
        'createdAt', created_at
      ) order by lower(name), id) from page_rows), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public.qoc_territories(text, text, text, integer, integer) from public;
grant execute on function public.qoc_territories(text, text, text, integer, integer) to authenticated;
