-- Editorial commands for the QOC browser. These functions preserve the existing
-- official_posts data model consumed by Android.

create or replace function public.qoc_command(p_command text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id text; v_before jsonb; v_result jsonb; v_author uuid;
begin
  if not public.qoc_is_authorized() then raise exception 'qoc_access_denied' using errcode = '42501'; end if;
  case p_command
    when 'moderation.update' then
      if not public.qoc_has_capability('moderation.reports.read') then raise exception 'qoc_capability_denied' using errcode='42501'; end if;
      select to_jsonb(r) into v_before from ugc_reports r where r.id=(p_payload->>'id')::bigint;
      update ugc_reports set status=coalesce(p_payload->>'status',status), reviewed_at=now(), reviewed_by=public.qoc_current_profile_id() where id=(p_payload->>'id')::bigint returning to_jsonb(ugc_reports.*) into v_result;
      perform qoc_write_audit('moderation.update','ugc_report',p_payload->>'id',v_before,v_result,p_payload->>'reason');
    when 'campaign.create' then
      if not public.qoc_has_capability('campaigns.create') then raise exception 'qoc_capability_denied' using errcode='42501'; end if;
      insert into qoc_campaigns(name,objective,status,channel,title,body,locale,audience,scheduled_at,created_by_profile_id) values (coalesce(p_payload->>'name','Nueva campaña'),coalesce(p_payload->>'objective','inform'),'draft',coalesce(p_payload->>'channel','push'),p_payload->>'title',p_payload->>'body',coalesce(p_payload->>'locale','es'),coalesce(p_payload->'audience','{}'::jsonb),nullif(p_payload->>'scheduledAt','')::timestamptz,public.qoc_current_profile_id()) returning to_jsonb(qoc_campaigns.*) into v_result;
      perform qoc_write_audit('campaign.create','campaign',v_result->>'id',null,v_result,null);
    when 'ticket.create' then
      insert into qoc_support_tickets(subject,description,priority,requester_profile_id) values (coalesce(p_payload->>'subject','Incidencia sin asunto'),p_payload->>'description',coalesce(p_payload->>'priority','normal'),public.qoc_current_profile_id()) returning to_jsonb(qoc_support_tickets.*) into v_result;
      perform qoc_write_audit('support.create','ticket',v_result->>'id',null,v_result,null);
    when 'user.role.toggle' then
      if not public.qoc_has_capability('users.roles.manage') then raise exception 'qoc_capability_denied' using errcode='42501'; end if;
      update community_profiles set is_admin=coalesce((p_payload->>'isAdmin')::boolean,is_admin), is_official=coalesce((p_payload->>'isOfficial')::boolean,is_official) where id=(p_payload->>'profileId')::uuid returning to_jsonb(community_profiles.*) into v_result;
      perform qoc_write_audit('user.role.toggle','profile',p_payload->>'profileId',null,v_result,p_payload->>'reason');
    when 'translation.create' then
      insert into qoc_translation_jobs(source_type,source_id,source_locale,target_locale,source_text,created_by_profile_id) values (coalesce(p_payload->>'sourceType','official_post'),coalesce(p_payload->>'sourceId','manual'),coalesce(p_payload->>'sourceLocale','es'),coalesce(p_payload->>'targetLocale','en'),p_payload->>'sourceText',public.qoc_current_profile_id()) returning to_jsonb(qoc_translation_jobs.*) into v_result;
    when 'official.post.create' then
      if not public.qoc_has_capability('official.posts.create') then raise exception 'qoc_capability_denied' using errcode='42501'; end if;
      v_author := coalesce(nullif(p_payload->>'profileId','')::uuid, public.qoc_current_profile_id());
      if not exists(select 1 from community_profiles where id=v_author and is_official) then raise exception 'qoc_official_account_required' using errcode='23514'; end if;
      insert into official_posts(profile_id,title,summary,post_type,content_html,read_more_label,media_url,media_type,link_url,is_live,is_published,published_at,language,translation_group_id)
      values (v_author,coalesce(nullif(p_payload->>'title',''),'Comunicado sin título'),p_payload->>'summary',coalesce(nullif(p_payload->>'postType',''),'announcement'),coalesce(p_payload->>'contentHtml',''),coalesce(p_payload->>'readMoreLabel','read_more'),nullif(p_payload->>'mediaUrl',''),nullif(p_payload->>'mediaType',''),nullif(p_payload->>'linkUrl',''),coalesce((p_payload->>'isLive')::boolean,false),coalesce((p_payload->>'publishNow')::boolean,false),case when coalesce((p_payload->>'publishNow')::boolean,false) then now() else null end,coalesce(nullif(p_payload->>'language',''),'es'),gen_random_uuid())
      returning to_jsonb(official_posts.*) into v_result;
      perform qoc_write_audit('official.post.create','official_post',v_result->>'id',null,v_result,null);
    when 'official.post.delete' then
      if not public.qoc_has_capability('official.posts.delete') then raise exception 'qoc_capability_denied' using errcode='42501'; end if;
      select to_jsonb(o) into v_before from official_posts o where o.id=(p_payload->>'id')::uuid;
      update official_posts set deleted_at=now(),updated_at=now() where id=(p_payload->>'id')::uuid returning to_jsonb(official_posts.*) into v_result;
      perform qoc_write_audit('official.post.delete','official_post',p_payload->>'id',v_before,v_result,p_payload->>'reason');
    else raise exception 'qoc_unknown_command';
  end case;
  return coalesce(v_result,'{}'::jsonb);
end; $$;
