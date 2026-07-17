create table if not exists public.qoc_service_checks (
  id bigint generated always as identity primary key,
  service_key text not null check (service_key in ('wordpress', 'deepl')),
  status text not null check (status in ('operational', 'attention', 'unknown')),
  latency_ms integer,
  status_code integer,
  detail text not null,
  checked_at timestamptz not null default now()
);

create index if not exists qoc_service_checks_service_checked_idx
  on public.qoc_service_checks (service_key, checked_at desc);

alter table public.qoc_service_checks enable row level security;

create table if not exists public.qoc_monitoring_snapshots (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  active_connections integer not null default 0,
  transactions bigint not null default 0,
  rollbacks bigint not null default 0,
  deadlocks bigint not null default 0,
  temp_bytes bigint not null default 0,
  database_bytes bigint not null default 0,
  user_table_bytes bigint not null default 0,
  dead_rows bigint not null default 0,
  push_sent_24h integer not null default 0,
  push_errors_24h integer not null default 0,
  delivered_24h integer not null default 0,
  read_24h integer not null default 0,
  pending_delivery_15m integer not null default 0,
  table_health jsonb not null default '[]'::jsonb,
  query_health jsonb not null default '[]'::jsonb
);

create index if not exists qoc_monitoring_snapshots_captured_at_idx
  on public.qoc_monitoring_snapshots (captured_at desc);

alter table public.qoc_monitoring_snapshots enable row level security;

create or replace function public.qoc_external_service_checks()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', source.service_key,
    'name', source.name,
    'status', case when latest.checked_at >= now() - interval '20 minutes' then latest.status else 'unknown' end,
    'detail', coalesce(latest.detail, source.pending_detail),
    'latencyMs', latest.latency_ms,
    'statusCode', latest.status_code,
    'checkedAt', latest.checked_at
  ) order by source.sort_order), '[]'::jsonb)
  from (
    values
      ('wordpress'::text, 'WordPress multimedia'::text, 'Aún no se ha ejecutado una sonda HTTP.', 1),
      ('deepl'::text, 'DeepL'::text, 'Aún no se ha ejecutado una sonda autenticada.', 2)
  ) as source(service_key, name, pending_detail, sort_order)
  left join lateral (
    select status, latency_ms, status_code, detail, checked_at
    from public.qoc_service_checks
    where service_key = source.service_key
    order by checked_at desc
    limit 1
  ) latest on true;
$$;

create or replace function public.qoc_capture_monitoring_snapshot()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_snapshot public.qoc_monitoring_snapshots;
begin
  insert into public.qoc_monitoring_snapshots (
    active_connections, transactions, rollbacks, deadlocks, temp_bytes,
    database_bytes, user_table_bytes, dead_rows,
    push_sent_24h, push_errors_24h, delivered_24h, read_24h,
    pending_delivery_15m, table_health, query_health
  )
  select
    (select count(*)::integer from pg_stat_activity where datname = current_database()),
    coalesce((select xact_commit + xact_rollback from pg_stat_database where datname = current_database()), 0),
    coalesce((select xact_rollback from pg_stat_database where datname = current_database()), 0),
    coalesce((select deadlocks from pg_stat_database where datname = current_database()), 0),
    coalesce((select temp_bytes from pg_stat_database where datname = current_database()), 0),
    pg_database_size(current_database()),
    coalesce((select sum(pg_total_relation_size(relid)) from pg_stat_user_tables), 0),
    coalesce((select sum(n_dead_tup) from pg_stat_user_tables), 0),
    (select count(*)::integer from public.push_delivery_log where status = 'sent' and created_at >= now() - interval '24 hours'),
    (select count(*)::integer from public.push_delivery_log where status = 'error' and created_at >= now() - interval '24 hours'),
    (select count(distinct message_id)::integer from public.chat_message_states where lower(status) in ('delivered','read') and recorded_at >= now() - interval '24 hours'),
    (select count(distinct message_id)::integer from public.chat_message_states where lower(status) = 'read' and recorded_at >= now() - interval '24 hours'),
    (select count(*)::integer from public.chat_messages m where m.deleted_at is null and m.created_at < now() - interval '15 minutes' and m.created_at >= now() - interval '24 hours' and not exists (select 1 from public.chat_message_states s where s.message_id = m.id and lower(s.status) in ('delivered','read'))),
    coalesce((select jsonb_agg(row_to_json(t)::jsonb order by t.total_bytes desc) from (
      select relname as name,
             n_live_tup::bigint as estimated_rows,
             n_dead_tup::bigint as dead_rows,
             pg_total_relation_size(relid)::bigint as total_bytes,
             last_autovacuum,
             last_autoanalyze
      from pg_stat_user_tables
      order by pg_total_relation_size(relid) desc
      limit 8
    ) t), '[]'::jsonb),
    coalesce((select jsonb_agg(row_to_json(q)::jsonb order by q.total_ms desc) from (
      select case
               when query ilike '%wal->%' then 'Realtime / replicación'
               when query ilike '%pgrst_call%' then 'RPC de la API'
               when query ilike '%pg_timezone_names%' then 'Metadatos PostgreSQL'
               else 'Consulta interna'
             end as family,
             calls::bigint as calls,
             round(mean_exec_time::numeric, 2) as mean_ms,
             round(total_exec_time::numeric, 2) as total_ms
      from extensions.pg_stat_statements
      where dbid = (select oid from pg_database where datname = current_database())
      order by total_exec_time desc
      limit 6
    ) q), '[]'::jsonb)
  returning * into v_snapshot;

  return jsonb_build_object('id', v_snapshot.id, 'captured_at', v_snapshot.captured_at);
