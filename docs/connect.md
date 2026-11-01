# Connect to a device

Enable sync on each device with the same YouTube Google account. Open the device
icon in the desktop player or fullscreen player, or Settings → Your devices.
Devices show their local name, current song and playback state. Names stay local.
The picker can pause, resume, skip and return to the previous song on any listed
device. Choose Transfer or Play here to move the current session, including from
one remote device to another. Open apps are available; sleeping or closed apps
cannot be woken remotely.

## Handoff

The destination prepares its own YouTube stream while the source keeps playing.
It restores the current position, repeat mode, autoplay preference and suggestions,
and up to 300 queue entries around the current track. Each device keeps its own
volume. After the destination successfully starts (or restores paused playback),
the source pauses and confirms the handoff. If the connection closes before
confirmation, the destination pauses. Loading failures leave the source playing.
Changing tracks on the source during handoff cancels the transfer.

Devices in Listen together rooms are listed but cannot receive transfers or
account playback commands. Leave the room before transferring; use room controls
to control its playback. This preserves host authority and guest permissions.

## Discovery and security

`playback_devices` is an ephemeral directory with account ownership enforced by
RLS for every operation. Anonymous callers have no access. Its composite primary
key starts with `user_id`. `publish_playback_device` uses `SECURITY INVOKER`, derives
the owner from `auth.uid()`, stamps heartbeats with server time and only returns
that account's devices seen in the last 45 seconds. Clients refresh every ten
seconds and after playback changes. Stale rows for the account are pruned after
one day when that account next publishes. Closing the app expires the entry;
normal cleanup also attempts to delete it.

Each installation keeps a stable device ID per account, so reloading or restarting
updates the same entry. Each session creates a new random connection capability;
cleanup matches that capability so an old session cannot remove its replacement.
Discovery starts automatically when Google identity and sync authorization are
ready, without opening a modal. Token refreshes reuse the running peer. Returning
to the app or reconnecting refreshes discovery immediately, and the player button
shows the count of other available devices.

Capabilities
are readable only by the owning account and are supplied inside the encrypted
WebRTC data channel, never as PeerJS signaling metadata. An incoming request is
authenticated before parsing or executing commands. Queues and commands use
PeerJS; Supabase stores only discovery metadata and current song labels, not
stream URLs, audio, queues, Google cookies or Supabase session tokens. Payloads
are bounded and songs are sanitized with the room protocol's existing validator.
Signing out or switching accounts cancels in-flight work and destroys peers.

Rooms and device connections share `VITE_LISTEN_PEER_SERVER` and the optional
`VITE_LISTEN_ICE_URL` TURN credential endpoint. Networks blocking direct WebRTC
require the existing TURN setup. Browser autoplay restrictions can require
starting playback locally once on the destination. A rejected play request
reports an error and leaves the source playing.

Run `bun test src/lib/connect src/lib/listen-together/room.test.ts` for handoff,
remote control, account shutdown, forged capabilities and permission checks.
`supabase/tests/playback_devices_security.sql` exercises the real RLS and discovery
RPC using temporary accounts in a rolled-back transaction. Release validation
should include transfer between a desktop and Android on separate networks,
paused transfers, screen locking, blocked autoplay, and switching accounts while
a track is loading.
