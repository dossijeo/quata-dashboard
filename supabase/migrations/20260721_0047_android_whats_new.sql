-- Google Play release archive and per-account Android "What's new" state.
-- Google Play remains the editorial source; this schema only retains the
-- historical releases and the read progress needed by Android clients.

create table if not exists public.android_releases (
    id uuid primary key default gen_random_uuid(),
    package_name text not null,
    track text not null default 'production',
    -- Canonical code shown to clients. For a Play release with several APK/AAB
    -- codes this is the greatest code; the complete set remains below.
    version_code bigint not null check (version_code > 0),
    version_codes bigint[] not null default '{}',
    version_name text,
    release_status text not null default 'completed',
    rollout_fraction numeric,
    estimated_published_at timestamptz,
    first_synced_at timestamptz not null default now(),
    last_synced_at timestamptz not null default now(),
    visible_in_whats_new boolean not null default true,
    language_count integer not null default 0,
    source_payload jsonb,
    archived_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint android_releases_package_track_code_key unique (package_name, track, version_code),
    constraint android_releases_codes_include_canonical check (version_code = any(version_codes))
);

create index if not exists android_releases_pending_idx
    on public.android_releases (package_name, track, visible_in_whats_new, version_code asc);

create table if not exists public.android_release_notes (
    release_id uuid not null references public.android_releases(id) on delete cascade,
    language_tag text not null,
    note_text text not null,
    updated_at timestamptz not null default now(),
    primary key (release_id, language_tag),
    constraint android_release_notes_nonempty check (length(trim(note_text)) > 0)
);

create index if not exists android_release_notes_release_idx
    on public.android_release_notes (release_id);

create table if not exists public.user_app_release_state (
    user_id uuid not null references public.community_profiles(id) on delete cascade,
    platform text not null default 'android',
    last_seen_version_code bigint,
    initialized_at_version_code bigint,
    updated_at timestamptz not null default now(),
    primary key (user_id, platform),
    constraint user_app_release_state_codes_valid check (
        (last_seen_version_code is null or last_seen_version_code >= 0)
        and (initialized_at_version_code is null or initialized_at_version_code >= 0)
    )
);

create index if not exists user_app_release_state_platform_idx
    on public.user_app_release_state (platform, updated_at desc);

create or replace function public.quata_touch_android_release_row()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists android_releases_touch_updated_at on public.android_releases;
create trigger android_releases_touch_updated_at
before update on public.android_releases
for each row execute function public.quata_touch_android_release_row();

-- A stale device must never reduce the state established by a newer device.
create or replace function public.quata_guard_release_state_progress()
returns trigger
language plpgsql
as $$
begin
    if old.last_seen_version_code is not null
       and (new.last_seen_version_code is null or new.last_seen_version_code < old.last_seen_version_code) then
        new.last_seen_version_code = old.last_seen_version_code;
    end if;
    if old.initialized_at_version_code is not null
       and (new.initialized_at_version_code is null or new.initialized_at_version_code < old.initialized_at_version_code) then
        new.initialized_at_version_code = old.initialized_at_version_code;
    end if;
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists user_app_release_state_guard_progress on public.user_app_release_state;
create trigger user_app_release_state_guard_progress
before update on public.user_app_release_state
for each row execute function public.quata_guard_release_state_progress();

alter table public.android_releases enable row level security;
alter table public.android_release_notes enable row level security;
alter table public.user_app_release_state enable row level security;

revoke all on public.android_releases, public.android_release_notes, public.user_app_release_state from anon;
revoke insert, update, delete on public.android_releases, public.android_release_notes from authenticated;

drop policy if exists android_releases_authenticated_read on public.android_releases;
create policy android_releases_authenticated_read
on public.android_releases for select to authenticated
using (visible_in_whats_new);

drop policy if exists android_release_notes_authenticated_read on public.android_release_notes;
create policy android_release_notes_authenticated_read
on public.android_release_notes for select to authenticated
using (
    exists (
        select 1 from public.android_releases release
        where release.id = android_release_notes.release_id
          and release.visible_in_whats_new
    )
);

drop policy if exists user_app_release_state_own_read on public.user_app_release_state;
create policy user_app_release_state_own_read
on public.user_app_release_state for select to authenticated
using (user_id = public.quata_current_profile_id());

