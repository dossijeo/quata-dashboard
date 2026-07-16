begin;
select set_config('request.jwt.claim.sub','3104e53d-ac12-430f-9397-73843075d892',true);
select qoc_command('campaign.create','{"name":"Validación QOC","title":"Prueba","body":"No persiste","locale":"es"}'::jsonb)->>'status' as campaign_status;
select qoc_command('translation.create','{"sourceType":"manual","sourceId":"smoke","sourceLocale":"es","targetLocale":"en","sourceText":"Prueba"}'::jsonb)->>'status' as translation_status;
select qoc_command('ticket.create','{"subject":"Validación QOC","priority":"low"}'::jsonb)->>'status' as ticket_status;
select qoc_command('moderation.update',jsonb_build_object('id',(select id from ugc_reports order by id limit 1),'status','actioned','reason','Smoke test'))->>'status' as moderation_status;
select qoc_command('user.role.toggle',jsonb_build_object('profileId','e1831c76-c983-4592-b0d2-684e99c9ad3b','isOfficial',true,'reason','Smoke test'))->>'is_official' as role_toggle;
rollback;
