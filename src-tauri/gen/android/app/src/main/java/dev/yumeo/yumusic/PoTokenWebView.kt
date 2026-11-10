package dev.yumeo.yumusic

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Dialog
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import dev.yumeo.yumusic.audio.BackgroundAudioWebView
import org.json.JSONObject

/** A separate view runs YouTube's ready minter without navigating the music UI. */
class PoTokenWebView(private val activity: Activity) {
  private val handler = Handler(Looper.getMainLooper())
  private val results = mutableMapOf<String, String>()
  private var webView: BackgroundAudioWebView? = null
  private var consent: Dialog? = null
  private var requestId: String? = null
  private var binding = ""
  private var script = ""
  private var tick: Runnable? = null
  private var timeout: Runnable? = null

  fun begin(id: String, contentBinding: String, bridgeScript: String) {
    check(Looper.myLooper() == Looper.getMainLooper())
    requestId?.let { finish(JSONObject().put("id", it).put("error", "PO request superseded")) }
    requestId = id
    binding = contentBinding
    script = bridgeScript
    if (webView == null) webView = createWebView()
    // A new track can need attestation while the activity's window is hidden.
    webView?.setAudioActive(true)
    webView?.onResume()
    val loop = object : Runnable {
      override fun run() {
        val view = webView ?: return
        if (requestId != id) return
        if (isYouTube(Uri.parse(view.url ?: ""))) {
          view.evaluateJavascript(
            "if (!window.__yumusicMintPoToken) {$script}\n" +
              "window.__yumusicMintPoToken?.(${JSONObject.quote(id)}, ${JSONObject.quote(binding)});",
            null
          )
        }
        handler.postDelayed(this, 250)
      }
    }
    tick = loop
    handler.post(loop)
    val deadline = Runnable {
      if (requestId == id) {
        finish(JSONObject().put("id", id).put("error", "YouTube PO minter did not become ready"))
        if (consent?.isShowing != true) destroyView()
      }
    }
    timeout = deadline
    handler.postDelayed(deadline, 35000)
  }

  fun poll(id: String): String? = results.remove(id)

  fun reset() {
    requestId?.let { finish(JSONObject().put("id", it).put("error", "PO session reset")) }
    destroyView()
  }

  private fun finish(result: JSONObject) {
    val id = requestId ?: return
    if (result.optString("id") != id) return
    tick?.let(handler::removeCallbacks)
    timeout?.let(handler::removeCallbacks)
    tick = null
    timeout = null
    requestId = null
    webView?.setAudioActive(false)
    webView?.onPause()
    result.put("cookie", CookieManager.getInstance().getCookie("https://www.youtube.com/") ?: "")
    results[id] = result.toString()
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun createWebView(): BackgroundAudioWebView {
    val view = BackgroundAudioWebView(activity)
    view.settings.javaScriptEnabled = true
    view.settings.domStorageEnabled = true
    view.settings.mediaPlaybackRequiresUserGesture = true
    view.settings.allowFileAccess = false
    view.settings.allowContentAccess = false
    // Load the same desktop YouTube minter API as the verified desktop flow.
    val architecture = System.getProperty("os.arch") ?: "aarch64"
    view.settings.userAgentString = "Mozilla/5.0 (X11; Linux $architecture) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    CookieManager.getInstance().setAcceptThirdPartyCookies(view, true)
    view.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(webView: WebView, request: WebResourceRequest): Boolean {
        val url = request.url
        if (url.scheme == "yumusic-po" && url.host == "result") {
          if (request.isForMainFrame && isYouTube(Uri.parse(webView.url ?: ""))) {
            try {
              finish(JSONObject(url.getQueryParameter("payload") ?: "{}"))
            } catch (_: Exception) {
              requestId?.let { finish(JSONObject().put("id", it).put("error", "Invalid YouTube PO response")) }
            }
          }
          return true
        }
        if (url.scheme == "https" && url.host in setOf("consent.youtube.com", "consent.google.com")) {
          showConsent(webView)
          return false
        }
        return !isYouTube(url)
      }

      override fun onPageStarted(webView: WebView, url: String, favicon: Bitmap?) {
        if (isYouTube(Uri.parse(url))) consent?.dismiss()
      }

      override fun onReceivedError(webView: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (request.isForMainFrame) {
          requestId?.let { finish(JSONObject().put("id", it).put("error", "YouTube attestation page failed to load (${error.errorCode})")) }
          destroyView()
        }
      }

      override fun onRenderProcessGone(webView: WebView, detail: RenderProcessGoneDetail): Boolean {
        reset()
        return true
      }
    }
    attachBehindApp(view)
    // A fresh mobile WebView does not initialize the shared minter on Home.
    // Loading the player's page initializes it; autoplay stays gesture-gated.
    view.loadUrl(Uri.parse("https://www.youtube.com/watch").buildUpon()
      .appendQueryParameter("v", binding)
      .appendQueryParameter("autoplay", "0")
      .appendQueryParameter("hl", "en")
      .appendQueryParameter("app", "desktop")
      .build().toString())
    return view
  }

  private fun isYouTube(url: Uri) = url.scheme == "https" && url.host == "www.youtube.com"

  private fun attachBehindApp(view: WebView) {
    val root = activity.findViewById<ViewGroup>(android.R.id.content)
    root.addView(view, 0, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  private fun showConsent(view: WebView) {
    if (consent?.isShowing == true) return
    (view.parent as? ViewGroup)?.removeView(view)
    consent = Dialog(activity).apply {
      setTitle("YouTube playback setup")
      setContentView(view)
      setOnDismissListener {
        (view.parent as? ViewGroup)?.removeView(view)
        if (!activity.isFinishing && webView === view) attachBehindApp(view)
        consent = null
      }
      show()
      window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    }
  }

  private fun destroyView() {
    val view = webView
    webView = null
    consent?.dismiss()
    consent = null
    (view?.parent as? ViewGroup)?.removeView(view)
    view?.stopLoading()
    view?.destroy()
  }
}
