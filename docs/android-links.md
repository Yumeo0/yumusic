# YouTube Music links on Android

Install a build containing the native link handler. Frontend hot reload alone
cannot add Android intent filters or the native queue bridge.

In Android Settings, open **Apps → YuMusic → Open by default**, enable
**Open supported links**, and select **music.youtube.com** under **Add link**
or the supported web addresses list. Android requires users to associate
third-party handlers with domains they cannot verify. See the
[Android documentation](https://developer.android.com/training/app-links/verify-applinks#user-association).

YouTube Music links open the song preview, playlist, album, channel/profile,
search, or library view. Home and Explore links open the home feed. Text shared
to YuMusic can also contain a regular YouTube link. Links wait until the app
has loaded and work both on a fresh launch and in an already running app.

Native regression checks:

```powershell
cd src-tauri/gen/android
./gradlew.bat :app:testArm64DebugUnitTest -x :app:rustBuildArm64Debug --tests dev.yumeo.yumusic.IncomingLinksTest
```

Intent delivery on a device (use `dev.yumeo.yumusic` for a release build):

```sh
adb shell am start -W -a android.intent.action.VIEW -d 'https://music.youtube.com/@_yumeo_' dev.yumeo.yumusic.debug
adb shell am start -W -a android.intent.action.VIEW -d 'https://music.youtube.com/playlist?list=PLBVxMRxBgGxYU6rP6w29diBkSXBSZ3hqa' dev.yumeo.yumusic.debug
```
