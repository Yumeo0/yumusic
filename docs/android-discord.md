# Discord Rich Presence on Android

Enable **Settings → Discord → Rich presence**. YuMusic publishes the current
song, artist, artwork, album links, and playback timestamps to the signed-in
Discord Android app. No additional account linking or user token is needed.
The Discord app must be installed, signed in, and support Social SDK RPC.

The integration uses the official Discord Social SDK 1.10.19337 Android package
and the same application ID as desktop. Pausing removes the moving timestamps;
seeking updates them. Disabling presence or clearing playback clears the activity.
Updates retry periodically if Discord was unavailable when playback started.
When black borders are detected, public cover artwork is cropped through
wsrv.nl before its URL is sent to Discord; covers without borders use their
original URL.

## Building

Download the **standalone C++** Social SDK 1.10.19337 from your application's
[Discord Developer Portal](https://discord.com/developers/applications/select/social-sdk/downloads).
Save it as `.cache/DiscordSocialSdk-1.10.19337.zip`, or set
`DISCORD_SOCIAL_SDK_ZIP` to its path. Android Studio can also use the
Gradle property `discordSocialSdkZip`. Relative paths are resolved from the
repository root.

On the first build, Gradle imports the release AAR and its license notices into
`~/.gradle/yumusic/discord-social-sdk/1.10.19337/` (under `GRADLE_USER_HOME` when
customized). These binaries stay outside source control and the disposable
project cache. After importing, the original ZIP and project `.cache` folder
can be removed without breaking Android builds. The notices are bundled in the
APK under `assets/discord-sdk/License-Notices.txt`.
Android CMake 3.22.1 and an NDK are needed in addition to the usual prerequisites.
Build with `bun run build:android` or develop with `bun run tauri android dev`.
For clean CI runners, see [Android release setup](android-release.md).

The SDK is initialized only when presence is enabled and a song is loaded.
Only its RPC presence transport is used. Its voice permissions, authentication
activity, and voice foreground service are excluded from the merged manifest.
Media3 remains responsible for music playback and the media notification.

## Device verification

1. Install a rebuilt APK and sign into Discord on the same phone.
2. Enable Rich presence, play a song, and inspect the activity from another
   Discord account or device.
3. Pause, resume, seek, change tracks, and play with YuMusic in the background.
4. Disable Rich presence and verify the activity disappears.

The SDK reports connection/update failures through Android logcat with the
`YuMusicDiscord` tag. Discord's service controls presence cleanup if Android
force-stops a process before it can send a clear.

References: [Android support](https://docs.discord.com/developers/discord-social-sdk/core-concepts/mobile),
[unauthenticated Rich Presence](https://docs.discord.com/developers/discord-social-sdk/development-guides/setting-rich-presence#rich-presence-without-authentication).
