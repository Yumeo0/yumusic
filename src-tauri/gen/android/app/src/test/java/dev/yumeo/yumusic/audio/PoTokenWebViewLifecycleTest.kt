package dev.yumeo.yumusic.audio

import android.app.Activity
import android.net.Uri
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import dev.yumeo.yumusic.PoTokenWebView
import java.time.Duration
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadow.api.Shadow

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [AudioVisibilityShadow::class])
class PoTokenWebViewLifecycleTest {
  @Test fun aHiddenMinterRunsForEachTrackAndReturnsToIdleAfterItsResult() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup()
    val minter = PoTokenWebView(activity.get())
    try {
      minter.begin("first", "video-id", "")
      val root = activity.get().findViewById<ViewGroup>(android.R.id.content)
      val view = root.getChildAt(0) as BackgroundAudioWebView
      val renderer = Shadow.extract<AudioVisibilityShadow>(view)
      view.dispatchWindowVisibilityChanged(View.GONE)
      assertEquals("Attestation must execute while the screen is locked", View.VISIBLE, renderer.rendererVisibility)
      complete(view, "first")
      assertEquals(View.GONE, renderer.rendererVisibility)
      assertNotNull(minter.poll("first"))

      minter.begin("next", "next-video", "")
      assertSame("Reuse the ready minter for the next track", view, root.getChildAt(0))
      assertEquals("A reused minter must resume without unlocking", View.VISIBLE, renderer.rendererVisibility)
      complete(view, "next")
      assertEquals(View.GONE, renderer.rendererVisibility)
      assertNotNull(minter.poll("next"))
    } finally {
      minter.reset()
      activity.pause().stop().destroy()
    }
  }

  @Test fun aTimedOutMinterReleasesItsBackgroundVisibility() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup()
    val minter = PoTokenWebView(activity.get())
    try {
      minter.begin("timeout", "video-id", "")
      val root = activity.get().findViewById<ViewGroup>(android.R.id.content)
      val view = root.getChildAt(0) as BackgroundAudioWebView
      val renderer = Shadow.extract<AudioVisibilityShadow>(view)
      view.dispatchWindowVisibilityChanged(View.GONE)
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(35))
      assertEquals(View.GONE, renderer.rendererVisibility)
      assertEquals(0, root.childCount)
      assertTrue(JSONObject(minter.poll("timeout")!!).has("error"))
    } finally {
      minter.reset()
      activity.pause().stop().destroy()
    }
  }

  private fun complete(view: BackgroundAudioWebView, id: String) {
    val result = Uri.parse("yumusic-po://result/").buildUpon()
      .appendQueryParameter("payload", JSONObject().put("id", id).put("token", "test").toString())
      .build()
    val request = object : WebResourceRequest {
      override fun getUrl() = result
      override fun isForMainFrame() = true
      override fun isRedirect() = false
      override fun hasGesture() = false
      override fun getMethod() = "GET"
      override fun getRequestHeaders() = emptyMap<String, String>()
    }
    assertTrue(shadowOf(view).webViewClient.shouldOverrideUrlLoading(view, request))
  }
}
