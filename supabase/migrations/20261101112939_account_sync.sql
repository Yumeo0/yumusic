-- Sync records are scoped to a Supabase Auth account, never a display name.
create table public.sync_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (length(key) between 1 and 256 and key ~ '^(settings/|pinned/|trusted/|joinPolicy$|guestPermissions$|roomProfile$)'),
  value jsonb not null default 'null'::jsonb check (octet_length(value::text) <= 65536),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.sync_records enable row level security;
revoke all on public.sync_records from public, anon, authenticated;
grant select, insert, update on public.sync_records to authenticated;
create policy sync_select on public.sync_records for select to authenticated
  using ((select auth.uid()) = user_id);
create policy sync_insert on public.sync_records for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy sync_update on public.sync_records for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Null JSON is a durable deletion. Never physically delete a list entry:
-- devices offline at removal must still learn that it was removed.
-- Compare-and-swap prevents stale offline writes replacing newer changes.
create function public.write_sync_record(record_key text, record_value jsonb, expected_revision bigint)
returns setof public.sync_records
language plpgsql security invoker set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if expected_revision < 0 then
    raise exception 'Invalid revision' using errcode = '22023';
  end if;
  if expected_revision = 0 then
    return query insert into public.sync_records (user_id, key, value)
      values ((select auth.uid()), record_key, coalesce(record_value, 'null'::jsonb))
      on conflict (user_id, key) do nothing returning *;
  else
    return query update public.sync_records
      set value = coalesce(record_value, 'null'::jsonb), revision = revision + 1, updated_at = now()
      where user_id = (select auth.uid()) and key = record_key and revision = expected_revision
      returning *;
  end if;
end;
$$;
revoke all on function public.write_sync_record(text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.write_sync_record(text, jsonb, bigint) to authenticated;
comment on table public.sync_records is 'Private per-account YuMusic preferences and list entries; JSON null marks a deletion.';
