create or replace function public.qoc_invoke_google_play_sync()
returns bigint
language plpgsql
security definer
set search_path = public
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

  return net.http_post(
    url := 'https://yrrlankpwmhluexshxnw.supabase.co/functions/v1/qoc-google-play',
    headers := jsonb_build_object('content-type', 'application/json', 'x-qoc-google-play-sync', v_sync_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

revoke all on function public.qoc_invoke_google_play_sync() from public;