-- Direct writes are intentionally not granted to Android. The equivalent own
-- insert/update policies document the ownership boundary; writes happen via the
-- RPC below so progress can only move forward.
drop policy if exists user_app_release_state_own_insert on public.user_app_release_state;
create policy user_app_release_state_own_insert
on public.user_app_release_state for insert to authenticated
with check (user_id = public.quata_current_profile_id());

drop policy if exists user_app_release_state_own_update on public.user_app_release_state;
create policy user_app_release_state_own_update
on public.user_app_release_state for update to authenticated
using (user_id = public.quata_current_profile_id())
with check (user_id = public.quata_current_profile_id());

revoke insert, update, delete on public.user_app_release_state from authenticated;

create or replace function public.quata_pending_android_releases(
    p_installed_version_code bigint,
    p_track text default 'production'
)
returns table (
    release_id uuid,
    version_code bigint,
    version_name text,
    notes jsonb,
    available_language_tags text[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_profile_id uuid := public.quata_current_profile_id();
    v_last_seen bigint;
begin
    if v_profile_id is null then
        raise exception 'authentication_required' using errcode = '42501';
    end if;
    if p_installed_version_code is null or p_installed_version_code <= 0 then
        raise exception 'installed_version_code_invalid';
    end if;

    select state.last_seen_version_code
    into v_last_seen
    from public.user_app_release_state state
    where state.user_id = v_profile_id
      and state.platform = 'android';

    -- Safe bootstrap for both new installs and accounts predating this feature:
    -- establish the installed code without opening a historical changelog.
    if not found then
        insert into public.user_app_release_state (
            user_id, platform, last_seen_version_code, initialized_at_version_code
        ) values (
            v_profile_id, 'android', p_installed_version_code, p_installed_version_code
        ) on conflict (user_id, platform) do nothing;
        return;
    end if;

    return query
    select
        release.id,
        release.version_code,
        release.version_name,
        jsonb_object_agg(note.language_tag, note.note_text order by note.language_tag),
        array_agg(note.language_tag order by note.language_tag)
    from public.android_releases release
    join public.android_release_notes note on note.release_id = release.id
    where release.package_name = 'com.quata'
      and release.track = coalesce(nullif(trim(p_track), ''), 'production')
      and release.visible_in_whats_new
      and release.version_code > coalesce(v_last_seen, 0)
      and release.version_code <= p_installed_version_code
    group by release.id, release.version_code, release.version_name
    having count(*) filter (where length(trim(note.note_text)) > 0) > 0
    order by release.version_code asc;
end;
$$;

create or replace function public.quata_mark_android_releases_seen(
    p_up_to_version_code bigint,
    p_installed_version_code bigint
)
returns public.user_app_release_state
language plpgsql
security definer
set search_path = public
as $$
declare
    v_profile_id uuid := public.quata_current_profile_id();
    v_state public.user_app_release_state;
begin
    if v_profile_id is null then
        raise exception 'authentication_required' using errcode = '42501';
    end if;
    if p_up_to_version_code is null or p_installed_version_code is null
       or p_up_to_version_code < 0 or p_installed_version_code <= 0
       or p_up_to_version_code > p_installed_version_code then
        raise exception 'release_progress_invalid';
    end if;

    insert into public.user_app_release_state (
        user_id, platform, last_seen_version_code, initialized_at_version_code
    ) values (
        v_profile_id, 'android', p_up_to_version_code, p_installed_version_code
    )
    on conflict (user_id, platform) do update set
        last_seen_version_code = greatest(
            coalesce(public.user_app_release_state.last_seen_version_code, 0),
            excluded.last_seen_version_code
        ),
        initialized_at_version_code = greatest(
            coalesce(public.user_app_release_state.initialized_at_version_code, 0),
            excluded.initialized_at_version_code
        ),
        updated_at = now()
    returning * into v_state;

    return v_state;
end;
$$;

revoke all on function public.quata_pending_android_releases(bigint, text) from public;
revoke all on function public.quata_mark_android_releases_seen(bigint, bigint) from public;
grant execute on function public.quata_pending_android_releases(bigint, text) to authenticated;
grant execute on function public.quata_mark_android_releases_seen(bigint, bigint) to authenticated;
