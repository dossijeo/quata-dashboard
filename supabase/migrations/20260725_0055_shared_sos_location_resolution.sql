-- Normalize SOS coordinates for every QOC module.
-- Coordinates may live in structured columns, in the SOS shortcode, or in a
-- deferred update posted shortly afterwards in the same SOS thread.

create or replace function security_citizen.resolve_sos_location(
  p_message text,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_m double precision
)
returns table (
  latitude double precision,
  longitude double precision,
  accuracy_m double precision,
  source text,
  valid boolean
)
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_latitude double precision := p_latitude;
  v_longitude double precision := p_longitude;
  v_accuracy_m double precision := p_accuracy_m;
  v_match text[];
  v_source text := 'STRUCTURED';
begin
  if v_latitude is null or v_longitude is null then
    v_source := 'MESSAGE_SHORTCODE';
    begin
      if v_latitude is null then
        v_match := regexp_match(coalesce(p_message, ''), '[;:]lat=([^;\]]+)');
        if v_match is not null then
          v_latitude := v_match[1]::double precision;
        end if;
      end if;

      if v_longitude is null then
        v_match := regexp_match(coalesce(p_message, ''), '[;:]lng=([^;\]]+)');
        if v_match is not null then
          v_longitude := v_match[1]::double precision;
        end if;
      end if;

      if v_accuracy_m is null then
        v_match := regexp_match(coalesce(p_message, ''), '[;:]accuracy_m=([^;\]]+)');
        if v_match is not null then
          v_accuracy_m := v_match[1]::double precision;
        end if;
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      v_latitude := null;
      v_longitude := null;
    end;
  end if;

  if v_latitude is null
    or v_longitude is null
    or v_latitude < -90
    or v_latitude > 90
    or v_longitude < -180
    or v_longitude > 180
    or (v_latitude = 0 and v_longitude = 0)
  then
    return query select null::double precision, null::double precision,
      v_accuracy_m, 'NONE'::text, false;
    return;
  end if;

  return query select v_latitude, v_longitude, v_accuracy_m, v_source, true;
end;
$$;

revoke all on function security_citizen.resolve_sos_location(
  text, double precision, double precision, double precision
) from public, anon, authenticated;

create or replace function public.qoc_sos_alerts(p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, security_citizen, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 50));
begin
  if not public.qoc_is_authorized() then
    raise exception 'qoc_access_denied' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(alert order by created_at desc)
    from (
      select
        e.created_at,
        jsonb_build_object(
          'id', e.id,
          'threadId', e.thread_id,
          'messageId', e.message_id,
          'message', e.message,
          'latitude', e.effective_latitude,
          'longitude', e.effective_longitude,
          'accuracy', e.effective_accuracy_m,
          'locationSource', e.location_source,
          'locationDerivedFromEventId', e.derived_from_event_id,
          'sentCount', e.sent_count,
          'createdAt', e.created_at,
          'sender', coalesce(p.display_name, p.nombre, 'Usuario de Qüata'),
          'recipientCount', (
            select count(*)
            from public.chat_sos_recipients r
            where r.sos_event_id = e.id
          ),
          'status', case
            when e.created_at > now() - interval '24 hours' then 'active'
            else 'historical'
          end
        ) as alert
      from (
        select
          s.*,
          coalesce(own_location.latitude, deferred_location.latitude) as effective_latitude,
          coalesce(own_location.longitude, deferred_location.longitude) as effective_longitude,
          coalesce(own_location.accuracy_m, deferred_location.accuracy_m) as effective_accuracy_m,
          case
            when own_location.valid then own_location.source
            when deferred_location.source_event_id is not null then 'DEFERRED_SOS_UPDATE'
            else 'NONE'
          end as location_source,
          deferred_location.source_event_id as derived_from_event_id
        from public.chat_sos_events s
        cross join lateral security_citizen.resolve_sos_location(
          s.message, s.latitude, s.longitude, s.accuracy_m
        ) own_location
        left join lateral (
          select
            update_event.id as source_event_id,
            update_location.latitude,
            update_location.longitude,
            update_location.accuracy_m
          from public.chat_sos_events update_event
          cross join lateral security_citizen.resolve_sos_location(
            update_event.message,
            update_event.latitude,
            update_event.longitude,
            update_event.accuracy_m
          ) update_location
          where not own_location.valid
            and update_event.profile_id = s.profile_id
            and update_event.thread_id = s.thread_id
            and update_event.created_at > s.created_at
            and update_event.created_at <= s.created_at + interval '30 minutes'
            and update_location.valid
          order by update_event.created_at
          limit 1
        ) deferred_location on true
      ) e
      left join public.community_profiles p on p.id = e.profile_id
      order by e.created_at desc
      limit v_limit
    ) recent_alerts
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.qoc_sos_alerts(integer) from public;
grant execute on function public.qoc_sos_alerts(integer) to authenticated;

