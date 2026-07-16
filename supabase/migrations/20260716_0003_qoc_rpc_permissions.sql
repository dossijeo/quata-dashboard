-- Defense in depth: QOC RPCs are callable only by authenticated Qüata sessions.
revoke all on function public.qoc_current_profile_id() from public;
revoke all on function public.qoc_is_authorized() from public;
revoke all on function public.qoc_has_capability(text) from public;
revoke all on function public.qoc_write_audit(text,text,text,jsonb,jsonb,text) from public;
revoke all on function public.qoc_session() from public;
revoke all on function public.qoc_module_data(text,integer) from public;
revoke all on function public.qoc_command(text,jsonb) from public;

grant execute on function public.qoc_session() to authenticated;
grant execute on function public.qoc_module_data(text,integer) to authenticated;
grant execute on function public.qoc_command(text,jsonb) to authenticated;
