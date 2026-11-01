# Changelog

## [Unreleased]

### Features

- Added optional sync through your YouTube Google account for settings, scrobbling, pinned playlists, and Listen together profiles, permissions, and trusted people. Trust covers all linked devices.
- Added account device discovery, playback transfer, and remote playback controls.
- Added a remote-control mode for Listen together guests, with optional audio on their own device.

### Improvements

- Added a compact lyrics source picker on mobile, with press-and-drag selection and a stable header as sources load.

### Bug fixes

- Fixed artist text alignment during player and lyrics transitions.
- Fixed the volume slider appearing behind the Listen together pill.
- Fixed clearing caches removing pinned playlists and trusted devices.

## [0.7.0] - 2026-10-31

### Features

- Added Listen together with synchronized playback, a shared queue with contributor names and autoplay recommendations, and song requests.
- Added native Android audio playback with lock-screen controls, background playback, and equalizer support.

### Improvements

- Added pinning to the playlist details “More” menu.
- Home now preloads and caches all recommendation sections without waiting for scrolling, while images load as needed.
- Simplified the top controls in the mobile fullscreen player.
- Song listings now show “Song” before the artist instead of video view counts.

### Bug fixes

- Fixed Android back navigation.
- Fixed Android builds failing with Java 25.
- Fixed unexpected Google account logouts when profile information is temporarily unavailable; session checks now preserve saved credentials and recover newer browser cookies when possible.
- Fixed song title parsing for quoted music-video titles and “Official Audio” labels.
- Fixed text selection when long-pressing songs to open the context menu on mobile.
- Some UI elements not moving smoothly between positions

## [0.6.1] - 2026-10-31

### Features

- Linux releases now include a Flatpak download.

### Bug fixes

- Fixed Linux AppImage packages failing to build.

## [0.6.0] - 2026-10-31

### Features

- Added Flatpak packaging for Linux.

### Improvements

- Cached the home feed so returning to Home loads recommendations faster.
- Increased the maximum playback volume.

### Bug fixes

- Fixed playback stopping after roughly a minute when signed out or using a free account.
- Expired Google sessions now sign out cleanly, and signing back in no longer reuses stale credentials.
- The Google sign-in window now stays open until the account is verified.
- Fixed the application icon on Linux.

## [0.5.1]

### Features

- Added Genius as a lyrics source.
- Added repeat modes for individual songs and playlists.

### Improvements

- Accent colors now use the overall colors of the album artwork.
- Lyrics without timing information now preserve section labels such as verses and choruses.
- Added album information to song details.

### Bug fixes

- Improved Genius lyric searches using album titles.