create or replace function public.qoc_citizen_security_location_timeline(
  p_target_user_id uuid,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_sources text[] default null,
  p_only_coordinates boolean default false,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, security_citizen, pg_temp
as $$
declare
  v_actor uuid := security_citizen.assert_access();
  v_events jsonb;
  v_request_id uuid;
begin
  if p_date_from is not null and p_date_to is not null and (
    p_date_from > p_date_to or p_date_to - p_date_from > interval '365 days'
  ) then
    raise exception 'security_date_range_too_large' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(event order by observed_at desc nulls last), '[]'::jsonb)
  into v_events
  from (
    select p.created_at as observed_at, jsonb_build_object(
      'evidenceId', 'neighborhood:' || p.id::text,
      'sourceType', 'PROFILE_NEIGHBORHOOD',
      'observedAt', null,
      'receivedAt', p.created_at,
      'placeLabel', coalesce(p.neighborhood, p.barrio),
      'latitude', null,
      'longitude', null,
      'accuracyMeters', null,
      'geometryType', 'NONE',
      'reliability', 'CONTEXT_ONLY',
      'reliabilityReasons', jsonb_build_array('Barrio autodeclarado en el perfil'),
      'sourceResourceType', 'PROFILE',
      'sourceResourceId', p.id,
      'preview', 'Contexto territorial declarado; no representa movimiento.',
      'warnings', jsonb_build_array('No se muestra como punto exacto.')
    ) as event
    from public.community_profiles p
    where p.id = p_target_user_id
      and coalesce(nullif(p.neighborhood, ''), nullif(p.barrio, '')) is not null
      and not p_only_coordinates
      and (p_sources is null or 'PROFILE_NEIGHBORHOOD' = any(p_sources))

    union all

    select s.created_at, jsonb_build_object(
      'evidenceId', 'sos:' || s.id::text,
      'sourceType', 'SOS_LOCATION',
      'observedAt', s.created_at,
      'receivedAt', s.created_at,
      'placeLabel', 'Ubicación asociada a alerta SOS',
      'latitude', s.effective_latitude,
      'longitude', s.effective_longitude,
      'accuracyMeters', s.effective_accuracy_m,
      'geometryType', case when s.effective_latitude is null then 'NONE' else 'POINT' end,
      'reliability', case
        when s.effective_latitude is null then 'LOW'
        when s.location_source = 'DEFERRED_SOS_UPDATE' then 'MEDIUM'
        else 'HIGH'
      end,
      'reliabilityReasons', case
        when s.location_source = 'DEFERRED_SOS_UPDATE'
          then jsonb_build_array('Coordenadas recuperadas de una actualización posterior del mismo hilo SOS')
        when s.location_source = 'MESSAGE_SHORTCODE'
          then jsonb_build_array('Coordenadas recuperadas del mensaje estructurado SOS')
        when s.location_source = 'STRUCTURED'
          then jsonb_build_array('Coordenadas almacenadas por el sistema SOS')
        else jsonb_build_array('La alerta no conserva coordenadas válidas')
      end,
      'sourceResourceType', 'SOS_EVENT',
      'sourceResourceId', s.id,
      'conversationId', s.thread_id,
      'messageId', s.message_id,
      'locationSource', s.location_source,
      'locationDerivedFromEventId', s.derived_from_event_id,
      'preview', s.message,
      'warnings', case
        when s.effective_latitude is null
          then jsonb_build_array('La alerta no conserva coordenadas válidas.')
        when s.location_source = 'DEFERRED_SOS_UPDATE'
          then jsonb_build_array('Ubicación recibida poco después en el mismo hilo SOS; no implica seguimiento en tiempo real.')
        else jsonb_build_array('Ubicación declarada por el dispositivo; no implica seguimiento en tiempo real.')
      end
    )
    from (
      select
        base_event.*,
        coalesce(own_location.latitude, deferred_location.latitude) as effective_latitude,
        coalesce(own_location.longitude, deferred_location.longitude) as effective_longitude,
        coalesce(own_location.accuracy_m, deferred_location.accuracy_m) as effective_accuracy_m,
        case
          when own_location.valid then own_location.source
          when deferred_location.source_event_id is not null then 'DEFERRED_SOS_UPDATE'
          else 'NONE'
        end as location_source,
        deferred_location.source_event_id as derived_from_event_id
      from public.chat_sos_events base_event
      cross join lateral security_citizen.resolve_sos_location(
        base_event.message,
        base_event.latitude,
        base_event.longitude,
        base_event.accuracy_m
      ) own_location
      left join lateral (
        select
          update_event.id as source_event_id,
          update_location.latitude,
          update_location.longitude,
          update_location.accuracy_m
        from public.chat_sos_events update_event
        cross join lateral security_citizen.resolve_sos_location(
          update_event.message,
          update_event.latitude,
          update_event.longitude,
          update_event.accuracy_m
        ) update_location
        where not own_location.valid
          and update_event.profile_id = base_event.profile_id
          and update_event.thread_id = base_event.thread_id
          and update_event.created_at > base_event.created_at
          and update_event.created_at <= base_event.created_at + interval '30 minutes'
          and update_location.valid
        order by update_event.created_at
        limit 1
      ) deferred_location on true
      where base_event.profile_id = p_target_user_id
        and (p_date_from is null or base_event.created_at >= p_date_from)
        and (p_date_to is null or base_event.created_at <= p_date_to)
    ) s
    where (not p_only_coordinates or s.effective_latitude is not null)
      and (p_sources is null or 'SOS_LOCATION' = any(p_sources))

    union all

    select post.created_at, jsonb_build_object(
      'evidenceId', 'post-text:' || post.id::text,
      'sourceType', 'POST_MANUAL_LOCATION_TEXT',
      'observedAt', post.created_at,
      'receivedAt', post.created_at,
      'placeLabel', post.place_label,
      'latitude', null,
      'longitude', null,
      'accuracyMeters', null,
      'geometryType', 'NONE',
      'reliability', 'LOW',
      'reliabilityReasons', jsonb_build_array('Texto geográfico heredado sin coordenadas estructuradas'),
      'sourceResourceType', 'POST',
      'sourceResourceId', post.id,
      'preview', post.preview,
      'warnings', jsonb_build_array('Origen manual o automático desconocido; no se geocodifica ni se dibuja como punto.')
    )
    from (
      select
        p.id, p.created_at,
        substring(coalesce(p.body, p.content, '') from '\[UBICACION:([^\]]+)\]') as place_label,
        left(regexp_replace(coalesce(p.body, p.content, ''), '\[[^\]]+\]', '', 'g'), 240) as preview
      from public.community_posts p
      where coalesce(p.profile_id, p.author_id) = p_target_user_id
        and (p_date_from is null or p.created_at >= p_date_from)
        and (p_date_to is null or p.created_at <= p_date_to)
    ) post
    where nullif(post.place_label, '') is not null
      and not p_only_coordinates
      and (p_sources is null or 'POST_MANUAL_LOCATION_TEXT' = any(p_sources))
  ) evidence;

  v_request_id := security_citizen.log_access(
    'LOCATION_TIMELINE_VIEW', 'LOCATION_TIMELINE', null, p_target_user_id, p_reason,
    jsonb_build_object('dateFrom', p_date_from, 'dateTo', p_date_to, 'sources', p_sources),
    jsonb_build_object('eventCount', jsonb_array_length(v_events))
  );
  return jsonb_build_object(
    'requestId', v_request_id,
    'events', v_events,
    'locationLinkMaxHours', 72,
    'notice', 'Cronología histórica de evidencias; no representa seguimiento en tiempo real ni una ruta confirmada.'
  );
end;
$$;

revoke all on function public.qoc_citizen_security_location_timeline(
  uuid, timestamptz, timestamptz, text[], boolean, text
) from public, anon;
grant execute on function public.qoc_citizen_security_location_timeline(
  uuid, timestamptz, timestamptz, text[], boolean, text
) to authenticated;
