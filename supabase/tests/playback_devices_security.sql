begin;
select set_config('test.user_a', gen_random_uuid()::text, true);
select set_config('test.user_b', gen_random_uuid()::text, true);
select set_config('test.device', gen_random_uuid()::text, true);
insert into auth.users(id) values (current_setting('test.user_a')::uuid), (current_setting('test.user_b')::uuid);
do $$ begin
 if has_table_privilege('anon','public.playback_devices','select') or has_table_privilege('anon','public.playback_devices','insert') or has_function_privilege('anon','public.publish_playback_device(uuid,text,uuid,text,text,jsonb)','execute') then
  raise exception 'Anonymous access to private playback discovery';
 end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.user_a'), true);
do $$ declare old_token uuid := gen_random_uuid(); begin
 perform public.publish_playback_device(current_setting('test.device')::uuid,'test-peer',old_token,'Test PC','desktop','{"playing":true}');
 perform public.publish_playback_device(current_setting('test.device')::uuid,'restarted-peer',gen_random_uuid(),'Test PC','desktop','{"playing":true}');
 if (select count(*) from public.playback_devices) <> 1 then raise exception 'Device restart duplicated discovery entry'; end if;
 delete from public.playback_devices where id=current_setting('test.device')::uuid and connection_token=old_token;
 if found then raise exception 'Old session cleanup removed restarted device'; end if;
 if (select count(*) from public.playback_devices) <> 1 then raise exception 'Owner discovery failed'; end if;
end $$;
select set_config('request.jwt.claim.sub', current_setting('test.user_b'), true);
do $$ begin
 if exists(select 1 from public.playback_devices) then raise exception 'Cross-account discovery leaked a capability'; end if;
 update public.playback_devices set connection_token=gen_random_uuid();
 if found then raise exception 'Other user changed device'; end if;
 delete from public.playback_devices;
 if found then raise exception 'Other user removed device'; end if;
 begin
  insert into public.playback_devices(user_id,id,peer_id,connection_token,name,kind,state)
  values(current_setting('test.user_a')::uuid,gen_random_uuid(),'forged',gen_random_uuid(),'Forged','desktop','{}');
  raise exception 'User published to another account';
 exception when insufficient_privilege then null;
 end;
 perform public.publish_playback_device(gen_random_uuid(),'other-peer',gen_random_uuid(),'Other PC','desktop','{}');
 if (select count(*) from public.playback_devices) <> 1 then raise exception 'RPC exposed another account'; end if;
end $$;
reset role;
update public.playback_devices set last_seen=now()-interval '1 minute' where id=current_setting('test.device')::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.user_a'), true);
do $$ declare seen integer; begin
 select count(*) into seen from public.publish_playback_device(gen_random_uuid(),'new-peer',gen_random_uuid(),'New PC','desktop','{}');
 if seen <> 1 then raise exception 'Expired devices were included'; end if;
 if (select count(*) from public.playback_devices) <> 2 then raise exception 'Owner cannot read own records'; end if;
end $$;
reset role;
select 'PASS: device discovery and capabilities are account-private; expired devices hidden, anonymous access denied' as result;
rollback;
