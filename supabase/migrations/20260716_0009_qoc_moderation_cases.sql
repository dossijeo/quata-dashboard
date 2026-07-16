-- Operational moderation: inspect the reported object and apply auditable decisions.

create or replace function public.qoc_moderation_report_detail(p_report_id bigint)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_report public.ugc_reports%rowtype;
  v_target jsonb := null;
  v_reporter jsonb := null;
  v_reported jsonb := null;
begin
  if not public.qoc_has_capability('moderation.reports.read') then
    raise exception 'qoc_capability_denied' using errcode = '42501';
  end if;

  select * into v_report from public.ugc_reports where id = p_report_id;
  if v_report.id is null then raise exception 'qoc_report_not_found'; end if;

  select jsonb_build_object('id', p.id, 'name', coalesce(p.display_name, p.nombre), 'avatarUrl', coalesce(p.avatar_url, p.avatar))
    into v_reporter from public.community_profiles p where p.id = v_report.reporter_profile_id;
  select jsonb_build_object('id', p.id, 'name', coalesce(p.display_name, p.nombre), 'avatarUrl', coalesce(p.avatar_url, p.avatar))
    into v_reported from public.community_profiles p where p.id = v_report.reported_profile_id;

  case v_report.target_type
    when 'community_post' then
      select jsonb_build_object(
        'exists', true, 'type', v_report.target_type, 'id', p.id, 'body', coalesce(nullif(p.content, ''), p.body, ''),
        'mediaUrl', coalesce(p.video_url, p.image_url), 'mediaType', case when p.video_url is not null then 'video' when p.image_url is not null then 'image' end,
        'createdAt', p.created_at, 'author', jsonb_build_object('id', a.id, 'name', coalesce(a.display_name, a.nombre))
      ) into v_target from public.community_posts p left join public.community_profiles a on a.id = coalesce(p.profile_id, p.author_id)
      where p.id = v_report.target_id::uuid;
    when 'official_post' then
      select jsonb_build_object(
        'exists', true, 'type', v_report.target_type, 'id', p.id, 'title', p.title, 'body', coalesce(p.summary, p.content_html, ''),
        'mediaUrl', p.media_url, 'mediaType', p.media_type, 'createdAt', coalesce(p.published_at, p.created_at), 'removed', p.deleted_at is not null,
        'author', jsonb_build_object('id', a.id, 'name', coalesce(a.display_name, a.nombre))
      ) into v_target from public.official_posts p left join public.community_profiles a on a.id = p.profile_id
      where p.id = v_report.target_id::uuid;
    when 'community_comment' then
      select jsonb_build_object(
        'exists', true, 'type', v_report.target_type, 'id', c.id, 'body', c.body, 'createdAt', c.created_at,
        'author', jsonb_build_object('id', a.id, 'name', coalesce(a.display_name, a.nombre))
      ) into v_target from public.community_comments c left join public.community_profiles a on a.id = c.profile_id
      where c.id = v_report.target_id::uuid;
    when 'official_comment' then
      select jsonb_build_object(
        'exists', true, 'type', v_report.target_type, 'id', c.id, 'body', c.body, 'createdAt', c.created_at, 'removed', c.deleted_at is not null,
        'author', jsonb_build_object('id', a.id, 'name', coalesce(a.display_name, a.nombre))
      ) into v_target from public.official_post_comments c left join public.community_profiles a on a.id = c.profile_id
      where c.id = v_report.target_id::uuid;
    when 'chat_message' then
      select jsonb_build_object(
        'exists', true, 'type', v_report.target_type, 'id', m.id, 'body', coalesce(m.body, ''), 'createdAt', m.created_at, 'removed', m.deleted_at is not null,
        'attachments', coalesce((select jsonb_agg(jsonb_build_object('url', ca.file_url, 'name', ca.file_name, 'mimeType', ca.mime_type)) from public.chat_attachments ca where ca.message_id = m.id), '[]'::jsonb),
        'author', jsonb_build_object('id', a.id, 'name', coalesce(a.display_name, a.nombre))
      ) into v_target from public.chat_messages m left join public.community_profiles a on a.id = m.sender_profile_id
      where m.id = v_report.target_id::bigint;
    when 'profile' then
      select jsonb_build_object(
        'exists', true, 'type', v_report.target_type, 'id', p.id, 'body', coalesce(p.display_name, p.nombre, ''), 'createdAt', p.created_at,
        'author', jsonb_build_object('id', p.id, 'name', coalesce(p.display_name, p.nombre), 'avatarUrl', coalesce(p.avatar_url, p.avatar))
      ) into v_target from public.community_profiles p where p.id = v_report.target_id::uuid;
  end case;

  return jsonb_build_object(
    'report', jsonb_build_object('id', v_report.id, 'targetType', v_report.target_type, 'targetId', v_report.target_id, 'details', v_report.details, 'status', v_report.status, 'createdAt', v_report.created_at, 'reviewedAt', v_report.reviewed_at),
    'reporter', v_reporter, 'reportedProfile', v_reported,
    'target', coalesce(v_target, jsonb_build_object('exists', false, 'type', v_report.target_type, 'id', v_report.target_id))
  );
end;
$$;

create or replace function public.qoc_moderation_decide(
  p_report_id bigint,
  p_decision text,
  p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_report public.ugc_reports%rowtype;
  v_before jsonb;
  v_result jsonb;
  v_removed boolean := false;
begin
  if not public.qoc_has_capability('moderation.reports.read') then
    raise exception 'qoc_capability_denied' using errcode = '42501';
  end if;
  if p_decision not in ('reviewing', 'dismiss', 'remove_content') then raise exception 'qoc_invalid_moderation_decision'; end if;

  select * into v_report from public.ugc_reports where id = p_report_id for update;
  if v_report.id is null then raise exception 'qoc_report_not_found'; end if;
  v_before := to_jsonb(v_report);

  if p_decision = 'remove_content' then
    case v_report.target_type
      when 'community_post' then delete from public.community_posts where id = v_report.target_id::uuid; v_removed := found;
      when 'official_post' then update public.official_posts set deleted_at = now(), updated_at = now() where id = v_report.target_id::uuid and deleted_at is null; v_removed := found;
      when 'community_comment' then delete from public.community_comments where id = v_report.target_id::uuid; v_removed := found;
      when 'official_comment' then update public.official_post_comments set deleted_at = now(), updated_at = now() where id = v_report.target_id::uuid and deleted_at is null; v_removed := found;
      when 'chat_message' then update public.chat_messages set deleted_at = now(), deleted_by_profile_id = public.qoc_current_profile_id() where id = v_report.target_id::bigint and deleted_at is null; v_removed := found;
      when 'profile' then raise exception 'qoc_profile_removal_not_supported';
    end case;
  end if;

  update public.ugc_reports
    set status = case p_decision when 'reviewing' then 'reviewing' when 'dismiss' then 'dismissed' else 'actioned' end,
        reviewed_at = now(), reviewed_by = public.qoc_current_profile_id()
    where id = p_report_id
    returning to_jsonb(public.ugc_reports.*) into v_result;

  perform public.qoc_write_audit(
    'moderation.' || p_decision, 'ugc_report', p_report_id::text, v_before,
    jsonb_build_object('report', v_result, 'contentRemoved', v_removed), nullif(btrim(p_note), '')
  );
  return jsonb_build_object('report', v_result, 'contentRemoved', v_removed);
end;
$$;

grant execute on function public.qoc_moderation_report_detail(bigint) to authenticated;
grant execute on function public.qoc_moderation_decide(bigint,text,text) to authenticated;
