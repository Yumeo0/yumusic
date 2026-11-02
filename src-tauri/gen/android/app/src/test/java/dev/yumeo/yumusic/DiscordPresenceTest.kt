package dev.yumeo.yumusic

import android.content.Context
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class DiscordPresenceTest {
  @Test fun disabledPresenceDoesNotLoadNativeCodeAtStartupOrShutdown() {
    // Robolectric has no Android native SDK library: either call loading it
    // eagerly would throw UnsatisfiedLinkError and break every app startup.
    DiscordPresence.clear()
    DiscordPresence.shutdown()
  }

  @Test fun rpcIntegrationDoesNotAddVoicePermissionsOrAuthComponents() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val info = context.packageManager.getPackageInfo(context.packageName,
      PackageManager.GET_PERMISSIONS or PackageManager.GET_ACTIVITIES or PackageManager.GET_SERVICES)
    val permissions = info.requestedPermissions?.toSet().orEmpty()
    assertFalse(permissions.contains("android.permission.RECORD_AUDIO"))
    assertFalse(permissions.contains("android.permission.FOREGROUND_SERVICE_MICROPHONE"))
    assertFalse(permissions.contains("android.permission.BLUETOOTH_CONNECT"))
    assertFalse(info.activities.orEmpty().any { it.name == "com.discord.socialsdk.AuthenticationActivity" })
    assertFalse(info.services.orEmpty().any { it.name == "com.discord.socialsdk.ForegroundService" })
    assertTrue(info.services.orEmpty().any { it.name.endsWith("audio.PlaybackService") })
  }
}
