select cron.schedule(
  'qoc-monitoring-snapshot-every-five-minutes',
  '*/5 * * * *',
  $$select public.qoc_capture_monitoring_snapshot();$$
)
where not exists (
  select 1 from cron.job where jobname = 'qoc-monitoring-snapshot-every-five-minutes'
);
