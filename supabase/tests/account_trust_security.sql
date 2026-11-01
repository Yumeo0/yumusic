begin;
select set_config('test.user_a', gen_random_uuid()::text, true);
select set_config('test.user_b', gen_random_uuid()::text, true);
insert into auth.users(id) values (current_setting('test.user_a')::uuid), (current_setting('test.user_b')::uuid);
insert into public.room_devices(fingerprint,user_id) values (repeat('d',64),current_setting('test.user_a')::uuid);
do $$ begin
 if has_table_privilege('anon','public.room_devices','select') or has_table_privilege('authenticated','public.room_devices','insert') or has_table_privilege('authenticated','public.room_devices','update') or has_table_privilege('authenticated','public.room_devices','delete') then
  raise exception 'Device registry is writable or publicly readable';
 end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.user_a'), true);
do $$ begin
 if (select count(*) from public.room_devices where fingerprint=repeat('d',64)) <> 1 then raise exception 'Owner cannot read device'; end if;
end $$;
select set_config('request.jwt.claim.sub', current_setting('test.user_b'), true);
do $$ begin
 if exists (select 1 from public.room_devices where fingerprint=repeat('d',64)) then raise exception 'Other account can read registry'; end if;
 begin
  insert into public.room_devices(fingerprint,user_id) values (repeat('e',64),current_setting('test.user_b')::uuid);
  raise exception 'Client registered device without possession proof';
 exception when insufficient_privilege then null;
 end;
end $$;
reset role;
select 'PASS: registry ownership, no anonymous access, no direct client registration or reassignment' as result;
rollback;
