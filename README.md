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

```sh
bun run build                         # Type-check and build the frontend
bun run test                          # Run the test suite
bun run lint                          # Check formatting and lint rules
bun run tauri build                   # Build desktop bundles
bun run build:android                 # Build Android APKs
bun run release patch --no-push        # Create a local release commit and tag
```
