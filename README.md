# YuMusic

A Tauri app for YouTube Music.

YuMusic is an independent project and is not affiliated with, endorsed by, or
sponsored by Google or YouTube.

## Development

Install Bun 1.4.4 or newer, Rust, and the native build prerequisites for your
platform. Bun handles dependencies, JavaScript tooling, tests, and release scripts.

On Arch Linux / CachyOS, install the WebKitGTK media runtime as well:

```sh
sudo pacman -S --needed webkit2gtk-4.1 gst-plugins-base gst-plugins-good gst-libav
```

`gst-plugins-good` provides `autoaudiosink`, which WebKitGTK needs for audio
playback. If it is missing, playing a song can fail in the WebKit process.
After installing plugins, restart `bun run tauri dev`. Check that the audio
plugin is available with `gst-inspect-1.0 autoaudiosink`.

```sh
bun install --frozen-lockfile
bun run tauri dev
```

For the frontend alone, run `bun run dev`.

For Android, install the Android SDK and NDK and set `JAVA_HOME` to a JDK
supported by the Gradle wrapper (Java 17–25; tested with Java 25). The project
uses Gradle 9.1.0, Android Gradle Plugin 8.13.2, and Kotlin 2.3.21.
Run `bun run tauri android dev` to develop on a connected device.
Android uses native Media3 audio playback with a foreground media service and
equalizer session support. See [Android audio](docs/android-audio.md) for details.

```sh
bun run build                         # Type-check and build the frontend
bun run test                          # Run the test suite
bun run lint                          # Check formatting and lint rules
bun run tauri build                   # Build desktop bundles
bun run build:android                 # Build Android APKs
bun run release patch --no-push        # Create a local release commit and tag
```

## Release notes

Keep user-facing patch notes in [CHANGELOG.md](CHANGELOG.md) under **Unreleased**,
grouped into Features, Improvements, and Bug fixes. Describe what users gain or
what now works correctly; leave dependency bumps, CI changes, and other internal
maintenance out unless they affect users.

Preview the next release with `bun run release:notes`, or a documented version
with `bun run release:notes 0.5.1`. `bun run release patch|minor|major` moves the
Unreleased notes into the new version, adds the release date, and includes them
in the release commit. Empty notes stop the release before version files change.

Forgejo releases and the in-app updater use these same notes from the tagged
version. Manually created tags need a matching changelog entry; the publishing
workflow also accepts an explicit `RELEASE_NOTES` override.

Releases also attach an x86_64 `.flatpak` bundle. See
[Flatpak packaging](flatpak/README.md#release-downloads) for installation and the
Forgejo runner requirements.
