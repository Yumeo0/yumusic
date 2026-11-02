# Account sync

Account sync uses Supabase Auth, Postgres, and the `room-identity` Edge Function.
Users enable sync from Settings after signing into YouTube; no backend setup is
needed when using an existing app distribution.

## Backend setup for a custom build

1. Create a Supabase project, or provide a compatible self-hosted Supabase stack.
   Separate projects can isolate development from production; builds that should
   share accounts and settings must use the same backend.
2. In `src/lib/sync/client.ts`, set `SUPABASE_URL` to the backend's public URL
   and `PUBLISHABLE_KEY` to its publishable API key. These are currently source
   constants, not environment variables, so rebuild the app after changing them.
   Never put a secret or service-role key in the app.
3. Apply the migrations in `supabase/migrations/` in filename order and deploy
   `supabase/functions/room-identity/` to that backend. Configure Google Auth as
   described below. Auth providers and credentials are not configured by the
   checked-in `supabase/config.toml`.

For a hosted project, install the
[Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
and run the following from the repository root. Replace `PROJECT_REF` with the
target project's reference. These commands use Supabase CLI 3.x. Check
`supabase --version` and command help if using a different CLI version; the
`--remote` database flag below explicitly selects the linked hosted database.

```sh
supabase login
supabase link --project-ref PROJECT_REF
supabase db push --remote --dry-run
supabase db push --remote
supabase functions deploy room-identity
```

Review the dry run before applying it. Deployment uses the function's checked-in
`verify_jwt = false` setting: targeted fingerprint lookups are public, while the
function validates Auth bearer tokens and ownership proofs for writes. The
function needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in its server-side
runtime; hosted Supabase supplies these. Keep that privileged key on the server.

For self-hosting, deploy migrations, Auth, and the Edge Function runtime using
the [Supabase self-hosting guide](https://supabase.com/docs/guides/self-hosting).
Use the public gateway URL in the app and the Google callback configuration.
The same RLS policies and function authentication checks are required.

## Google setup

1. Create a Google OAuth **Web application** client. Its authorized redirect URI
   is `https://PROJECT_REF.supabase.co/auth/v1/callback` for a hosted project.
   Use the callback URL shown by the target backend's Google provider settings.
2. Enable Google under Supabase Authentication → Sign In / Providers. Enter the
   Google client ID and secret in the dashboard, keeping nonce checks enabled.
   No Google client secret belongs in this repository or the app.
3. Under Authentication → URL Configuration → Redirect URLs, add:
   - `http://127.0.0.1:43827/sync/callback/*`
   - `http://localhost:5173/`
   - `http://127.0.0.1:5173/`
   - `http://localhost:5174/` when using `bun run dev:guest` in a browser.
4. If Google's consent screen is in testing mode, add the intended test accounts
   to its audience. Publish the consent screen when making sign-in public.
5. Sign in to YouTube in YuMusic. Sync authorization then opens for that same
   Google account. Existing YouTube sessions can finish consent through
   Settings → Sync across devices → Enable sync.

For browser builds, add each served origin to Google's **Authorized JavaScript
origins** and the corresponding callback URL to Supabase's redirect allowlist.
Use the actual scheme, host, and port; examples are `http://localhost:5173`
and `http://127.0.0.1:5173`. Add a deployed web origin when hosting the frontend.
The Supabase callback belongs under **Authorized redirect URIs**, not under
JavaScript origins. See [Google provider setup](https://supabase.com/docs/guides/auth/social-login/auth-google).

Native apps open the system browser. A one-use listener bound only to
`127.0.0.1:43827` receives the authorization code at a random path. The app
exchanges that code using Supabase's PKCE verifier, then closes the listener.
The listener accepts the matching path and Host header, limits request size,
and expires after five minutes. Return to YuMusic after completing sign-in.
It does not receive or display Google passwords. A second simultaneous native
sign-in on the same device cannot bind this port; finish or cancel the first.

Browser development returns to the same browser origin. Use an allowlisted
loopback origin; an Android browser-development session served over a LAN URL
needs that exact URL allowlisted separately. Native Android does not use that
LAN callback: its system browser and app share the phone's loopback interface.

YouTube and sync use the same underlying Google account. After the YouTube
cookie login succeeds, YuMusic reads the owning Google email from YouTube's
authenticated default WEB account menu and supplies it as Google's OAuth
`login_hint`. This works for Brand Account channels, whose display name or handle
is not the Google account identity. The full channel-switcher page omits the
owning account header and is not used for this lookup.

Google may still require OAuth consent: a YouTube cookie is not a Supabase
credential. There is no independent sync account picker or sync sign-out button.
Signing out of YouTube also signs out of sync. Existing YouTube sessions without
sync consent show Enable sync for that same account. No SMTP setup is needed.

Sync waits until the YouTube identity is known. A different Google OAuth identity
cannot start sync or register a linked room device. Unknown or ambiguous YouTube
identity pauses sync. Data requests obtain a JWT for their intended Supabase user
and check the YouTube account again, preventing an in-flight account change from
routing pending edits through another session. RLS continues to enforce per-user
database access; YouTube cookies and account headers are never sent to Supabase.

## Synced data and local data

Sync includes the explicit preference allowlist in `local-data.ts`, pinned
playlists, trusted-device fingerprints and names, room admission policy, guest
permissions, Discord rich presence, ListenBrainz scrobbling (including its user token), and the saved
Listen together profile. A profile is reused only
when its existing account-source check matches. Private room identity keys are
non-exportable and remain local. Trusting a signed-in listener covers all devices
linked to their sync account. Your own linked devices are recognized automatically.

Downloads, volume, developer mode, search history, caches,
Google cookies and Supabase session credentials are not
uploaded as sync records. Supabase session credentials are stored locally on the device.
Settings sync is optional: no preferences are uploaded before sync authorization
for the current YouTube Google account.

Rich presence uses `settings/discordRpc`. Default-off devices publish no initial
value; disabling it after syncing creates a timestamped tombstone. A new
device's default cannot overwrite another device's enabled setting.

Each account has a local journal with pending writes. Sign-out restores the
device's pre-sync preference snapshot. Returning to an account restores its
saved journal, including unsent changes; another account cannot inherit it.

Sync runs after edits (debounced), on app startup, when going online or returning
to the app, every 30 seconds while visible, and through **Sync now**. Network
failures keep pending edits on disk for retry. A failed local journal write
pauses sync and shows an error.

## Conflicts and access control

`sync_records` uses `(user_id, key)` as its primary key. RLS restricts SELECT,
INSERT and UPDATE to rows owned by `auth.uid()`. Anonymous roles have no access.
The write RPC is SECURITY INVOKER, so RLS still applies; it derives ownership
from Auth rather than accepting a caller-supplied user ID.

Each real edit receives a persisted `modified_at` time and unique `edit_id`.
Clicking Sync now, retrying a request, or pulling remote data never refreshes that
edit time. The client and database compare these versions, so an older offline
edit uploaded later cannot replace a newer PC or mobile edit. Identical edit
times use the edit ID as a deterministic tie-breaker. Each device's logical
clock advances beyond observed cloud times and its previous edits, including
when its system clock moves backwards. A device clock more than five minutes
ahead of the server pauses sync with a clock-correction message.

Distinct preference keys and list entries merge independently. Scrobbling's
toggle and token remain one value. New-device defaults have an edit time of zero
and never override an existing cloud value. Pending edits from older builds
without edit timestamps also defer to timestamped cloud data. Clients without
the versioned write protocol receive an update-required error rather than being
allowed to clear newer data. Both devices must run the updated app.

Trusted-person changes additionally require the original revision to match;
a stale offline trust entry cannot restore an approval revoked elsewhere.

JSON `null` is a permanent deletion record. This prevents an old offline device
from silently restoring a removed pin or trusted device. Don't purge tombstones
without a device acknowledgement or full-resync protocol. New accounts import
local values only for keys that do not already exist in the cloud.

## Database changes and verification

Migration files are under `supabase/migrations/`. Apply them to each backend used
by a build and keep its migration history in step with these files. Deploy
through the CLI or a configured CI integration. Mirroring a Git repository alone
does not deploy database migrations or Edge Functions. Configure Auth providers
and credentials separately on each backend.

`supabase/tests/sync_security.sql` can be run in the Supabase SQL editor. It
creates two temporary test accounts inside a transaction, verifies anonymous
denial, cross-account isolation, ownership checks, revision conflicts, and
trusted-device tombstones, then rolls everything back. It leaves no test users
or data behind. Run Supabase's security and performance advisors after schema
changes. Generated client database types are in `src/lib/sync/database.types.ts`.

Run `bun test src/lib/sync` for offline merge, retry, late-reply cancellation,
credential exclusion, and validation tests. Native callback parsing is covered
by `cargo test --manifest-path src-tauri/Cargo.toml --lib sync_oauth`.

For a full manual check, sign in with the same sync account on two devices,
change different preferences offline, reconnect, then remove a trusted device
while the other is offline. Reconnect it and verify the trust entry stays
removed. Sign out of YouTube and into another Google account to verify list isolation. Exercise
Google success, cancellation and denial on Windows, Linux, and Android.

## Account trust

When a signed-in device connects to a room, it registers an account-scoped
public-key fingerprint through the `room-identity` Edge Function. The function
authenticates the Supabase bearer token with Auth and verifies a device signature
binding that account ID, public key, and a recent timestamp. Only this function
can write `room_devices`; clients cannot register arbitrary device mappings through
the Data API. The function never reassigns an existing key to another account.

After each room admission or peer-trust signature is verified, the receiving app
looks up that fingerprint over HTTPS. The public lookup returns only an opaque
account ID for a specific known fingerprint, not emails, tokens, a list of devices,
or an account directory. Account IDs in a peer roster are not used as proof.
No Supabase bearer token is sent to room participants.

Trust entries for accounts use `account:<uuid>` and sync through the existing
revisioned records. Trust one signed-in person once to admit their other linked
devices under trusted admission policies. Forgetting the account revokes future
automatic admission for that account's devices. Manual approval remains manual.
Devices belonging to the host's own verified sync account are recognized under
trusted policies without adding a separate trusted-person entry.

Signed-out participants retain device-only trust. Existing device approvals stay
valid for those device keys; trust a signed-in participant once to establish account
trust. Linked identities use a separate local key per account, so switching sync
accounts cannot carry one account's device identity into another. Changing sync
accounts disconnects the current room. Signing out unlinks this device on the server
and requires a connection; the other devices linked to the account are unaffected.

If account lookup fails, it cannot grant account-based admission; an existing
explicit device approval or manual approval can still apply. Account ownership
lookups are performed afresh for each join or trust proof. Real-device Google
sign-in and multi-device WebRTC testing remain part of release validation.

## Scrobbling sync

ListenBrainz's enabled state and user token travel together in the private
`settings/scrobbling` record. The token is accessible only through the account's
RLS-protected sync records; it is never part of a room message or public device
lookup. A fresh device with no scrobbling configured publishes no empty default
record, so it cannot displace an existing device's configuration during first sync.
Disabling scrobbling retains the token; disabling it and clearing the token removes
the configuration with the same durable tombstone mechanism as other sync items.

Enable sync on each device and use **Sync now** to request an immediate update.
Conflict resolution uses actual edit times, so sync order does not determine
which value wins.

New sync fields are ignored by adapters that do not support them, including
removing old queued echoes for unsupported keys from the local journal. They
are not converted into cloud deletions. Edit origin markers distinguish real user
input from initial device defaults, and persisted edit times determine the winner.
Trust revocations additionally use the original-revision conflict rule.
