-- Order by edit time, never by the time a device happens to sync.
alter table public.sync_records
  add column modified_at bigint not null default 0 check (modified_at between 0 and 9007199254740991),
  add column edit_id uuid not null default '00000000-0000-0000-0000-000000000000';
update public.sync_records set modified_at = floor(extract(epoch from updated_at) * 1000)::bigint;

drop function public.write_sync_record(text,jsonb,bigint);
create function public.write_sync_record(
  record_key text, record_value jsonb, expected_revision bigint,
  record_modified_at bigint default null, record_edit_id uuid default null
)
returns setof public.sync_records
language plpgsql security invoker set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if record_modified_at is null or record_edit_id is null then
    raise exception 'Update YuMusic on this device to resume sync.' using errcode = '22023';
  end if;
  if record_modified_at < 0 or record_modified_at > 9007199254740991 or expected_revision < 0 then
    raise exception 'Invalid edit version' using errcode = '22023';
  end if;
  if record_modified_at > floor(extract(epoch from clock_timestamp()) * 1000)::bigint + 300000 then
    raise exception 'Device clock is ahead. Correct the clock to resume sync.' using errcode = '22023';
  end if;
  return query
    insert into public.sync_records (user_id,key,value,modified_at,edit_id)
    values ((select auth.uid()),record_key,coalesce(record_value,'null'::jsonb),record_modified_at,record_edit_id)
    on conflict (user_id,key) do update
      set value = excluded.value, modified_at = excluded.modified_at, edit_id = excluded.edit_id,
          revision = public.sync_records.revision + 1, updated_at = now()
      where excluded.modified_at > 0
        and (excluded.modified_at,excluded.edit_id) > (public.sync_records.modified_at,public.sync_records.edit_id)
        and (record_key not like 'trusted/%' or public.sync_records.revision = expected_revision)
    returning *;
  if not found then
    return query select * from public.sync_records
      where user_id=(select auth.uid()) and key=record_key;
  end if;
end;
$$;
revoke all on function public.write_sync_record(text,jsonb,bigint,bigint,uuid) from public,anon,authenticated;
grant execute on function public.write_sync_record(text,jsonb,bigint,bigint,uuid) to authenticated;
