begin;
select set_config('request.jwt.claim.sub','3104e53d-ac12-430f-9397-73843075d892',true);
select jsonb_array_length(qoc_user_growth_series(13)) as points,
       qoc_user_growth_series(13)->0->>'date' as first_date,
       qoc_user_growth_series(13)->12->>'date' as last_date;
rollback;
