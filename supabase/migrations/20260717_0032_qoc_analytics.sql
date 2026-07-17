create or replace function public.qoc_analytics(p_scope text, p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_days integer := greatest(7, least(coalesce(p_days, 30), 365));
begin
  if not public.qoc_is_authorized() then
    raise exception 'qoc_access_denied' using errcode = '42501';
  end if;

  case p_scope
    when 'users' then return jsonb_build_object(
      'kpis', jsonb_build_array(
        jsonb_build_object('label','Usuarios registrados','value',(select count(*) from community_profiles)),
        jsonb_build_object('label','Altas en el periodo','value',(select count(*) from community_profiles where created_at >= now() - make_interval(days => v_days))),
        jsonb_build_object('label','Activos en 30 días','value',(select count(*) from community_profiles where last_login_at >= now() - interval '30 days')),
        jsonb_build_object('label','Cuentas oficiales','value',(select count(*) from community_profiles where is_official))
      ),
      'series', coalesce((select jsonb_agg(jsonb_build_object('date', d::date, 'registered', (select count(*) from community_profiles p where p.created_at::date = d::date), 'total', (select count(*) from community_profiles p where p.created_at::date <= d::date)) order by d) from generate_series(current_date - (v_days - 1), current_date, interval '1 day') d), '[]'::jsonb),
      'territories', coalesce((select jsonb_agg(jsonb_build_object('name', territory, 'users', users) order by users desc, territory) from (select coalesce(nullif(neighborhood,''), nullif(barrio,''), 'Sin barrio') territory, count(*) users from community_profiles group by 1 order by 2 desc, 1 limit 8) x), '[]'::jsonb)
    );
    when 'content' then return jsonb_build_object(
      'kpis', jsonb_build_array(
        jsonb_build_object('label','Publicaciones en feed','value',(select count(*) from community_posts)),
        jsonb_build_object('label','Publicaciones oficiales','value',(select count(distinct coalesce(translation_group_id, id)) from official_posts where deleted_at is null and is_published)),
        jsonb_build_object('label','Publicadas en el periodo','value',(select count(*) from community_posts where created_at >= now() - make_interval(days => v_days)) + (select count(distinct coalesce(translation_group_id, id)) from official_posts where deleted_at is null and is_published and coalesce(published_at, created_at) >= now() - make_interval(days => v_days))),
        jsonb_build_object('label','Reportes pendientes','value',(select count(*) from ugc_reports where coalesce(status,'pending') in ('pending','open')))
      ),
      'series', coalesce((select jsonb_agg(jsonb_build_object('date', d::date, 'feed', (select count(*) from community_posts p where p.created_at::date = d::date), 'official', (select count(distinct coalesce(translation_group_id, id)) from official_posts p where p.deleted_at is null and p.is_published and coalesce(p.published_at,p.created_at)::date = d::date)) order by d) from generate_series(current_date - (v_days - 1), current_date, interval '1 day') d), '[]'::jsonb),
      'authors', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'posts', posts) order by posts desc, name) from (select coalesce(p.display_name,p.nombre,'Usuario sin nombre') name, count(*) posts from community_posts cp left join community_profiles p on p.id = coalesce(cp.profile_id,cp.author_id) group by 1 order by 2 desc, 1 limit 6) x), '[]'::jsonb)
    );
    when 'chat' then return jsonb_build_object(
      'kpis', jsonb_build_array(
        jsonb_build_object('label','Conversaciones','value',(select count(*) from chat_threads where deleted_at is null)),
        jsonb_build_object('label','Mensajes en el periodo','value',(select count(*) from chat_messages where deleted_at is null and created_at >= now() - make_interval(days => v_days))),
        jsonb_build_object('label','Adjuntos en el periodo','value',(select count(*) from chat_attachments where created_at >= now() - make_interval(days => v_days))),
        jsonb_build_object('label','Lecturas confirmadas','value',(select count(distinct message_id) from chat_message_states where lower(status) = 'read' and recorded_at >= now() - make_interval(days => v_days)))
      ),
      'series', coalesce((select jsonb_agg(jsonb_build_object('date', d::date, 'messages', (select count(*) from chat_messages m where m.deleted_at is null and m.created_at::date = d::date), 'attachments', (select count(*) from chat_attachments a where a.created_at::date = d::date)) order by d) from generate_series(current_date - (v_days - 1), current_date, interval '1 day') d), '[]'::jsonb),
      'delivery', jsonb_build_object('delivered',(select count(distinct message_id) from chat_message_states where lower(status) in ('delivered','read') and recorded_at >= now() - make_interval(days => v_days)),'read',(select count(distinct message_id) from chat_message_states where lower(status) = 'read' and recorded_at >= now() - make_interval(days => v_days)),'pending',(select count(*) from chat_messages m where m.deleted_at is null and m.created_at >= now() - make_interval(days => v_days) and not exists (select 1 from chat_message_states s where s.message_id=m.id and lower(s.status) in ('delivered','read'))))
    );
    when 'sos' then return jsonb_build_object(
      'kpis', jsonb_build_array(
        jsonb_build_object('label','Alertas en el periodo','value',(select count(*) from chat_sos_events where created_at >= now() - make_interval(days => v_days))),
        jsonb_build_object('label','Activas en 24 h','value',(select count(*) from chat_sos_events where created_at >= now() - interval '24 hours')),
        jsonb_build_object('label','Con ubicación válida','value',(select count(*) from chat_sos_events where created_at >= now() - make_interval(days => v_days) and latitude is not null and longitude is not null and not (latitude = 0 and longitude = 0))),
        jsonb_build_object('label','Personas que solicitaron ayuda','value',(select count(distinct profile_id) from chat_sos_events where created_at >= now() - make_interval(days => v_days)))
      ),
      'series', coalesce((select jsonb_agg(jsonb_build_object('date', d::date, 'alerts', (select count(*) from chat_sos_events e where e.created_at::date = d::date), 'geolocated', (select count(*) from chat_sos_events e where e.created_at::date = d::date and e.latitude is not null and e.longitude is not null and not (e.latitude=0 and e.longitude=0))) order by d) from generate_series(current_date - (v_days - 1), current_date, interval '1 day') d), '[]'::jsonb),
      'recent', coalesce((select jsonb_agg(jsonb_build_object('sender',coalesce(p.display_name,p.nombre,'Usuario'),'at',e.created_at,'hasLocation',(e.latitude is not null and e.longitude is not null and not (e.latitude=0 and e.longitude=0)),'sentCount',e.sent_count) order by e.created_at desc) from (select * from chat_sos_events order by created_at desc limit 8) e left join community_profiles p on p.id=e.profile_id), '[]'::jsonb)
    );
    else raise exception 'qoc_unknown_analytics_scope';
  end case;
end;
$$;
