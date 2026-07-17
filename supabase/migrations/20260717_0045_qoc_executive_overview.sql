create or replace function public.qoc_executive_overview()
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
    'sos', jsonb_build_object(
      'active24h', (select count(*)::integer from public.chat_sos_events where created_at >= now() - interval '24 hours'),
      'total30d', (select count(*)::integer from public.chat_sos_events where created_at >= now() - interval '30 days'),
      'withLocation30d', (select count(*)::integer from public.chat_sos_events where created_at >= now() - interval '30 days' and latitude is not null and longitude is not null and not (latitude = 0 and longitude = 0)),
      'latest', coalesce((select jsonb_build_object('id', e.id, 'sender', coalesce(p.display_name, p.nombre, 'Usuario de Qüata'), 'createdAt', e.created_at, 'threadId', e.thread_id) from public.chat_sos_events e left join public.community_profiles p on p.id = e.profile_id order by e.created_at desc limit 1), '{}'::jsonb)
    ),
    'moderation', jsonb_build_object(
      'open', (select count(*)::integer from public.ugc_reports where coalesce(status, 'pending') in ('pending', 'reviewing', 'open')),
      'latest', coalesce((select jsonb_build_object('id', id, 'type', target_type, 'status', coalesce(status, 'pending'), 'createdAt', created_at) from public.ugc_reports order by created_at desc limit 1), '{}'::jsonb)
    ),
    'users', jsonb_build_object(
      'total', (select count(*)::integer from public.community_profiles),
      'new30d', (select count(*)::integer from public.community_profiles where created_at >= now() - interval '30 days'),
      'active30d', (select count(*)::integer from public.community_profiles where last_login_at >= now() - interval '30 days'),
      'administrators', (select count(*)::integer from public.community_profiles where is_admin),
      'officialAccounts', (select count(*)::integer from public.community_profiles where is_official)
    ),
    'territories', jsonb_build_object(
      'communities', (select count(*)::integer from public.community_walls),
      'memberships', (select count(*)::integer from public.community_members),
      'posts30d', (select count(*)::integer from public.community_posts where created_at >= now() - interval '30 days')
    ),
    'content', jsonb_build_object(
      'feedPosts30d', (select count(*)::integer from public.community_posts where created_at >= now() - interval '30 days'),
      'officialPosts', (select count(distinct coalesce(translation_group_id, id))::integer from public.official_posts where deleted_at is null and is_published),
      'officialPosts30d', (select count(distinct coalesce(translation_group_id, id))::integer from public.official_posts where deleted_at is null and is_published and coalesce(published_at, created_at) >= now() - interval '30 days'),
      'latestOfficial', coalesce((select jsonb_build_object('id', id, 'title', title, 'publishedAt', coalesce(published_at, created_at)) from public.official_posts where deleted_at is null and is_published order by coalesce(published_at, created_at) desc limit 1), '{}'::jsonb)
    ),
    'chat', jsonb_build_object(
      'messages24h', (select count(*)::integer from public.chat_messages where deleted_at is null and created_at >= now() - interval '24 hours'),
      'attachments30d', (select count(*)::integer from public.chat_attachments where created_at >= now() - interval '30 days'),
      'delivered24h', (select count(distinct message_id)::integer from public.chat_message_states where lower(status) in ('delivered', 'read') and recorded_at >= now() - interval '24 hours'),
      'read24h', (select count(distinct message_id)::integer from public.chat_message_states where lower(status) = 'read' and recorded_at >= now() - interval '24 hours'),
      'pendingDelivery15m', (select count(*)::integer from public.chat_messages m where m.deleted_at is null and m.created_at >= now() - interval '24 hours' and m.created_at < now() - interval '15 minutes' and not exists (select 1 from public.chat_message_states s where s.message_id = m.id and lower(s.status) in ('delivered', 'read')))
    ),
    'security', (
      select jsonb_build_object(
        'totalTables', count(*)::integer,
        'enabledTables', count(*) filter (where c.relrowsecurity)::integer,
        'disabledTables', count(*) filter (where not c.relrowsecurity)::integer,
        'unprotected', coalesce(jsonb_agg(c.relname order by c.relname) filter (where not c.relrowsecurity), '[]'::jsonb)
      )
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
    ),
    'version', coalesce((
      select jsonb_build_object(
        'version', release.value->>'name',
        'versionCode', release.value->'versionCodes'->>0,
        'status', release.value->>'status',
        'cachedAt', snapshot.fetched_at
      )
      from public.qoc_google_play_snapshots snapshot
      cross join lateral jsonb_array_elements(coalesce(snapshot.payload->'tracks', '[]'::jsonb)) track(value)
      cross join lateral jsonb_array_elements(coalesce(track.value->'releases', '[]'::jsonb)) release(value)
      where track.value->>'track' = 'production'
      order by snapshot.fetched_at desc
      limit 1
    ), '{}'::jsonb),
    'services', jsonb_build_array(
      jsonb_build_object('key', 'database', 'name', 'Base de datos', 'status', case when exists (select 1 from public.qoc_monitoring_snapshots where captured_at >= now() - interval '20 minutes') then 'operational' else 'unknown' end),
      jsonb_build_object('key', 'realtime', 'name', 'Realtime', 'status', case when exists (select 1 from pg_publication where pubname = 'supabase_realtime') then 'operational' else 'attention' end),
      jsonb_build_object('key', 'firebase', 'name', 'Firebase push', 'status', case when exists (select 1 from public.push_delivery_log where status = 'error' and created_at >= now() - interval '24 hours') then 'attention' when exists (select 1 from public.push_delivery_log where status = 'sent' and created_at >= now() - interval '7 days') then 'operational' else 'unknown' end)
    ) || public.qoc_external_service_checks(),
    'activity', coalesce((
      select jsonb_agg(jsonb_build_object('id', source.id, 'action', source.action_key, 'entityType', source.entity_type, 'actor', source.actor, 'createdAt', source.created_at) order by source.created_at desc)
      from (
        select a.id, a.action_key, a.entity_type, a.created_at, coalesce(p.display_name, p.nombre, 'Sistema') as actor
        from public.qoc_audit_log a left join public.community_profiles p on p.id = a.actor_profile_id
        order by a.created_at desc limit 5
      ) source
    ), '[]'::jsonb),
    'growthSeries', coalesce(public.qoc_user_growth_series(13), '[]'::jsonb),
    'capturedAt', now()
  );
end;
$$;

revoke all on function public.qoc_executive_overview() from public;
grant execute on function public.qoc_executive_overview() to authenticated;
