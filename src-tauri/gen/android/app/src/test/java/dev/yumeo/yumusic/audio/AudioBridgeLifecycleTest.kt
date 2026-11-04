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
import org.robolectric.shadows.ShadowPowerManager

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
    val wakeLock = ShadowPowerManager.getLatestWakeLock()
    try {
      assertFalse("An idle producer must not hold the CPU awake", wakeLock.isHeld)
      AudioBridge.hostPaused()
      assertTrue(paused)
      AudioBridge.playback(true)
      assertTrue("Playback must protect the producer before the native deck ends", wakeLock.isHeld)
      assertFalse("Audio work must stay resumed when the activity pauses", paused)
      AudioBridge.playback(false)
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(5))
      assertFalse("The next stream can still be loading", paused)
      assertTrue("The CPU must remain awake while the next stream loads", wakeLock.isHeld)
      AudioBridge.playback(true)
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(35))
      assertFalse("Resumed playback cancels the pending suspension", paused)
      assertTrue(wakeLock.isHeld)
      AudioBridge.playback(false)
      // Native clock ticks continue to report an ended/idle deck. They must
      // not refresh the deadline and keep a finished queue awake forever.
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(30))
      AudioBridge.playback(false)
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(5))
      assertTrue("A stopped player must not keep background UI work running", paused)
      assertFalse("A finished queue must release the producer wake lock", wakeLock.isHeld)
      AudioBridge.hostResumed()
      assertFalse(paused)
    } finally {
      AudioBridge.playback(false)
      AudioBridge.hostResumed()
      AudioBridge.detach(view)
      view.destroy()
    }
  }

  @Test fun detachingDuringPlaybackReleasesTheProducerWakeLock() {
    val view = WebView(RuntimeEnvironment.getApplication())
    AudioBridge.attach(view)
    val wakeLock = ShadowPowerManager.getLatestWakeLock()
    try {
      AudioBridge.playback(true)
      assertTrue(wakeLock.isHeld)
      AudioBridge.detach(view)
      assertFalse("Destroying the activity must release its producer lock", wakeLock.isHeld)
    } finally {
      AudioBridge.playback(false)
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(35))
      AudioBridge.detach(view)
      AudioBridge.hostResumed()
      view.destroy()
    }
  }
}
