-- Transactional checks; no test users or records survive rollback.
begin;
select set_config('test.user_a', gen_random_uuid()::text, true);
select set_config('test.user_b', gen_random_uuid()::text, true);
insert into auth.users(id) values (current_setting('test.user_a')::uuid),(current_setting('test.user_b')::uuid);
create function pg_temp.assert_true(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception '%',message; end if; end $$;
create function pg_temp.write(key text, value jsonb, rev bigint, edited bigint)
returns setof public.sync_records language sql security invoker as $$
  select * from public.write_sync_record(key,value,rev,edited,'00000000-0000-0000-0000-000000000001');
$$;
select pg_temp.assert_true(not has_table_privilege('anon','public.sync_records','select'),'anonymous table access');
select pg_temp.assert_true(not has_function_privilege('anon','public.write_sync_record(text,jsonb,bigint,bigint,uuid)','execute'),'anonymous RPC access');
set local role authenticated;
select set_config('request.jwt.claim.sub',current_setting('test.user_a'),true);
select pg_temp.assert_true((select revision=1 from pg_temp.write('settings/scrobbling','{"enabled":true,"token":"original"}',0,1000)),'initial write');
select pg_temp.assert_true((select revision=2 and modified_at=3000 from pg_temp.write('settings/scrobbling','{"enabled":true,"token":"new-pc-token"}',1,3000)),'newer edit');
select pg_temp.assert_true((select revision=2 and value->>'token'='new-pc-token' from pg_temp.write('settings/scrobbling','null',1,2000)),'late older mobile clear overwrote PC');
select pg_temp.assert_true((select revision=2 from pg_temp.write('settings/scrobbling','null',2,2500)),'stale edit with latest revision overwrote PC');
select pg_temp.assert_true((select revision=2 from pg_temp.write('settings/scrobbling','null',0,0)),'new-device defaults overwrote settings');
select pg_temp.assert_true((select revision=2 from pg_temp.write('settings/scrobbling','{"enabled":true,"token":"new-pc-token"}',1,3000)),'replayed edit changed revision');
select pg_temp.assert_true((select revision=3 and value='null'::jsonb from pg_temp.write('settings/scrobbling','null',1,4000)),'genuinely newer clear lost');
select pg_temp.assert_true((select revision=4 and modified_at=5000 from pg_temp.write('settings/scrobbling','{"enabled":true,"token":"new-mobile-token"}',1,5000)),'newer offline edit with old revision lost');
select pg_temp.assert_true((select revision=4 from pg_temp.write('settings/scrobbling','null',4,4500)),'later sync beat newer edit');
-- Deterministic ordering for simultaneous edits, and idempotent retries.
select pg_temp.assert_true((select revision=5 from public.write_sync_record('settings/scrobbling','true',4,5000,'00000000-0000-0000-0000-000000000002')),'tie ordering failed');
select pg_temp.assert_true((select revision=5 from pg_temp.write('settings/scrobbling','false',5,5000)),'tie ordering not stable');
do $$ begin
 begin
  perform public.write_sync_record('settings/scrobbling','null',5);
  raise exception 'outdated client accepted';
 exception when invalid_parameter_value then null;
 end;
 begin
  perform * from pg_temp.write('settings/scrobbling','null',5,floor(extract(epoch from clock_timestamp())*1000)::bigint+600000);
  raise exception 'future clock accepted';
 exception when invalid_parameter_value then null;
 end;
end $$;
select * from pg_temp.write('trusted/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','"Friend"',0,1000);
select * from pg_temp.write('trusted/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','null',1,2000);
select pg_temp.assert_true((select revision=2 and value='null'::jsonb from pg_temp.write('trusted/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','"Friend"',1,3000)),'stale trust restored revocation');
select set_config('request.jwt.claim.sub',current_setting('test.user_b'),true);
select pg_temp.assert_true((select count(*)=0 from public.sync_records),'cross-account read');
do $$ begin
 begin
  insert into public.sync_records(user_id,key,value) values(current_setting('test.user_a')::uuid,'settings/crossfade','true');
  raise exception 'cross-account insert accepted';
 exception when insufficient_privilege then null;
 end;
end $$;
select * from pg_temp.write('settings/cleanTitles','true',0,1000);
do $$ begin
 begin
  update public.sync_records set user_id=current_setting('test.user_a')::uuid;
  raise exception 'ownership reassignment accepted';
 exception when insufficient_privilege then null;
 end;
end $$;
reset role;
select pg_temp.assert_true((select revision=5 and value='true'::jsonb from public.sync_records where user_id=current_setting('test.user_a')::uuid and key='settings/scrobbling'),'other account modified owner data');
select 'PASS: latest edit wins regardless of sync order; replay, clock, legacy client, trust and account isolation checks passed' as result;
rollback;
