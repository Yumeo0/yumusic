# Android release builds

Pushing a `vX.Y.Z` tag runs the Android job in
[the Forgejo release workflow](../.forgejo/workflows/release.yml). It builds one
universal release APK for ARM64, ARMv7, x86, and x86_64, signs it, verifies the
signature with `apksigner`, and attaches `YuMusic_X.Y.Z_universal.apk` to the
same Forgejo release as the desktop packages and Flatpak. Android downloads do
not enter the desktop Tauri updater manifest.

The runner installs Java 21, Android SDK 36, Build Tools 36.0.0, NDK
28.2.13676358, CMake 3.22.1, and the four Rust Android targets. The version is
read from the release tag; Tauri derives Android's increasing `versionCode`
from the semantic version. Builds run in parallel with the existing jobs.

## One-time repository configuration

In the Forgejo repository's **Settings → Actions → Secrets**, add:

| Secret                      | Value                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `DISCORD_SOCIAL_SDK_URL`    | Private HTTPS download URL for the SDK ZIP. A signed download URL works; renew it before it expires. |
| `DISCORD_SOCIAL_SDK_SHA256` | SHA-256 of the exact ZIP served by that URL.                                                         |
| `ANDROID_KEYSTORE_BASE64`   | Base64 encoding of the permanent release keystore file.                                              |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password.                                                                                   |
| `ANDROID_KEY_ALIAS`         | Signing key alias inside that keystore.                                                              |
| `ANDROID_KEY_PASSWORD`      | Signing key password; repeat the keystore password here when they match.                             |

The job checks these secrets before installing the toolchains. It downloads
the SDK on every release and verifies its hash before Gradle imports it.
The SDK and signing key stay out of source control and uploaded build caches.
The signing key is removed after signing, including when signing fails.
Only the finished APK is published.

### Discord SDK download

Discord distributes this SDK through the Developer Portal rather than a public
Maven repository. Each build runner needs its own SDK import.
Place the SDK ZIP in private object storage or another private HTTPS download
location and use its download URL above. Do not add the archive to Git or a
public release asset. See [Discord SDK setup](android-discord.md).

The archive can be the original standalone C++ SDK 1.10.19337 ZIP, or a smaller
ZIP containing just these two files with exactly these paths:

```text
discord_social_sdk/lib/release/discord_partner_sdk.aar
discord_social_sdk/License-Notices.txt
```

Both files must come from the same SDK version. The notices are bundled in the
APK. Compute the checksum on Linux with:

```sh
sha256sum /path/to/DiscordSocialSdk-1.10.19337.zip
```

On macOS, use `shasum -a 256` with the same archive path. On Windows:

```powershell
Get-FileHash -Algorithm SHA256 /path/to/DiscordSocialSdk-1.10.19337.zip
```

Use the hash of the smaller ZIP instead if you host that archive. Upload the
ZIP unchanged; the checksum must match the bytes downloaded by CI.

### Permanent Android signing key

Reuse your existing release keystore if an APK has already been distributed.
Otherwise, create a key once using the JDK's interactive `keytool`:

```sh
keytool -genkeypair -v -keystore "$HOME/yumusic-release.jks" -storetype JKS -keyalg RSA -keysize 2048 -validity 10000 -alias yumusic
```

On Windows:

```powershell
keytool -genkeypair -v -keystore "$env:USERPROFILE/yumusic-release.jks" -storetype JKS -keyalg RSA -keysize 2048 -validity 10000 -alias yumusic
```

Back up this file and its passwords securely. Android requires updates to use
the same signing key; generating a new key per build prevents installed users
from upgrading. The key is separate from the desktop updater signing key.
See [Tauri's Android signing documentation](https://v2.tauri.app/distribute/sign/android/).

Encode the keystore as Base64 for the secret field on Linux or macOS:

```sh
base64 < "$HOME/yumusic-release.jks" | tr -d '\n'
```

On Windows, copy the Base64 value directly to the clipboard:

```powershell
Set-Clipboard ([Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE/yumusic-release.jks")))
```

The workflow signs Gradle's unsigned release APK with this key and verifies it
before publishing. It fails if the key, credentials, SDK, or expected APK is
missing; it never publishes an unsigned fallback. Your local debug signing
configuration is independent of these repository secrets.

For a fork, configure the release destination and desktop updater keys as
described in [release hosting](setup.md#release-hosting). Repository secrets
must be set on the repository running the workflow, including when source is
mirrored to another Git host.
