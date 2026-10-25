# YuMusic

A Tauri app for YouTube Music.

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

The scripts invoke the Tauri, Vite, TypeScript, and Biome entry points directly
with Bun, bypassing executable shims. Tauri's frontend hooks also force Bun.
`bunfig.toml` applies the same runtime preference to nested commands. CI uses the
Bun version recorded in `package.json`. The recommended Bun extension provides
the VS Code debugging configuration.

Restart an existing development session with `bun run tauri dev` after changing
these scripts; already-running processes keep their original runtime.

The desktop icon source is `public/app-icon.svg`, using the mobile app's white
logo and red background. On Wayland, the window identifies itself as
`dev.yumeo.yumusic`. Linux bundles include a matching hidden desktop entry
alongside Tauri's generated `YuMusic.desktop` so the compositor can resolve the
icon without adding another launcher. A development binary needs the packaged
desktop entries and icons installed for that lookup to work.
