create or replace function public.qoc_audit_events(
  p_query text default null,
  p_action text default 'all',
  p_entity_type text default 'all',
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
  v_page_size integer := greatest(1, least(coalesce(p_page_size, 20), 100));
  v_offset integer;
begin
  if not public.qoc_is_authorized() then
    raise exception 'qoc_access_denied' using errcode = '42501';
  end if;

  v_offset := (v_page - 1) * v_page_size;

  return (
    with filtered as (
      select a.id,
             a.action_key,
             a.entity_type,
             a.entity_id,
             a.reason,
             a.created_at,
             coalesce(p.display_name, p.nombre, 'Sistema') as actor
      from public.qoc_audit_log a
      left join public.community_profiles p on p.id = a.actor_profile_id
      where (coalesce(p_action, 'all') = 'all' or a.action_key = p_action)
        and (coalesce(p_entity_type, 'all') = 'all' or a.entity_type = p_entity_type)
        and (
          nullif(trim(coalesce(p_query, '')), '') is null
          or concat_ws(' ', a.action_key, a.entity_type, a.entity_id, a.reason, coalesce(p.display_name, p.nombre, 'Sistema')) ilike '%' || trim(p_query) || '%'
        )
    )
    select jsonb_build_object(
      'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id,
        'action', action_key,
        'entityType', entity_type,
        'entityId', entity_id,
        'reason', reason,
        'createdAt', created_at,
        'actor', actor
      ) order by created_at desc) from (select * from filtered order by created_at desc offset v_offset limit v_page_size) page_rows), '[]'::jsonb),
      'total', (select count(*) from filtered),
      'page', v_page,
      'pageSize', v_page_size,
      'filters', jsonb_build_object(
        'actions', coalesce((select jsonb_agg(action_key order by action_key) from (select distinct action_key from public.qoc_audit_log) action_values), '[]'::jsonb),
        'entityTypes', coalesce((select jsonb_agg(entity_type order by entity_type) from (select distinct entity_type from public.qoc_audit_log) entity_values), '[]'::jsonb)
      )
    )
  );
end;
$$;

revoke all on function public.qoc_audit_events(text, text, text, integer, integer) from public;
grant execute on function public.qoc_audit_events(text, text, text, integer, integer) to authenticated;
