-- Fixed-size history for dashboard charts. This keeps the executive view
-- legible as the platform grows while retaining the full time span.
create or replace function public.qoc_user_growth_series(p_points integer default 13)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_points integer := greatest(2, least(coalesce(p_points, 13), 24));
  v_start_date date;
  v_span_days integer;
begin
  if not public.qoc_is_authorized() then
    raise exception 'qoc_access_denied' using errcode = '42501';
  end if;

  select coalesce(min(created_at)::date, current_date)
    into v_start_date
    from public.community_profiles;
  v_span_days := greatest(0, current_date - v_start_date);

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'date', checkpoint,
        'users', (select count(*) from public.community_profiles p where p.created_at::date <= checkpoint)
      )
      order by ordinal
    )
    from (
      select ordinal,
        (v_start_date + floor((v_span_days::numeric * ordinal) / (v_points - 1))::integer)::date as checkpoint
      from generate_series(0, v_points - 1) as point(ordinal)
    ) checkpoints
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.qoc_user_growth_series(integer) from public;
grant execute on function public.qoc_user_growth_series(integer) to authenticated;
