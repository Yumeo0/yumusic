# Changelog

## [Unreleased]

### Features

### Improvements

### Bug fixes

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
