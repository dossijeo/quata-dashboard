create or replace function public.qoc_moderation_full_content(p_report_id bigint)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_report public.ugc_reports%rowtype;
  v_result jsonb;
begin
  if not public.qoc_has_capability('moderation.reports.read') then
    raise exception 'qoc_capability_denied' using errcode = '42501';
  end if;
  select * into v_report from public.ugc_reports where id = p_report_id;
  if v_report.id is null then raise exception 'qoc_report_not_found'; end if;

  case v_report.target_type
    when 'official_post' then
      select jsonb_build_object(
        'title', p.title, 'contentHtml', coalesce(p.content_html, ''),
        'readMoreLabel', coalesce(p.read_more_label, 'read_more'), 'type', 'official_post'
      ) into v_result from public.official_posts p where p.id = v_report.target_id::uuid;
    when 'community_post' then
      select jsonb_build_object(
        'title', null, 'contentText', coalesce(nullif(p.content, ''), p.body, ''), 'type', 'community_post'
      ) into v_result from public.community_posts p where p.id = v_report.target_id::uuid;
    else
      raise exception 'qoc_full_content_not_supported';
  end case;
  if v_result is null then raise exception 'qoc_content_not_found'; end if;
  return v_result;
end;
$$;

grant execute on function public.qoc_moderation_full_content(bigint) to authenticated;
