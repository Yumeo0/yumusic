package dev.yumeo.yumusic

import android.content.Intent
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.annotation.Keep
import androidx.media3.common.util.UnstableApi
import dev.yumeo.yumusic.audio.AudioBridge
import java.security.KeyStore
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

@UnstableApi
class MainActivity : TauriActivity() {
  private val poTokens by lazy { PoTokenWebView(this) }
  private var appWebView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    AudioBridge.attach(webView)
  }

  @Keep
  fun beginPoToken(id: String, binding: String, script: String) = poTokens.begin(id, binding, script)

  @Keep
  fun pollPoToken(id: String): String? = poTokens.poll(id)

  @Keep
  fun resetPoToken() = poTokens.reset()

  @Keep
  fun nativeAudioCommand(data: String) = AudioBridge.command(this, data)

  @Keep
  fun nativeAudioAppend(deck: Int, id: String, epoch: Int, bytes: ByteArray): Boolean = AudioBridge.append(deck, id, epoch, bytes)

  @Keep
  fun updateAudioMetadata(data: String) = AudioBridge.metadata(data)

  @Keep
  fun takePendingLinks(): String = IncomingLinks.takePending()

  private fun receiveLink(intent: Intent) {
    if (!IncomingLinks.accept(intent)) return
    // A configuration recreation must not replay an already queued intent.
    intent.data = null
    intent.removeExtra(Intent.EXTRA_TEXT)
    appWebView?.let { view ->
      view.post {
        if (appWebView === view)
          view.evaluateJavascript("window.dispatchEvent(new Event('yumusic-open-links'))", null)
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    receiveLink(intent)
  }

  @Keep
  fun trustedRootCertificates(): Array<ByteArray> {
    val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    factory.init(null as KeyStore?)
    return factory.trustManagers.filterIsInstance<X509TrustManager>().first()
      .acceptedIssuers.map { it.encoded }.toTypedArray()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    receiveLink(intent)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val view = appWebView
        if (view == null) {
          moveTaskToBack(true)
          return
        }
        view.evaluateJavascript("window.__yumusicBack ? window.__yumusicBack() : null") { handled ->
          when (handled) {
            "true" -> Unit
            "false" -> moveTaskToBack(true)
            else -> if (view.canGoBack()) view.goBack() else moveTaskToBack(true)
          }
        }
      }
    })
  }

  override fun onDestroy() {
    AudioBridge.detach(appWebView)
    poTokens.reset()
    super.onDestroy()
  }
}
