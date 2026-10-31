package dev.yumeo.yumusic

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.annotation.Keep
import java.security.KeyStore
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

class MainActivity : TauriActivity() {
  private val poTokens by lazy { PoTokenWebView(this) }
  private var appWebView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
  }

  @Keep
  fun beginPoToken(id: String, binding: String, script: String) = poTokens.begin(id, binding, script)

  @Keep
  fun pollPoToken(id: String): String? = poTokens.poll(id)

  @Keep
  fun resetPoToken() = poTokens.reset()

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
    poTokens.reset()
    super.onDestroy()
  }
}