end;
$$;

create or replace function public.qoc_monitoring(p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_days integer := greatest(1, least(coalesce(p_days, 7), 30));
begin
  if not public.qoc_is_authorized() then
    raise exception 'qoc_access_denied' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'latest', coalesce((select to_jsonb(s) - 'table_health' - 'query_health' from public.qoc_monitoring_snapshots s order by captured_at desc limit 1), '{}'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object(
      'at', captured_at,
      'connections', active_connections,
      'pushErrors', push_errors_24h,
      'pushSent', push_sent_24h,
      'pendingDelivery', pending_delivery_15m,
      'delivered', delivered_24h,
      'read', read_24h
    ) order by captured_at) from public.qoc_monitoring_snapshots where captured_at >= now() - make_interval(days => v_days)), '[]'::jsonb),
    'tableHealth', coalesce((select table_health from public.qoc_monitoring_snapshots order by captured_at desc limit 1), '[]'::jsonb),
    'queryHealth', coalesce((select query_health from public.qoc_monitoring_snapshots order by captured_at desc limit 1), '[]'::jsonb),
    'services', jsonb_build_array(
      jsonb_build_object('key','database','name','Base de datos', 'status', case when exists (select 1 from public.qoc_monitoring_snapshots where captured_at >= now() - interval '15 minutes') then 'operational' else 'unknown' end, 'detail','Snapshot PostgreSQL disponible.'),
      jsonb_build_object('key','realtime','name','Realtime', 'status', case when exists (select 1 from pg_publication where pubname = 'supabase_realtime') then 'operational' else 'attention' end, 'detail','Publicación de Realtime configurada en PostgreSQL.'),
      jsonb_build_object('key','firebase','name','Firebase push', 'status', case when exists (select 1 from public.push_delivery_log where status = 'error' and created_at >= now() - interval '24 hours') then 'attention' when exists (select 1 from public.push_delivery_log where status = 'sent' and created_at >= now() - interval '7 days') then 'operational' else 'unknown' end, 'detail','Basado en los envíos y errores registrados por la función de push.')
    ) || public.qoc_external_service_checks()
  );
end;
$$;

revoke all on table public.qoc_service_checks from anon, authenticated;
revoke all on table public.qoc_monitoring_snapshots from anon, authenticated;
revoke all on function public.qoc_capture_monitoring_snapshot() from public;
grant execute on function public.qoc_capture_monitoring_snapshot() to service_role;
revoke all on function public.qoc_monitoring(integer) from public;
grant execute on function public.qoc_monitoring(integer) to authenticated;
