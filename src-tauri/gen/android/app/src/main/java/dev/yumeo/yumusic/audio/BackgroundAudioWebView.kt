package dev.yumeo.yumusic.audio

import android.content.Context
import android.view.View
import android.webkit.WebView

/** Native audio has no HTML media element to exempt its producer from Chromium's
 * hidden-window suspension. onResume and a CPU wake lock alone do not do that. */
open class BackgroundAudioWebView(context: Context) : WebView(context) {
  private var audioActive = false
  private var hostVisibility = View.VISIBLE

  fun setAudioActive(active: Boolean) {
    if (audioActive == active) return
    audioActive = active
    applyWindowVisibility()
  }

  override fun onWindowVisibilityChanged(visibility: Int) {
    hostVisibility = visibility
    applyWindowVisibility()
  }

  private fun applyWindowVisibility() {
    // Only the renderer sees VISIBLE. The Android window stays hidden and the
    // screen stays off. Restore the real visibility as soon as audio work ends.
    super.onWindowVisibilityChanged(if (audioActive) View.VISIBLE else hostVisibility)
  }
}
