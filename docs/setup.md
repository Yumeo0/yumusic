# Building and configuring YuMusic

This guide covers building the app, configuring independent services, and
publishing a fork. Examples use placeholder hosts and project references;
replace them with the destinations used by the build.

## Source checkout and prerequisites

Clone the repository with its submodules:

```sh
git clone --recurse-submodules https://git.example.com/owner/YuMusic.git
cd YuMusic
bun install --frozen-lockfile
```

For an existing checkout, run `git submodule update --init --recursive` before
installing dependencies. Use the Bun version in `package.json` for reproducible
builds, and a Rust toolchain meeting `rust-version` in `src-tauri/Cargo.toml`.

Install the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/):

- Windows requires the MSVC C++ build tools and WebView2 runtime.
- Linux requires WebKitGTK 4.1 and the distribution's native development
  packages. Install the GStreamer audio plugins described in the root README.
- macOS requires Xcode command-line tools. The checked-in release workflow does
  not build macOS packages; distributing them requires a separate build and
  signing setup.
- Android requires a compatible JDK, Android SDK and NDK, CMake 3.22.1, and the
  Rust targets for the desired device architectures. Java 21 matches CI. Set
  `JAVA_HOME`, `ANDROID_HOME`, and `NDK_HOME` to the installed toolchains and
  follow [Discord SDK setup](android-discord.md).

## Run and build

```sh
bun run dev                  # Frontend development server
bun run tauri dev            # Native desktop development app
bun run tauri android dev    # Native Android development app
bun run build                # Type-check and bundle the frontend
bun run tauri build          # Desktop packages
bun run build:android        # Android APKs
```

The frontend server uses port 5173 by default. A frontend preview does not
provide every native integration. Android devices must reach the development
server over the network; use the address reported by Tauri and allow it through
the host firewall. Native changes require rebuilding the app.

`bun run test` runs the tests and `bun run lint` checks formatting and lint
rules. See [Android audio](android-audio.md) and
[Android links](android-links.md) for native regression checks.

## Service configuration

| Feature                                | Configuration for an independent deployment                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account sync and device discovery      | Set the backend URL and publishable key in `src/lib/sync/client.ts`, apply database migrations, deploy `room-identity`, and configure Google Auth. Follow [account sync](account-sync.md).  |
| Listen together and device connections | Optionally set `VITE_LISTEN_PEER_SERVER` and `VITE_LISTEN_ICE_URL` before building. See [connection settings](listen-together.md#connection-settings) for PeerServer and TURN requirements. |
| Discord Rich Presence                  | For an independent Discord application, change `DEFAULT_APP_ID` in `src-tauri/src/discord.rs` before rebuilding. Android builds also require the [Discord Social SDK](android-discord.md).  |

The `VITE_LISTEN_*` values are Vite build-time configuration. Put them in a local
`.env.local` file or the build environment, then restart development or rebuild
the app. The Supabase URL and publishable key are currently source constants;
setting similarly named environment variables does not override them.

## Release hosting

The checked-in pipeline targets Forgejo. Before enabling it on another
repository or host:

1. Set `FORGEJO` and `REPOSITORY` in `.forgejo/workflows/release.yml` to the
   target Forgejo base URL and `owner/repository`. The publishing script uses
   the Forgejo API; a GitHub mirror needs an adapted publishing workflow.
2. Provide runners matching the workflow's Linux and Windows labels. Install
   Rust, MSVC C++ build tools, and Git Bash on the Windows runner. For Flatpak,
   enable the nested sandbox support described in [Flatpak packaging](../flatpak/README.md).
3. Generate an independent desktop updater signing key with
   `bun run tauri signer generate`, store its private key in the repository's
   `TAURI_SIGNING_PRIVATE_KEY` secret, and set its public key in
   `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. The workflow expects
   a passwordless key; adapt its signing environment if using a password.
4. Update `plugins.updater.endpoints` in that configuration to the target
   repository's rolling `latest` release asset, for example
   `https://git.example.com/owner/YuMusic/releases/download/latest/latest.json`.
5. Set the Android SDK download and permanent Android signing secrets described
   in [Android release setup](android-release.md). Android signing is separate
   from desktop updater signing.
6. Update the application source URL in `dev.yumeo.yumusic.json` to a repository
   containing the release tags. Regenerate Flatpak sources as described in its
   packaging guide. Review Cargo repository metadata and AppStream links when
   publishing a fork.

Keep the `dev.yumeo.yumusic` identifier when building the existing application.
A separately branded fork should use its own identifier and update Android
namespaces, desktop integration, icons, AppStream, and packaging consistently.
The identifiers shown in native test commands refer to the checked-in sources.

Maintain release notes in `CHANGELOG.md`. Use
`bun run release patch --no-push` to prepare a local release commit and tag, or
`bun run release patch` to also push them. The release script requires a clean
working tree and nonempty release notes. Configure the CI repository and its
credentials before pushing a release tag.
