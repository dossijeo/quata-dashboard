begin;
select set_config('request.jwt.claim.sub','3104e53d-ac12-430f-9397-73843075d892',true);
select qoc_session() as session;
select jsonb_array_length(qoc_module_data('overview')->'kpis') as overview_kpis,
       jsonb_array_length(qoc_module_data('sos')) as sos_rows,
       jsonb_typeof(qoc_module_data('official')) as official_shape;
select qoc_command(
  'ticket.create',
  '{"subject":"QOC smoke test","description":"Temporary transaction validation","priority":"low"}'::jsonb
) as ticket;
rollback;
