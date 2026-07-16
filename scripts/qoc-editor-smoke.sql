begin;
select set_config('request.jwt.claim.sub','3104e53d-ac12-430f-9397-73843075d892',true);
select qoc_command('official.post.create','{"title":"Prueba transaccional QOC","summary":"No persiste","postType":"announcement","contentHtml":"<p>Validación</p>","publishNow":false,"language":"es"}'::jsonb)->>'title' as created_title;
rollback;
