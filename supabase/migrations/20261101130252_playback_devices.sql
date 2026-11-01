-- Ephemeral discovery only. Playback queues and commands travel over WebRTC.
create table public.playback_devices (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  peer_id text not null check (length(peer_id) between 1 and 200),
  connection_token uuid not null,
  name text not null check (length(name) between 1 and 80),
  kind text not null check (kind in ('desktop','phone','browser')),
  state jsonb not null check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 4096),
  last_seen timestamptz not null default now(),
  primary key (user_id,id)
);
alter table public.playback_devices enable row level security;
revoke all on public.playback_devices from anon, authenticated;
grant select,insert,update,delete on public.playback_devices to authenticated;
create policy playback_devices_owner on public.playback_devices for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create function public.publish_playback_device(
  device_id uuid, device_peer text, device_token uuid, device_name text,
  device_kind text, device_state jsonb
) returns setof public.playback_devices
language plpgsql security invoker set search_path = '' as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  delete from public.playback_devices where user_id=(select auth.uid()) and last_seen < now()-interval '1 day';
  insert into public.playback_devices(user_id,id,peer_id,connection_token,name,kind,state,last_seen)
    values ((select auth.uid()),device_id,device_peer,device_token,device_name,device_kind,device_state,now())
    on conflict(user_id,id) do update set peer_id=excluded.peer_id,connection_token=excluded.connection_token,
      name=excluded.name,kind=excluded.kind,state=excluded.state,last_seen=now();
  return query select * from public.playback_devices where user_id=(select auth.uid()) and last_seen > now()-interval '45 seconds'
    order by id limit 50;
end;
$$;
revoke all on function public.publish_playback_device(uuid,text,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.publish_playback_device(uuid,text,uuid,text,text,jsonb) to authenticated;
