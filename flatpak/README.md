# Flatpak packaging

## Release downloads

Tagged releases build an x86_64 Flatpak in `.forgejo/workflows/release.yml` and
attach `YuMusic_VERSION_x86_64.flatpak` to the Forgejo release. Install a downloaded
bundle with `flatpak install --user ./YuMusic_VERSION_x86_64.flatpak`. The bundle
includes the Flathub runtime repository URL so Flatpak can install its runtime.
Flatpak manages updates; this bundle does not use the Tauri updater manifest.

The release job uses the GNOME 51 Flatpak CI image. Its Forgejo Docker runner
must allow nested bubblewrap sandboxes with `container.privileged: true` in the
runner's configuration. Forgejo does not accept `--privileged` through workflow
`container.options`. The job checks sandbox support before downloading sources.

`bun scripts/flatpak-sources.ts --release` regenerates pinned dependency downloads
and writes `flatpak-release.json` using the checked-out release commit, without
the development patch described below. It requires `RELEASE_TAG` to match
both HEAD and the package version. CI downloads sources first, then builds with
`--disable-download --sandbox`; application build commands have no network access.

## Local builds

This packaging is for local build and validation. Flathub's current
[AI policy](https://docs.flathub.org/docs/for-app-authors/requirements#generative-ai-policy)
prohibits AI-generated or AI-assisted manifests, even with disclosure. A maintainer
must independently author the submission manifest. Do not submit these generated
files as a compliant Flathub manifest. Application assistance is disclosed in
`docs/ai-assistance.md`.

## Source preparation

From the repository root, using exactly the Bun version in `package.json`:

```sh
bun scripts/flatpak-sources.ts
bun run check:flatpak-sources
```

Generation is an online maintenance operation. Commit the resulting source JSON
files together with dependency changes. The Flatpak build never generates or
resolves its dependency sources online:

- `bun-toolchain-sources.json`: SHA-256-pinned Bun executables for x86_64 and
  aarch64, used only during the build, outside `/app`.
- `bun-sources.json`: npm tarballs with the SHA-512 integrity values from
  `bun.lock`, extracted into the pinned Bun version's cache layout. Architecture
  filters cover Linux x64 and arm64 native packages. Missing optional subtrees
  are included as well. No host package cache or `node_modules` is consumed.
- `cargo-sources.json`: every registry crate in `Cargo.lock`, pinned by its
  lockfile checksum, with vendor checksums and offline Cargo configuration.
  Generation rejects unhandled Git registries instead of omitting them.
- `application.patch`: application changes relative to the pinned source commit
  for local development builds. Regenerate after application changes. Release
  builds use the published tag's source revision without this patch.
- `source-locks.json`: input/output hashes and the application base revision.
  `bun run check:flatpak-sources` rejects stale dependency inputs or application
  snapshots without network access. `bun scripts/flatpak-sources.ts --snapshot`
  refreshes just the application patch after nondependency application edits.

`bun install --offline --frozen-lockfile --ignore-scripts` installs from these
sources. The MCP preparation step runs explicitly for Cargo's optional path
manifest; the bridge stays disabled in release builds. Cargo uses `--frozen` and
`CARGO_NET_OFFLINE=true`. SDKs and extensions must also be installed before build.

## Build and lint

```sh
flatpak install --user -y flathub org.flatpak.Builder org.gnome.Sdk//51 \
  org.freedesktop.Sdk.Extension.rust-stable//26.08
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest dev.yumeo.yumusic.json
flatpak run --command=flatpak-builder-wrapper org.flatpak.Builder \
  --user --arch=x86_64 --sandbox --force-clean \
  --mirror-screenshots-url=https://dl.flathub.org/media --compose-url-policy=full \
  --repo=flatpak-repo flatpak-build dev.yumeo.yumusic.json
flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo flatpak-repo
flatpak build-bundle flatpak-repo YuMusic-x86_64.flatpak dev.yumeo.yumusic
flatpak install --user -y ./YuMusic-x86_64.flatpak
flatpak run dev.yumeo.yumusic
```

Use the same commands with `--arch=aarch64` and separate build/repository paths
on a native ARM64 runner. Install that architecture's Platform, SDK and Rust
extension beforehand. An x86_64 host without ARM binfmt emulation cannot execute
an ARM SDK; downloading ARM sources is not an ARM build or runtime test.

To prove source downloads have finished separately, first run the builder with
`--download-only`, then build with `--disable-download --sandbox`. Flathub's
Builder also provides `flathub-build` for its full recommended build pipeline.
No build command receives network access.

## Sandbox permissions

Network is needed for authentication, streaming, lyrics, and optional listening
services. PulseAudio provides playback, DRI provides accelerated WebKit rendering,
and Wayland/fallback X11 plus IPC support desktop windows. The default app-ID
MPRIS ownership grant matches `org.mpris.MediaPlayer2.dev.yumeo.yumusic`; no extra
bus permission is needed. Links use the opener portal. Downloads and account
state stay in the app's private XDG directories; there is no home/host filesystem
permission. Discord IPC is not granted and must be treated as unavailable until
separately supported and tested.

## Metadata and licensing review

The application declares GPL-3.0-only consistently in `package.json`, Cargo and
AppStream. The installer places the root license in
`/app/share/licenses/dev.yumeo.yumusic/LICENSE`. `install-notices.py` also installs
upstream dependency license and NOTICE files, a machine-readable inventory, and
`THIRD-PARTY-NOTICES.txt` in that directory. It includes build-only and
other-platform dependencies, so its list over-approximates the shipped program.
It preserves original license expressions; it does not silently choose one side
of an OR expression or assert legal compatibility. Missing upstream texts or
declarations are explicitly marked `review_required`.

Before distribution, resolve missing notices for code actually shipped, review
MPL-2.0 source availability (including selectors/cssparser), Unicode data and
CDLA-Permissive-2.0 notices, and the Apache/BSD notices in protobuf. Check the
romanization dictionaries and bundled assets separately. SDK/runtime libraries
are provided by the runtime rather than copied into the app. Preserve the
corresponding application and patched dependency source for the distributed
build. This inventory is an engineering audit, not a legal clearance.

OARS now sets `social-info=intense`: authenticated service requests and optional
ListenBrainz submissions associate listening activity with an account. The OARS
questionnaire explicitly counts online APIs and identifiable information sharing.
Music/lyrics content varies with the service; the rating does not claim a
parental content filter. A maintainer must review the questionnaire and third
party service behavior before submission.

The application ID `dev.yumeo.yumusic` matches desktop files, icons, native media
controls, Cargo/Tauri configuration, and AppStream. Forks using a different ID
must update these consistently, including manifest filenames and build scripts.
For a Flathub submission, choose an ID the publisher can verify and follow
Flathub's domain or repository ownership verification process. A reachable URL
or Git remote alone does not establish ownership.

## Runtime acceptance matrix

Record PASS/FAIL/BLOCKED separately for each architecture. Static analysis,
unit tests, a host build, and a source download do not count as a Flatpak runtime
pass. Test the installed release build with its normal permissions:

| Area           | Required evidence                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| Login          | Google login window opens; sign in; library loads; restart preserves session; sign out removes access.      |
| Playback       | Search, play/pause, seek, next/previous; audible output; resume after minimizing; supported stream codecs.  |
| Lyrics         | Load plain and synchronized lyrics; follow playback; switch providers; optional romanization.               |
| Downloads      | Download a permitted track; restart; play without network; remove it; files remain inside private app data. |
| Media controls | Desktop identifies YuMusic; metadata/artwork update; media keys, seek, and desktop play/pause work.         |
| Portal links   | An external HTTPS link opens in the host browser through OpenURI; no host spawning permission.              |
| Self-updates   | Update UI is absent; no updater request or installation is possible in the sandbox.                         |

Record the application version, architecture, and results when validating a build.
