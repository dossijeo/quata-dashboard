-- Configuration was read-only in QOC and had no runtime consumer.
-- Keep the platform payload used by Versions, without qoc_settings.
do $$
declare
  v_definition text;
begin
  v_definition := pg_get_functiondef('public.qoc_module_data(text, integer)'::regprocedure);
  v_definition := regexp_replace(
    v_definition,
    $pattern$when 'platform' then return .*?;\s*else raise exception 'qoc_unknown_module';$pattern$,
    $replacement$when 'platform' then return jsonb_build_object('versions',jsonb_build_object('androidLatest','1.0.0','targetSdk',36,'minSdk',26));
    else raise exception 'qoc_unknown_module';$replacement$,
    's'
  );
  execute v_definition;
end $$;

drop table if exists public.qoc_settings;
