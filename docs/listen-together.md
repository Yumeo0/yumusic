# Listen Together

Open **Listen together** using the bottom-right pill, or the headphones button in the player or queue. These open the same fullscreen view on mobile or a modal on desktop, from anywhere in the app. Closing it keeps the room connected; **Leave** or **End room** disconnects explicitly.

1. Create a room, paste a friend's room code, or choose **Scan QR code** to scan their invitation with your camera or from an image.
2. Before connecting for the first time, confirm your username and picture. Google account details are prefilled when available; signed-out listeners choose their own name. Upload a picture or use initials.
3. The host shares the invitation code or chooses **Show QR code** for another device to scan. Anyone with the invitation joins automatically by default.
4. Everyone plays the same recording on their own device. Shared controls are the default, so guests can choose songs, add to the queue, skip, and control playback. Volume stays local.

**Settings** starts collapsed below the main controls. Expand it to adjust admission, manage trusted devices, or customize guest permissions. Existing saved preferences are preserved.

The confirmed profile is stored locally. A different Google account requires another confirmation. Profiles can be edited in the room while connected. Pictures are cropped and re-encoded to 128×128 JPEGs before sharing; no Google cookies, email addresses, playback URLs or tokens are sent to participants.

Rooms support eight participants including the host. Guests mirror up to 300 queue entries around the current track; the host keeps their full local queue. Crossfade is temporarily disabled in a room, without changing saved settings. Guests follow shared track transitions and autoplay choices, including the exact resolved YouTube video ID. If a guest cannot play a track, they wait for the next one. Leaving as a guest pauses playback and keeps the current track, position and queue for local playback. The host ending the room disconnects everyone; automatic host migration is not implemented.

QR codes are generated and read locally. After camera permission is granted, the scanner waits for the app to resume before starting, and stops when closed or after a successful scan. It only accepts YuMusic room invitations and uses the same profile confirmation and join policy as pasted codes. If camera access is denied or unavailable (including development over plain HTTP), choose a QR image instead.

## Guest controls

Under **Settings**, the **Guest controls** panel offers **Allow**, **Request approval**, and **Deny** independently for choosing songs, adding/playing next, skipping/previous, removal, reordering/shuffle, play/pause, seeking, and repeat mode. **Host only**, **Ask first**, and **Shared controls** apply one mode to all categories. New rooms default to **Shared controls**. Settings persist locally, can be changed while hosting, and are shown to guests. Song additions work even when the queue is empty, including when approval is required.

Allowed actions are executed by the host's player and then synchronized to everyone. Requested actions appear under **Guest requests**, with cover art for songs and a description of the requested action. Approve or decline them there. Denied actions never change the host player, including attempts to send commands outside the UI. Switching a category to Deny cancels its pending requests.

Requests that refer to an old track or queue are rejected rather than changing a different item. Duplicate command IDs are ignored. Guest seek gestures send one command when released to avoid flooding the host with requests. Guest selections and additions send at most 300 tracks per action, matching the shared queue window. Both clients must use the updated guest-control protocol.

## Join approval and trusted people

Choose **Who can join your rooms?** before hosting, or change it while hosting:

- **Auto-approve trusted people**: trusted devices join immediately; unfamiliar devices can ask the host for approval.
- **Manual approval**: approve each new device. A device admitted to the current room can reconnect after proving its identity again.
- **Auto-approve everyone** (default): admit anyone with the invitation after verifying their device signature. This does not automatically trust them for future rooms.
- **Trusted people only**: automatically admit devices you previously trusted and decline unknown devices. To meet someone new, use manual approval first.

Every policy requires the room's private invitation code. Existing **Trusted people only** settings keep their strict behavior when upgraded.

Choose **Approve and trust** on a join request, or **Trust device** beside an admitted participant, to remember their verified device. The trusted-device list persists between rooms and app restarts. **Forget** revokes future automatic admission without kicking someone who is already in the room. Policy changes also apply to requests currently awaiting approval.

Guests can also use **Trust device** for the host or another guest, and manage their own list under **People you trust**. Before saving a guest's selection, a fresh signed identity check is relayed through the host and verified against the selected device's fingerprint. These proofs use a separate signing purpose from room admission. Trust is personal: it does not add anyone to the current host's trusted list or grant admission privileges, but it applies when the guest hosts a room in the future.

Recognition uses a local ECDSA P-256 device key, not the participant's editable username, picture, Google account, or temporary PeerJS ID. The private key is generated as non-exportable and stored in IndexedDB; only the public key, fingerprint, and signatures are shared. A fresh challenge binds each proof to the room, invitation, connection identities, and confirmed profile, so copying a public key or replaying a proof from an older connection does not grant admission. The implementation uses the browser's [Web Crypto API](https://www.w3.org/TR/webcrypto/).

Trust establishes recognition of the device you approved; it does not independently verify a person's real-world or Google identity. A name/picture change retains the device identity. A new device or cleared identity database requires fresh approval. Both apps must run the updated signed-join protocol; older clients cannot join these rooms.

## Connection settings

The PeerJS client is loaded only after profile confirmation. With no configuration, it uses PeerJS Cloud's default signaling and ICE settings. For a self-hosted setup, configure Vite environment variables before building:

```dotenv
VITE_LISTEN_PEER_SERVER=https://peer.example.com/peerjs
VITE_LISTEN_ICE_URL=https://api.example.com/listen/ice
```

The optional ICE endpoint returns an array of `RTCIceServer` objects, for example:

```json
[
  { "urls": "stun:stun.example.com:3478" },
  {
    "urls": ["turn:turn.example.com:3478", "turns:turn.example.com:5349"],
    "username": "temporary-username",
    "credential": "temporary-credential"
  }
]
```

The endpoint needs CORS support for the app's webview origin and should issue short-lived TURN credentials. PeerServer handles signaling; it does not replace a TURN relay. See the [PeerServer deployment documentation](https://peerjs.com/server/getting-started).

## Validation

For local testing, keep the first instance running with `bun run tauri dev` and start a second terminal in the project folder with `bun run dev:guest`. The guest instance uses port 5174, a separate app identifier (isolating account and webview data), and a temporary Rust target directory to avoid executable locks. Its first Rust build takes longer; later runs reuse that build directory. The guest window is titled **YuMusic · Guest**.

`bun test src/lib/listen-together` covers profile persistence and account changes, message validation, timeline projection, host approval, shared state, stale revisions, profile edits, suggestions, decline/end-room cleanup and invalid connection inputs. Room lifecycle tests use an in-memory transport, not live WebRTC.

Run `bun run build` for TypeScript and production bundling. Before releasing, test two packaged instances on separate networks, including a forced TURN relay, joining during playback, repeated tracks, buffering, seeks, reconnects, unavailable tracks, and Android background/foreground transitions. Real-device timing and platform WebRTC compatibility remain to be verified; playback currently catches up to the host after loading rather than using a room-wide ready/start barrier. Regenerate Flatpak dependency sources through the existing release workflow when packaging the new dependency.
