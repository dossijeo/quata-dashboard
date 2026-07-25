-- Audited server-side geocoding for the citizen-security module.
-- Google-derived coordinates are returned on demand and are not persisted.

drop function if exists public.qoc_citizen_security_log_geocode(uuid, text[], integer, integer, text);
drop function if exists public.qoc_citizen_security_log_geocode(uuid, text[], integer, integer, integer, text);

create or replace function public.qoc_citizen_security_log_geocode(
  p_target_user_id uuid,
  p_evidence_ids text[] default '{}',
  p_resolved_count integer default 0,
  p_ambiguous_count integer default 0,
  p_rejected_count integer default 0,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, security_citizen, pg_temp
as $$
declare
  v_actor uuid := security_citizen.assert_access();
begin
  if not exists (
    select 1
    from security_citizen.v_users
    where user_id = p_target_user_id
  ) then
    raise exception 'security_user_not_found' using errcode = 'P0002';
  end if;

  return security_citizen.log_access(
    'LOCATION_GEOCODE_RESOLVE',
    'LOCATION_TIMELINE',
    null,
    p_target_user_id,
    p_reason,
    jsonb_build_object(
      'evidenceCount', cardinality(coalesce(p_evidence_ids, '{}')),
      'evidenceIds', coalesce(to_jsonb(p_evidence_ids), '[]'::jsonb)
    ),
    jsonb_build_object(
      'resolvedCount', greatest(0, coalesce(p_resolved_count, 0)),
      'ambiguousCount', greatest(0, coalesce(p_ambiguous_count, 0)),
      'rejectedCount', greatest(0, coalesce(p_rejected_count, 0)),
      'provider', 'GOOGLE_MAPS'
    )
  );
end;
$$;

revoke all on function public.qoc_citizen_security_log_geocode(uuid, text[], integer, integer, integer, text)
  from public, anon;
grant execute on function public.qoc_citizen_security_log_geocode(uuid, text[], integer, integer, integer, text)
  to authenticated;
