create extension if not exists pg_net with schema extensions;

create table if not exists public.qoc_google_play_snapshots (
  id bigint generated always as identity primary key,
  package_name text not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);

create index if not exists qoc_google_play_snapshots_latest_idx
  on public.qoc_google_play_snapshots (package_name, fetched_at desc);

alter table public.qoc_google_play_snapshots enable row level security;
revoke all on public.qoc_google_play_snapshots from anon, authenticated;

create or replace function public.qoc_google_play_latest()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snapshot jsonb;
begin
  if not public.qoc_is_authorized() then
    raise exception 'qoc_access_denied' using errcode = '42501';
  end if;

  select payload || jsonb_build_object('cachedAt', fetched_at)
  into v_snapshot
  from public.qoc_google_play_snapshots
  where package_name = 'com.quata'
  order by fetched_at desc
  limit 1;

  return coalesce(v_snapshot, jsonb_build_object('state', 'pending'));
end;
$$;

revoke all on function public.qoc_google_play_latest() from public;
grant execute on function public.qoc_google_play_latest() to authenticated;

create or replace function public.qoc_invoke_google_play_sync()
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_sync_secret text;
begin
  select decrypted_secret
  into v_sync_secret
  from vault.decrypted_secrets
  where name = 'qoc_google_play_sync_secret'
  limit 1;

  if v_sync_secret is null then
    raise exception 'qoc_google_play_sync_secret_missing';
  end if;

  return extensions.http_post(
    url := 'https://yrrlankpwmhluexshxnw.supabase.co/functions/v1/qoc-google-play',
    headers := jsonb_build_object('content-type', 'application/json', 'x-qoc-google-play-sync', v_sync_secret),
    body := '{}'::jsonb
  );
end;
$$;

revoke all on function public.qoc_invoke_google_play_sync() from public;

select cron.unschedule(jobid)
from cron.job
where jobname = 'qoc-google-play-sync-twice-daily';

select cron.schedule(
  'qoc-google-play-sync-twice-daily',
  '15 3,15 * * *',
  $$select public.qoc_invoke_google_play_sync();$$
);
