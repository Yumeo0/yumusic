package dev.yumeo.yumusic.audio

import android.view.View
import android.webkit.WebView
import dev.yumeo.yumusic.RustWebView
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowWebView

/** Observe the visibility actually delivered to WebView/Chromium, rather than
 * the visibility reported by the surrounding Android window. */
@Implements(WebView::class)
class AudioVisibilityShadow : ShadowWebView() {
  var rendererVisibility = View.VISIBLE
    private set

  @Implementation
  protected fun onWindowVisibilityChanged(visibility: Int) {
    rendererVisibility = visibility
  }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [AudioVisibilityShadow::class])
class BackgroundAudioWebViewTest {
  @Test fun generatedProducerUsesTheAudioAwareWebViewAfterTemplatePatching() {
    assertTrue(BackgroundAudioWebView::class.java.isAssignableFrom(RustWebView::class.java))
  }

  @Test fun audioWorkKeepsHiddenWindowsRunningAndRestoresTheirActualVisibility() {
    val view = BackgroundAudioWebView(RuntimeEnvironment.getApplication())
    val renderer = Shadow.extract<AudioVisibilityShadow>(view)
    try {
      view.dispatchWindowVisibilityChanged(View.GONE)
      assertEquals(View.GONE, renderer.rendererVisibility)
      view.setAudioActive(true)
      assertEquals("Audio may start after the activity is already hidden", View.VISIBLE, renderer.rendererVisibility)
      view.dispatchWindowVisibilityChanged(View.INVISIBLE)
      assertEquals("Screen lock must not suspend the producer", View.VISIBLE, renderer.rendererVisibility)
      view.setAudioActive(false)
      assertEquals("Idle views must receive the most recent host visibility", View.INVISIBLE, renderer.rendererVisibility)
      view.dispatchWindowVisibilityChanged(View.VISIBLE)
      assertEquals(View.VISIBLE, renderer.rendererVisibility)
      view.setAudioActive(true)
      view.setAudioActive(false)
      assertEquals("Finishing audio work in the foreground must not hide the view", View.VISIBLE, renderer.rendererVisibility)
    } finally {
      view.destroy()
    }
  }
}
