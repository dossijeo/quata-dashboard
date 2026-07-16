insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('official-media', 'official-media', true, 104857600, array['image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "QOC official media upload" on storage.objects;
create policy "QOC official media upload" on storage.objects for insert to authenticated
with check (
  bucket_id = 'official-media'
  and exists (select 1 from public.community_profiles p where p.auth_user_id = auth.uid() and (p.is_official or p.is_admin))
);

drop policy if exists "QOC official media update" on storage.objects;
create policy "QOC official media update" on storage.objects for update to authenticated
using (bucket_id = 'official-media' and exists (select 1 from public.community_profiles p where p.auth_user_id = auth.uid() and (p.is_official or p.is_admin)))
with check (bucket_id = 'official-media' and exists (select 1 from public.community_profiles p where p.auth_user_id = auth.uid() and (p.is_official or p.is_admin)));

drop policy if exists "QOC official media delete" on storage.objects;
create policy "QOC official media delete" on storage.objects for delete to authenticated
using (bucket_id = 'official-media' and exists (select 1 from public.community_profiles p where p.auth_user_id = auth.uid() and (p.is_official or p.is_admin)));
