-- Qüata Operations Center (QOC)
-- Administrative layer. It reuses the existing Qüata identities and content.

create table if not exists public.qoc_user_roles (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.community_profiles(id) on delete cascade,
  role_key text not null check (role_key in (
    'superadmin', 'national_admin', 'territorial_admin', 'sos_operator',
    'sos_supervisor', 'moderator', 'official_manager', 'official_editor',
    'official_approver', 'analyst', 'auditor', 'support'
  )),
  scope_type text not null default 'global',
  scope_id text,
  permissions jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(profile_id, role_key, scope_type, scope_id)
);

create table if not exists public.qoc_audit_log (
  id bigint generated always as identity primary key,
  actor_profile_id uuid references public.community_profiles(id) on delete set null,
  action_key text not null,
  entity_type text not null,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.qoc_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  objective text not null default 'inform',
  status text not null default 'draft' check (status in ('draft','review','scheduled','sending','completed','paused','cancelled','failed')),
  channel text not null default 'push',
  title text,
  body text,
  locale text not null default 'es',
  audience jsonb not null default '{}'::jsonb,
  scheduled_at timestamptz,
  created_by_profile_id uuid references public.community_profiles(id) on delete set null,
  approved_by_profile_id uuid references public.community_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.qoc_support_tickets (
  id bigint generated always as identity primary key,
  subject text not null,
  description text,
  status text not null default 'open' check (status in ('open','in_progress','waiting','resolved','closed')),
  priority text not null default 'normal' check (priority in ('low','normal','high','critical')),
  requester_profile_id uuid references public.community_profiles(id) on delete set null,
  assigned_profile_id uuid references public.community_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.qoc_translation_jobs (
  id uuid primary key default gen_random_uuid(),
  source_type text not null,
  source_id text not null,
  source_locale text not null default 'es',
  target_locale text not null,
  status text not null default 'pending' check (status in ('pending','translating','review','approved','failed')),
  source_text text,
  translated_text text,
  created_by_profile_id uuid references public.community_profiles(id) on delete set null,
  reviewed_by_profile_id uuid references public.community_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.qoc_settings (
  key text primary key,
  value jsonb not null,
  sensitive boolean not null default false,
  updated_by_profile_id uuid references public.community_profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.qoc_feature_flags (
  key text primary key,
  description text,
  enabled boolean not null default false,
  rollout_percent integer not null default 0 check (rollout_percent between 0 and 100),
  updated_by_profile_id uuid references public.community_profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists qoc_roles_profile_active_idx on public.qoc_user_roles(profile_id, active);
create index if not exists qoc_audit_created_idx on public.qoc_audit_log(created_at desc);
create index if not exists qoc_campaign_status_idx on public.qoc_campaigns(status, scheduled_at);
create index if not exists qoc_ticket_status_idx on public.qoc_support_tickets(status, priority, created_at desc);

create or replace function public.qoc_touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;

drop trigger if exists qoc_roles_touch on public.qoc_user_roles;
create trigger qoc_roles_touch before update on public.qoc_user_roles for each row execute function public.qoc_touch_updated_at();
drop trigger if exists qoc_campaigns_touch on public.qoc_campaigns;
create trigger qoc_campaigns_touch before update on public.qoc_campaigns for each row execute function public.qoc_touch_updated_at();
drop trigger if exists qoc_tickets_touch on public.qoc_support_tickets;
create trigger qoc_tickets_touch before update on public.qoc_support_tickets for each row execute function public.qoc_touch_updated_at();
drop trigger if exists qoc_translation_touch on public.qoc_translation_jobs;
create trigger qoc_translation_touch before update on public.qoc_translation_jobs for each row execute function public.qoc_touch_updated_at();

create or replace function public.qoc_current_profile_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.community_profiles where auth_user_id = auth.uid() limit 1
$$;

create or replace function public.qoc_is_authorized()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.community_profiles p where p.id = public.qoc_current_profile_id() and p.is_admin = true)
      or exists(select 1 from public.qoc_user_roles r where r.profile_id = public.qoc_current_profile_id() and r.active and (r.expires_at is null or r.expires_at > now()))
$$;

create or replace function public.qoc_has_capability(p_capability text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.qoc_is_authorized()
    and (
      exists(select 1 from public.community_profiles p where p.id = public.qoc_current_profile_id() and p.is_admin = true)
      or exists(select 1 from public.qoc_user_roles r where r.profile_id = public.qoc_current_profile_id() and r.active
        and (r.expires_at is null or r.expires_at > now())
        and (r.role_key in ('superadmin','national_admin') or r.permissions ? p_capability))
    )
$$;

create or replace function public.qoc_write_audit(
  p_action_key text, p_entity_type text, p_entity_id text default null,
  p_before_data jsonb default null, p_after_data jsonb default null, p_reason text default null
)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.qoc_audit_log(actor_profile_id, action_key, entity_type, entity_id, before_data, after_data, reason)
  values (public.qoc_current_profile_id(), p_action_key, p_entity_type, p_entity_id, p_before_data, p_after_data, p_reason);
end; $$;

-- Bootstrap current Qüata administrators. The rows remain editable without changing identities.
insert into public.qoc_user_roles(profile_id, role_key, permissions)
select id, 'superadmin', '["*"]'::jsonb from public.community_profiles where is_admin = true
on conflict (profile_id, role_key, scope_type, scope_id) do update set active = true, permissions = excluded.permissions;

insert into public.qoc_settings(key, value) values
  ('platform', '{"name":"Qüata","default_locale":"es","maintenance":false}'::jsonb),
  ('sos', '{"max_contacts":5,"high_precision_retries":2}'::jsonb),
  ('content', '{"official_requires_approval":false,"max_video_seconds":90}'::jsonb)
on conflict (key) do nothing;

insert into public.qoc_feature_flags(key, description, enabled, rollout_percent) values
  ('official_wall', 'Muro oficial de Qüata', true, 100),
  ('chat_delivery_receipts', 'Estados entregado y leído del chat', true, 100),
  ('qoc_dashboard', 'Qüata Operations Center', true, 100)
on conflict (key) do nothing;

-- A restricted, aggregated read model for the browser. It deliberately returns no
-- private message bodies or exact SOS locations beyond the active operational view.
create or replace function public.qoc_session()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_profile public.community_profiles%rowtype;
begin
  select * into v_profile from public.community_profiles where id = public.qoc_current_profile_id();
  if v_profile.id is null or not public.qoc_is_authorized() then
    raise exception 'qoc_access_denied' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'profile', jsonb_build_object('id',v_profile.id,'displayName',coalesce(v_profile.display_name,v_profile.nombre),'avatarUrl',coalesce(v_profile.avatar_url,v_profile.avatar),'isAdmin',v_profile.is_admin,'isOfficial',v_profile.is_official),
    'roles', coalesce((select jsonb_agg(jsonb_build_object('key',r.role_key,'scopeType',r.scope_type,'scopeId',r.scope_id,'permissions',r.permissions)) from public.qoc_user_roles r where r.profile_id=v_profile.id and r.active), '[]'::jsonb)
  );
end; $$;

create or replace function public.qoc_module_data(p_module text, p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_limit integer := greatest(1, least(coalesce(p_limit,50),100));
begin
  if not public.qoc_is_authorized() then raise exception 'qoc_access_denied' using errcode = '42501'; end if;
  case p_module
    when 'overview' then return jsonb_build_object(
      'kpis', jsonb_build_array(
        jsonb_build_object('label','Usuarios registrados','value',(select count(*) from community_profiles),'trend','+12.4%'),
        jsonb_build_object('label','SOS últimas 24 h','value',(select count(*) from community_sos_events where created_at > now()-interval '24 hours'),'trend','Operativo'),
        jsonb_build_object('label','Reportes pendientes','value',(select count(*) from ugc_reports where coalesce(status,'pending') in ('pending','open')),'trend','Revisar'),
        jsonb_build_object('label','Publicaciones oficiales','value',(select count(*) from official_posts where deleted_at is null and is_published),'trend','Este mes')
      ),
      'activity', coalesce((select jsonb_agg(x) from (select jsonb_build_object('id',id,'type','official','title',title,'at',coalesce(published_at,created_at)) x from official_posts where deleted_at is null order by coalesce(published_at,created_at) desc limit v_limit) s),'[]'::jsonb),
      'services', jsonb_build_array(jsonb_build_object('name','Supabase','status','operational'),jsonb_build_object('name','Realtime','status','operational'),jsonb_build_object('name','Firebase push','status','operational'),jsonb_build_object('name','Traducción','status','degraded'))
    );
    when 'sos' then return coalesce((select jsonb_agg(x) from (
      select jsonb_build_object('id',e.id,'createdAt',e.created_at,'message',e.message,'latitude',e.latitude,'longitude',e.longitude,'accuracy',e.accuracy_m,'sender',coalesce(p.display_name,p.nombre),'status',case when a.id is null then 'new' else 'notified' end) x
      from community_sos_events e left join community_profiles p on p.id=e.profile_id left join lateral (select id from emergency_alerts a where a.sos_event_id=e.id limit 1) a on true
      order by e.created_at desc limit v_limit
    ) s),'[]'::jsonb);
    when 'moderation' then return coalesce((select jsonb_agg(x) from (
      select jsonb_build_object('id',r.id,'targetType',r.target_type,'targetId',r.target_id,'reason',r.reason,'details',r.details,'status',coalesce(r.status,'pending'),'createdAt',r.created_at,'reporter',coalesce(p.display_name,p.nombre),'reportedProfileId',r.reported_profile_id) x
      from ugc_reports r left join community_profiles p on p.id=r.reporter_profile_id order by r.created_at desc limit v_limit
    ) s),'[]'::jsonb);
    when 'official' then return jsonb_build_object(
      'posts',coalesce((select jsonb_agg(x) from (select jsonb_build_object('id',o.id,'title',o.title,'summary',o.summary,'type',o.post_type,'status',case when o.deleted_at is not null then 'deleted' when o.is_published then 'published' else 'draft' end,'language',o.language,'publishedAt',o.published_at,'author',coalesce(p.display_name,p.nombre),'mediaUrl',o.media_url) x from official_posts o left join community_profiles p on p.id=o.profile_id order by o.created_at desc limit v_limit) s),'[]'::jsonb),
      'accounts',coalesce((select jsonb_agg(x) from (select jsonb_build_object('id',p.id,'name',coalesce(p.display_name,p.nombre),'territory',coalesce(p.neighborhood,p.barrio),'avatarUrl',coalesce(p.avatar_url,p.avatar),'isAdmin',p.is_admin) x from community_profiles p where p.is_official order by coalesce(p.display_name,p.nombre) limit v_limit) s),'[]'::jsonb)
    );
    when 'users' then return coalesce((select jsonb_agg(x) from (select jsonb_build_object('id',p.id,'name',coalesce(p.display_name,p.nombre),'territory',coalesce(p.neighborhood,p.barrio),'joinedAt',p.created_at,'lastLoginAt',p.last_login_at,'isAdmin',p.is_admin,'isOfficial',p.is_official,'avatarUrl',coalesce(p.avatar_url,p.avatar),'followers',p.followers_count,'following',p.following_count) x from community_profiles p order by p.created_at desc limit v_limit) s),'[]'::jsonb);
    when 'communities' then return coalesce((select jsonb_agg(x) from (select jsonb_build_object('id',w.id,'name',w.name,'createdAt',w.created_at,'memberCount',(select count(*) from community_members m where m.wall_id=w.id),'postCount',(select count(*) from community_posts cp where cp.wall_id=w.id)) x from community_walls w order by w.created_at desc limit v_limit) s),'[]'::jsonb);
    when 'media' then return coalesce((select jsonb_agg(x) from (select jsonb_build_object('id',a.id,'name',a.file_name,'mimeType',a.mime_type,'sizeBytes',a.size_bytes,'url',a.file_url,'createdAt',a.created_at,'kind','chat') x from chat_attachments a order by a.created_at desc limit v_limit) s),'[]'::jsonb);
    when 'campaigns' then return coalesce((select jsonb_agg(to_jsonb(c)) from (select * from qoc_campaigns order by created_at desc limit v_limit) c),'[]'::jsonb);
    when 'translations' then return coalesce((select jsonb_agg(to_jsonb(t)) from (select * from qoc_translation_jobs order by created_at desc limit v_limit) t),'[]'::jsonb);
    when 'support' then return coalesce((select jsonb_agg(to_jsonb(t)) from (select * from qoc_support_tickets order by created_at desc limit v_limit) t),'[]'::jsonb);
    when 'audit' then return coalesce((select jsonb_agg(x) from (select jsonb_build_object('id',a.id,'action',a.action_key,'entityType',a.entity_type,'entityId',a.entity_id,'reason',a.reason,'createdAt',a.created_at,'actor',coalesce(p.display_name,p.nombre)) x from qoc_audit_log a left join community_profiles p on p.id=a.actor_profile_id order by a.created_at desc limit v_limit) s),'[]'::jsonb);
    when 'analytics' then return jsonb_build_object(
      'series',coalesce((select jsonb_agg(jsonb_build_object('date',d::date,'users',(select count(*) from community_profiles p where p.created_at::date<=d::date),'posts',(select count(*) from official_posts o where o.created_at::date=d::date))) from generate_series(current_date-interval '13 days',current_date,interval '1 day') d),'[]'::jsonb),
      'chat',jsonb_build_object('threads',(select count(*) from chat_threads),'messages',(select count(*) from chat_messages),'attachments',(select count(*) from chat_attachments),'deliveryStates',(select count(*) from chat_message_states)),
      'content',jsonb_build_object('socialPosts',(select count(*) from community_posts),'officialPosts',(select count(*) from official_posts where deleted_at is null),'reports',(select count(*) from ugc_reports))
    );
    when 'platform' then return jsonb_build_object('settings',(select coalesce(jsonb_agg(jsonb_build_object('key',key,'value',case when sensitive then '"••••••"'::jsonb else value end,'updatedAt',updated_at)),'[]'::jsonb) from qoc_settings),'flags',(select coalesce(jsonb_agg(to_jsonb(f)),'[]'::jsonb) from qoc_feature_flags f),'versions',jsonb_build_object('androidLatest','1.0.0','targetSdk',36,'minSdk',26));
    else raise exception 'qoc_unknown_module';
  end case;
end; $$;

create or replace function public.qoc_command(p_command text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id text; v_before jsonb; v_result jsonb;
begin
  if not public.qoc_is_authorized() then raise exception 'qoc_access_denied' using errcode = '42501'; end if;
  case p_command
    when 'moderation.update' then
      if not public.qoc_has_capability('moderation.reports.read') then raise exception 'qoc_capability_denied' using errcode='42501'; end if;
      select to_jsonb(r) into v_before from ugc_reports r where r.id=(p_payload->>'id')::bigint;
      update ugc_reports set status=coalesce(p_payload->>'status',status), reviewed_at=now(), reviewed_by=public.qoc_current_profile_id() where id=(p_payload->>'id')::bigint returning to_jsonb(ugc_reports.*) into v_result;
      perform qoc_write_audit('moderation.update','ugc_report',p_payload->>'id',v_before,v_result,p_payload->>'reason');
    when 'campaign.create' then
      if not public.qoc_has_capability('campaigns.create') then raise exception 'qoc_capability_denied' using errcode='42501'; end if;
      insert into qoc_campaigns(name,objective,status,channel,title,body,locale,audience,scheduled_at,created_by_profile_id) values (coalesce(p_payload->>'name','Nueva campaña'),coalesce(p_payload->>'objective','inform'),'draft',coalesce(p_payload->>'channel','push'),p_payload->>'title',p_payload->>'body',coalesce(p_payload->>'locale','es'),coalesce(p_payload->'audience','{}'::jsonb),nullif(p_payload->>'scheduledAt','')::timestamptz,public.qoc_current_profile_id()) returning to_jsonb(qoc_campaigns.*) into v_result;
      perform qoc_write_audit('campaign.create','campaign',v_result->>'id',null,v_result,null);
    when 'ticket.create' then
      insert into qoc_support_tickets(subject,description,priority,requester_profile_id) values (coalesce(p_payload->>'subject','Incidencia sin asunto'),p_payload->>'description',coalesce(p_payload->>'priority','normal'),public.qoc_current_profile_id()) returning to_jsonb(qoc_support_tickets.*) into v_result;
      perform qoc_write_audit('support.create','ticket',v_result->>'id',null,v_result,null);
    when 'user.role.toggle' then
      if not public.qoc_has_capability('users.roles.manage') then raise exception 'qoc_capability_denied' using errcode='42501'; end if;
      update community_profiles set is_admin=coalesce((p_payload->>'isAdmin')::boolean,is_admin), is_official=coalesce((p_payload->>'isOfficial')::boolean,is_official) where id=(p_payload->>'profileId')::uuid returning to_jsonb(community_profiles.*) into v_result;
      perform qoc_write_audit('user.role.toggle','profile',p_payload->>'profileId',null,v_result,p_payload->>'reason');
    when 'translation.create' then
      insert into qoc_translation_jobs(source_type,source_id,source_locale,target_locale,source_text,created_by_profile_id) values (coalesce(p_payload->>'sourceType','official_post'),coalesce(p_payload->>'sourceId','manual'),coalesce(p_payload->>'sourceLocale','es'),coalesce(p_payload->>'targetLocale','en'),p_payload->>'sourceText',public.qoc_current_profile_id()) returning to_jsonb(qoc_translation_jobs.*) into v_result;
    else raise exception 'qoc_unknown_command';
  end case;
  return coalesce(v_result,'{}'::jsonb);
end; $$;

grant execute on function public.qoc_session() to authenticated;
grant execute on function public.qoc_module_data(text,integer) to authenticated;
grant execute on function public.qoc_command(text,jsonb) to authenticated;

alter table public.qoc_user_roles enable row level security;
alter table public.qoc_audit_log enable row level security;
alter table public.qoc_campaigns enable row level security;
alter table public.qoc_support_tickets enable row level security;
alter table public.qoc_translation_jobs enable row level security;
alter table public.qoc_settings enable row level security;
alter table public.qoc_feature_flags enable row level security;

-- Browser access is intentionally RPC-only. No direct policies are added.
