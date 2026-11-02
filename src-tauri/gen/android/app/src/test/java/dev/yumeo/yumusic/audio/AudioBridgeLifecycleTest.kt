package dev.yumeo.yumusic.audio

import android.os.Looper
import android.webkit.WebView
import androidx.media3.common.util.UnstableApi
import java.time.Duration
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AudioBridgeLifecycleTest {
  @Test fun backgroundAudioKeepsTheProducerResumedAndGivesTrackHandoffsTimeToLoad() {
    var paused = false
    val view = object : WebView(RuntimeEnvironment.getApplication()) {
      override fun onPause() { paused = true }
      override fun onResume() { paused = false }
    }
    AudioBridge.attach(view)
    try {
      AudioBridge.hostPaused()
      assertTrue(paused)
      AudioBridge.playback(true)
      assertFalse("Audio work must stay resumed when the activity pauses", paused)
      AudioBridge.playback(false)
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(5))
      assertFalse("The next stream can still be loading", paused)
      AudioBridge.playback(true)
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(35))
      assertFalse("Resumed playback cancels the pending suspension", paused)
      AudioBridge.playback(false)
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(35))
      assertTrue("A stopped player must not keep background UI work running", paused)
      AudioBridge.hostResumed()
      assertFalse(paused)
    } finally { AudioBridge.detach(view); view.destroy() }
  }
}
