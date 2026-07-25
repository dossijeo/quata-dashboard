-- Read-only catalogue used by the Android "About" release history.
-- It deliberately does not touch user_app_release_state: browsing history is not acknowledgement.
create or replace function public.quata_android_release_history(
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
begin
    if public.quata_current_profile_id() is null then
        raise exception 'authentication_required' using errcode = '42501';
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
    group by release.id, release.version_code, release.version_name
    having count(*) filter (where length(trim(note.note_text)) > 0) > 0
    order by release.version_code desc;
end;
$$;

revoke all on function public.quata_android_release_history(text) from public;
grant execute on function public.quata_android_release_history(text) to authenticated;
