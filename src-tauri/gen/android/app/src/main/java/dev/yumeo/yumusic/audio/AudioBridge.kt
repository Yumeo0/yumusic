package dev.yumeo.yumusic.audio

import android.content.Context
import android.content.Intent
import android.webkit.WebView
import android.os.Handler
import android.os.Looper
import androidx.media3.common.util.UnstableApi
import java.lang.ref.WeakReference
import org.json.JSONObject

/** Only JNI calls from the trusted Tauri command bridge can issue player commands. */
@UnstableApi
object AudioBridge {
  private var view = WeakReference<WebView>(null)
  private val pending = ArrayDeque<JSONObject>()
  private var metadata: JSONObject? = null

  private val main = Handler(Looper.getMainLooper())
  private var paused = false
  private var playbackRequested = false
  private var playbackActive = false
  private val suspendView = Runnable { playbackActive = false; applyLifecycle() }

  private fun applyLifecycle() {
    val target = view.get() ?: return
    if (!paused || playbackActive) target.onResume() else target.onPause()
  }
  fun hostPaused() { paused = true; applyLifecycle() }
  fun hostResumed() { paused = false; applyLifecycle() }
  fun playback(active: Boolean) {
    if (playbackRequested == active) return
    playbackRequested = active
    main.removeCallbacks(suspendView)
    if (active) { playbackActive = true; applyLifecycle() }
    // Leave time for the next track's asynchronous attestation/stream load.
    else main.postDelayed(suspendView, 35000)
  }
  fun attach(webView: WebView) { view = WeakReference(webView); applyLifecycle() }
  fun detach(webView: WebView?) {
    if (view.get() === webView) {
      view.clear()
      main.removeCallbacks(suspendView)
      playbackActive = playbackRequested
    }
  }
  fun emit(event: JSONObject) {
    val target = view.get() ?: return
    target.post {
      if (view.get() === target)
        target.evaluateJavascript("window.dispatchEvent(new CustomEvent('yumusic-native-audio',{detail:${event}}))", null)
    }
  }
  fun command(context: Context, data: String) {
    val command = JSONObject(data)
    val service = PlaybackService.instance
    if (service != null) service.command(command)
    else {
      pending.addLast(command)
      context.startService(Intent(context, PlaybackService::class.java))
    }
  }
  fun ready(service: PlaybackService) {
    metadata?.let { service.metadata(it) }
    while (pending.isNotEmpty()) service.command(pending.removeFirst())
  }
  fun metadata(data: String) {
    metadata = JSONObject(data)
    PlaybackService.instance?.metadata(metadata!!)
  }
  fun append(deck: Int, id: String, epoch: Int, bytes: ByteArray): Boolean =
    PlaybackService.instance?.append(deck, id, epoch, bytes) ?: true
}
