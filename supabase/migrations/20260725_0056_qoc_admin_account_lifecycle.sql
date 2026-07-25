-- Administrative account lifecycle controls for QOC.
-- Self-service Android calls keep using the existing functions unchanged.

alter table public.community_profiles
  add column if not exists deactivated_auth_user_id uuid;

create index if not exists community_profiles_deactivated_auth_user_idx
  on public.community_profiles(deactivated_auth_user_id)
  where deactivated_auth_user_id is not null;

create or replace function public.quata_account_deactivate(
  p_profile_id uuid,
  p_auth_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_updated integer;
begin
  update public.community_profiles
     set account_status = 'deactivated',
         deactivated_at = now(),
         deactivated_auth_user_id = p_auth_user_id,
         auth_user_id = null
   where id = p_profile_id
     and auth_user_id = p_auth_user_id
     and account_status = 'active';
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'active account identity mismatch' using errcode = '42501';
  end if;

  delete from public.push_tokens
   where user_id = p_profile_id or auth_user_id = p_auth_user_id;

  return jsonb_build_object('ok', true, 'profile_id', p_profile_id);
end;
$$;

create or replace function public.quata_account_reactivate(
  p_profile_id uuid,
  p_auth_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_updated integer;
begin
  update public.community_profiles
     set account_status = 'active',
         deactivated_at = null,
         auth_user_id = p_auth_user_id,
         deactivated_auth_user_id = null
   where id = p_profile_id
     and account_status = 'deactivated'
     and (deactivated_auth_user_id is null or deactivated_auth_user_id = p_auth_user_id);
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'deactivated account identity mismatch' using errcode = '42501';
  end if;

  return jsonb_build_object('ok', true, 'profile_id', p_profile_id);
end;
$$;

-- These wrappers let the administrative Edge Function reuse the complete
-- self-service cleanup without leaving a deactivated account active between
-- independent network operations.
create or replace function public.quata_account_collect_deletion_assets_admin(
  p_profile_id uuid,
  p_auth_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_status text;
  v_deactivated_at timestamptz;
  v_deactivated_auth_user_id uuid;
  v_result jsonb;
begin
  select account_status, deactivated_at, deactivated_auth_user_id
    into v_status, v_deactivated_at, v_deactivated_auth_user_id
    from public.community_profiles
   where id = p_profile_id
     and (
       auth_user_id = p_auth_user_id
       or deactivated_auth_user_id = p_auth_user_id
       or (account_status = 'deactivated' and deactivated_auth_user_id is null)
     )
   for update;
  if not found then
    raise exception 'account identity mismatch' using errcode = '42501';
  end if;

  if v_status = 'deactivated' then
    update public.community_profiles
       set account_status = 'active', auth_user_id = p_auth_user_id
     where id = p_profile_id;
  end if;

  v_result := public.quata_account_collect_deletion_assets(p_profile_id, p_auth_user_id);

  if v_status = 'deactivated' then
    update public.community_profiles
       set account_status = 'deactivated',
           deactivated_at = v_deactivated_at,
           auth_user_id = null,
           deactivated_auth_user_id = coalesce(v_deactivated_auth_user_id, p_auth_user_id)
     where id = p_profile_id;
  end if;

  return v_result;
end;
$$;

create or replace function public.quata_account_delete_data_admin(
  p_profile_id uuid,
  p_auth_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_status text;
begin
  select account_status
    into v_status
    from public.community_profiles
   where id = p_profile_id
     and (
       auth_user_id = p_auth_user_id
       or deactivated_auth_user_id = p_auth_user_id
       or (account_status = 'deactivated' and deactivated_auth_user_id is null)
     )
   for update;
  if not found then
    raise exception 'account identity mismatch' using errcode = '42501';
  end if;

  if v_status = 'deactivated' then
    update public.community_profiles
       set account_status = 'active', auth_user_id = p_auth_user_id
     where id = p_profile_id;
  end if;

  return public.quata_account_delete_data(p_profile_id, p_auth_user_id);
end;
$$;

create or replace function public.qoc_official_profiles(
  p_query text default null,
  p_territory text default 'all',
  p_account_type text default 'all',
  p_page integer default 1,
  p_page_size integer default 20
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_page integer := greatest(1, coalesce(p_page, 1));
  v_size integer := greatest(1, least(coalesce(p_page_size, 20), 50));
  v_query text := nullif(btrim(p_query), '');
  v_territory text := coalesce(nullif(btrim(p_territory), ''), 'all');
  v_type text := coalesce(nullif(btrim(p_account_type), ''), 'all');
  v_total integer;
begin
  if not public.qoc_is_authorized() then raise exception 'qoc_access_denied' using errcode = '42501'; end if;

  select count(*) into v_total
  from public.community_profiles p
  where (v_query is null or concat_ws(' ', p.display_name, p.nombre, p.neighborhood, p.barrio) ilike '%' || v_query || '%')
    and (v_territory = 'all' or coalesce(nullif(p.neighborhood, ''), nullif(p.barrio, ''), 'Sin barrio') = v_territory)
    and case v_type
      when 'official' then p.is_official
      when 'admin' then p.is_admin
      when 'official_admin' then p.is_official and p.is_admin
      when 'standard' then not p.is_official and not p.is_admin
      else true
    end;

  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(row_data) from (
      select jsonb_build_object(
        'id', p.id,
        'name', coalesce(p.display_name, p.nombre, 'Cuenta sin nombre'),
        'avatarUrl', coalesce(p.avatar_url, p.avatar),
        'territory', coalesce(nullif(p.neighborhood, ''), nullif(p.barrio, ''), 'Sin barrio'),
        'isOfficial', p.is_official,
        'isAdmin', p.is_admin,
        'accountStatus', coalesce(p.account_status, 'active'),
        'deactivatedAt', p.deactivated_at,
        'followers', (select count(*)::integer from public.community_profile_follows f where f.followed_profile_id = p.id),
        'following', (select count(*)::integer from public.community_profile_follows f where f.follower_profile_id = p.id),
        'joinedAt', p.created_at,
        'lastLoginAt', p.last_login_at
      ) as row_data
      from public.community_profiles p
      where (v_query is null or concat_ws(' ', p.display_name, p.nombre, p.neighborhood, p.barrio) ilike '%' || v_query || '%')
        and (v_territory = 'all' or coalesce(nullif(p.neighborhood, ''), nullif(p.barrio, ''), 'Sin barrio') = v_territory)
        and case v_type
          when 'official' then p.is_official
          when 'admin' then p.is_admin
          when 'official_admin' then p.is_official and p.is_admin
          when 'standard' then not p.is_official and not p.is_admin
          else true
        end
      order by (p.account_status = 'deactivated') asc, p.is_official desc, p.is_admin desc,
               coalesce(p.display_name, p.nombre, '') asc
      offset (v_page - 1) * v_size limit v_size
    ) listed), '[]'::jsonb),
    'territories', coalesce((select jsonb_agg(territory order by territory) from (
      select distinct coalesce(nullif(neighborhood, ''), nullif(barrio, ''), 'Sin barrio') as territory
      from public.community_profiles
    ) territories), '[]'::jsonb),
    'total', v_total,
    'page', v_page,
    'pageSize', v_size
  );
end;
$$;

revoke all on function public.quata_account_reactivate(uuid, uuid) from public, anon, authenticated;
revoke all on function public.quata_account_collect_deletion_assets_admin(uuid, uuid) from public, anon, authenticated;
revoke all on function public.quata_account_delete_data_admin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.quata_account_reactivate(uuid, uuid) to service_role;
grant execute on function public.quata_account_collect_deletion_assets_admin(uuid, uuid) to service_role;
grant execute on function public.quata_account_delete_data_admin(uuid, uuid) to service_role;
grant execute on function public.qoc_official_profiles(text,text,text,integer,integer) to authenticated;
