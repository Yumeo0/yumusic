create table public.room_devices (
  fingerprint text primary key check (fingerprint ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index room_devices_user_id_idx on public.room_devices(user_id);
alter table public.room_devices enable row level security;
revoke all on public.room_devices from public, anon, authenticated;
grant select on public.room_devices to authenticated;
grant all on public.room_devices to service_role;
create policy room_devices_self on public.room_devices for select to authenticated
  using ((select auth.uid()) = user_id);
comment on table public.room_devices is 'Account device bindings; only the ownership-verifying Edge Function can register keys.';
