-- Make report states describe the moderator's actual decision.
-- `actioned` was only ever assigned after remove_content, so migrate it to
-- an explicit state that operators and clients can render unambiguously.

alter table public.ugc_reports
  drop constraint if exists ugc_reports_status_check;

update public.ugc_reports
set status = 'removed'
where status = 'actioned';

alter table public.ugc_reports
  add constraint ugc_reports_status_check
  check (status in ('pending', 'reviewing', 'dismissed', 'removed'));

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
  if p_decision not in ('reviewing', 'dismiss', 'remove_content') then
    raise exception 'qoc_invalid_moderation_decision';
  end if;

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
    set status = case p_decision
      when 'reviewing' then 'reviewing'
      when 'dismiss' then 'dismissed'
      else 'removed'
    end,
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

grant execute on function public.qoc_moderation_decide(bigint,text,text) to authenticated;
