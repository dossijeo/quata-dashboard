create or replace function public.qoc_compliance_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
begin
  if not public.qoc_is_authorized() then
    raise exception 'qoc_access_denied' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'rls', (
      select jsonb_build_object(
        'totalTables', count(*)::integer,
        'enabledTables', count(*) filter (where c.relrowsecurity)::integer,
        'disabledTables', count(*) filter (where not c.relrowsecurity)::integer,
        'unprotected', coalesce(jsonb_agg(jsonb_build_object('table', c.relname, 'policies', coalesce(policy_count, 0)) order by c.relname) filter (where not c.relrowsecurity), '[]'::jsonb)
      )
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join lateral (select count(*)::integer as policy_count from pg_policy p where p.polrelid = c.oid) policies on true
      where n.nspname = 'public' and c.relkind = 'r'
    ),
    'privilegedAccounts', (
      select jsonb_build_object('profiles', count(*)::integer, 'administrators', count(*) filter (where is_admin)::integer, 'officialAccounts', count(*) filter (where is_official)::integer)
      from public.community_profiles
    ),
    'data', jsonb_build_object(
      'chatMessages', (select count(*)::integer from public.chat_messages where deleted_at is null),
      'deletedChatMessages', (select count(*)::integer from public.chat_messages where deleted_at is not null),
      'officialPosts', (select count(*)::integer from public.official_posts where deleted_at is null),
      'deletedOfficialPosts', (select count(*)::integer from public.official_posts where deleted_at is not null),
      'communityPosts', (select count(*)::integer from public.community_posts),
      'attachments', (select count(*)::integer from public.chat_attachments),
      'openReports', (select count(*)::integer from public.ugc_reports where status in ('pending', 'reviewing'))
    ),
    'activity', coalesce((
      select jsonb_agg(jsonb_build_object('id', source.id, 'action', source.action_key, 'entityType', source.entity_type, 'entityId', source.entity_id, 'actor', source.actor, 'createdAt', source.created_at) order by source.created_at desc)
      from (
        select a.id, a.action_key, a.entity_type, a.entity_id, a.created_at, coalesce(p.display_name, p.nombre, 'Sistema') as actor
        from public.qoc_audit_log a left join public.community_profiles p on p.id = a.actor_profile_id
        order by a.created_at desc limit 8
      ) source
    ), '[]'::jsonb),
    'integrations', jsonb_build_object(
      'services', coalesce(public.qoc_external_service_checks(), '[]'::jsonb),
      'googlePlayCacheAt', (select fetched_at from public.qoc_google_play_snapshots order by fetched_at desc limit 1),
      'monitoringSnapshotAt', (select captured_at from public.qoc_monitoring_snapshots order by captured_at desc limit 1)
    )
  );
end;
$$;

revoke all on function public.qoc_compliance_overview() from public;
grant execute on function public.qoc_compliance_overview() to authenticated;
