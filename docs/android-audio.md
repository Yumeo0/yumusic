# Android audio

Android plays streams and downloaded files through Media3/ExoPlayer in a
`MediaSessionService`. It exposes YuMusic metadata, artwork, play/pause, seeking,
previous and next to Android's media notification, lock screen, Bluetooth and
headset controls. Audio focus, headphone disconnection and the playback wake lock
are managed natively. System controls follow the same Listen together permissions
as the in-app controls.

The two native playback decks share an Android audio session. The service sends
the standard `OPEN_AUDIO_EFFECT_CONTROL_SESSION` and
`CLOSE_AUDIO_EFFECT_CONTROL_SESSION` broadcasts for external equalizers and
audio-effect apps. Compatibility depends on the device and effect app.

YouTube authentication, PO tokens and SABR fetching stay in the app. Compressed
audio is passed in batches of at most 64 KiB to a bounded 2 MiB native pipe per
deck. Native decoders handle extraction, decoding and output; Android does not
create hidden HTML media elements or an MSE audio buffer. The native player keeps
up to 45 seconds ahead, and applies backpressure to the producer. Unbuffered
seeks restart SABR at the requested time with a fresh initialization segment;
MP4 and WebM use a time-based extractor seek map. Downloaded audio plays directly
from its local file. Missing MP4/WebM seek indexes are rebuilt from fragment
headers on the native loader thread and cached for the track's lifetime.

The service explicitly registers its media session at creation, before any
external controller binds. This lets Media3 publish the notification and promote
playback to a foreground service when JNI starts a track. Without registration,
Android treats it as an idle background service and can stop it after screen lock.
The playback bridge keeps the producer WebView resumed while music is active,
including a short grace period for loading the next track, then lets it pause
when playback stops. Backgrounding the app or locking the screen keeps foreground
playback running.
The producer also holds a partial CPU wake lock during playback and the 35-second
handoff grace period: ExoPlayer's own wake lock ends at `STATE_ENDED`, before the
next track's attestation and stream setup can finish. Ended decks do not extend
this grace period. The producer lock is released after the grace period or when
the activity detaches.
Keeping a WebView resumed does not override Chromium's hidden-window suspension.
The producer uses `BackgroundAudioWebView` to report a visible window to its
renderer while playback or the handoff grace period is active. The separate
YouTube token WebView does the same only while minting a token, including when
reused for another track. The Android window stays hidden and the screen stays
off; normal renderer visibility returns when audio work ends. The Gradle
template patch reapplies this base class to the generated `RustWebView` before
Kotlin compilation.
Volume changes do not emit synthetic playback-clock updates, and crossfade ticks
share one pending animation frame to avoid IPC/animation feedback loops.
Removing the app from recent tasks stops playback because its queue and SABR
producer belong to the activity. Playback resumption after process death and
Android Auto browsing are not implemented.

Rebuild and reinstall the Android app after changing Kotlin, the manifest or
Rust commands; Vite hot reload alone cannot update the native service.

Validation on Linux or macOS:

```sh
bun test src/lib/player/native-audio.test.ts
cd src-tauri/gen/android
./gradlew :app:testArm64DebugUnitTest -x :app:rustBuildArm64Debug
```

On Windows:

```powershell
bun test src/lib/player/native-audio.test.ts
cd src-tauri/gen/android
./gradlew.bat :app:testArm64DebugUnitTest -x :app:rustBuildArm64Debug
```

The native tests use generated silent AAC/MP4 and Opus/WebM fixtures and check
unbuffered forward/backward seeks, bounded buffering and session lifecycle.
Re-generate the fixtures with FFmpeg:

```sh
ffmpeg -f lavfi -i anullsrc=r=48000:cl=stereo -t 20 -c:a aac -b:a 32k -movflags empty_moov+frag_keyframe+default_base_moof -frag_duration 2000000 -f mp4 fragmented.m4a
ffmpeg -f lavfi -i anullsrc=r=48000:cl=stereo -t 20 -c:a libopus -b:a 32k -cluster_time_limit 2000 -live 1 -f webm fragmented.webm
```
