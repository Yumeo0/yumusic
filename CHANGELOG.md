# Changelog

## [Unreleased]

### Features

- Added Discord Rich Presence on Android through the installed Discord app, using the existing Rich presence setting.
- Added a fullscreen sleep timer that stops after the queue, a chosen duration while finishing the last song, or a chosen number of songs.

### Improvements

- Mobile queue dragging follows the finger and springs between the existing closed, half-height, and fullscreen stages, with light haptic feedback as drag stages change, including returning to neutral. Gestures can also start on header buttons.
- Mobile player transitions slide the background at a fixed size, grow the cover glow in place, and quickly fade controls without a miniplayer destination.
- Releases now include a signed Android APK for direct installation.
- Mobile song rows now spring between two right-swipe stages: play next and add to the end of the queue. Swipe queued songs or autoplay recommendations left to remove them, and toggle autoplay from the queue.
- The mobile miniplayer supports left/right swipes for next/previous, opens fullscreen from artist and album text, and places the audio/device center beside the play button.
- Added mobile haptic feedback for playback actions, sliders, and song swipe stages (including returning to neutral), using Android's system feedback preferences. Menu opening and vertical player gestures stay quiet, and context menus use a single native long-press vibration.

### Bug fixes

- Fixed Android audio stopping after locking the phone and leaving the current track unable to seek.
- Fixed heavy stutters during crossfades between songs.

## [0.9.0] - 2026-11-01

### Features

- Added dedicated Playlists and Albums search filters, plus context menus for artist, channel, playlist, and album search results.
- Pasted YouTube links can now open channels, playlists, and albums, alongside the existing song preview.
- Android can receive YouTube Music links from other apps and the share sheet, including when YuMusic is not running.

### Improvements

- Combined volume and device controls into one compact panel that stays above the queue, with the same audio icon in the miniplayer and fullscreen player.
- Device listings now show cover art with playback status badges, formatted song titles and artists, and clearer transfer controls.
- The miniplayer stays visible when idle. Listen together and desktop repeat sit beside the playback controls, ratings expand on hover, and playtime appears at the right.
- Mobile playback uses full app volume controlled by the phone's volume keys; device management is available from the player.
- Fullscreen transitions now move Listen together and audio controls to their miniplayer positions, fade the moving background, and hide duplicate controls during the handoff.
- Cover artwork automatically crops black bars, including in search results.
- Listen together opens in an anchored desktop panel and shows the local audio choice after joining another person's room.
- Artist and channel pages now include a share button and public Personal mix playlists.

### Bug fixes

- Fixed playlist edits not updating the Playlists tab and newly added songs not appearing in an open playlist.
- Fixed duplicate pins when opening the same playlist through the library and a pasted link; existing duplicate pins are merged.
- Fixed channel search omitting ordinary YouTube channels and added support for opening their pages.
- Fixed missing artist links on tracks whose artist metadata was unavailable in the initial listing.
- Fixed the miniplayer album link and channel profile pictures displaying banners instead of avatars.

## [0.8.0] - 2026-11-01

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
