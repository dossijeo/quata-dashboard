create or replace function public.qoc_moderation_reports(
  p_query text default null,
  p_status text default 'all',
  p_target_type text default 'all',
  p_page integer default 1,
  p_page_size integer default 20
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_page integer := greatest(1, coalesce(p_page, 1));
  v_size integer := greatest(1, least(coalesce(p_page_size, 20), 50));
  v_query text := nullif(btrim(p_query), '');
  v_total integer;
begin
  if not public.qoc_has_capability('moderation.reports.read') then
    raise exception 'qoc_capability_denied' using errcode = '42501';
  end if;

  select count(*) into v_total
  from public.ugc_reports r
  left join public.community_profiles reporter on reporter.id = r.reporter_profile_id
  left join public.community_profiles reported on reported.id = r.reported_profile_id
  where (coalesce(p_status, 'all') = 'all' or r.status = p_status)
    and (coalesce(p_target_type, 'all') = 'all' or r.target_type = p_target_type)
    and (v_query is null or concat_ws(' ', r.target_type, r.target_id, coalesce(reporter.display_name, reporter.nombre), coalesce(reported.display_name, reported.nombre)) ilike '%' || v_query || '%');

  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(x) from (
      select jsonb_build_object(
        'id', r.id, 'targetType', r.target_type, 'targetId', r.target_id,
        'status', r.status, 'createdAt', r.created_at,
        'reporter', coalesce(reporter.display_name, reporter.nombre),
        'reportedProfile', coalesce(reported.display_name, reported.nombre)
      ) x
      from public.ugc_reports r
      left join public.community_profiles reporter on reporter.id = r.reporter_profile_id
      left join public.community_profiles reported on reported.id = r.reported_profile_id
      where (coalesce(p_status, 'all') = 'all' or r.status = p_status)
        and (coalesce(p_target_type, 'all') = 'all' or r.target_type = p_target_type)
        and (v_query is null or concat_ws(' ', r.target_type, r.target_id, coalesce(reporter.display_name, reporter.nombre), coalesce(reported.display_name, reported.nombre)) ilike '%' || v_query || '%')
      order by r.created_at desc
      offset (v_page - 1) * v_size limit v_size
    ) rows), '[]'::jsonb),
    'total', v_total, 'page', v_page, 'pageSize', v_size
  );
end;
$$;

grant execute on function public.qoc_moderation_reports(text,text,text,integer,integer) to authenticated;
