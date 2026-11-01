package dev.yumeo.yumusic

import android.content.Intent
import android.net.Uri
import org.json.JSONArray

/** Retain cold-start links until the frontend has mounted its listener. */
object IncomingLinks {
  private val pending = ArrayDeque<String>()
  private val hosts = setOf("music.youtube.com", "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be")
  private val urls = Regex("https?://[^\\s<>\"']+", RegexOption.IGNORE_CASE)

  @Synchronized
  fun accept(intent: Intent): Boolean {
    val text = when (intent.action) {
      Intent.ACTION_VIEW -> intent.dataString
      Intent.ACTION_SEND -> if (intent.type == "text/plain") intent.getStringExtra(Intent.EXTRA_TEXT) else null
      else -> null
    } ?: return false
    if (text.length > 8192) return false
    val link = urls.findAll(text).map { it.value.trimEnd(')', ',', '.', ';', '!', '?') }.firstOrNull {
      val uri = Uri.parse(it)
      it.length <= 4096 && uri.scheme?.lowercase() in setOf("https", "http") &&
        uri.host?.lowercase() in hosts && uri.userInfo == null
    } ?: return false
    if (pending.size >= 16) pending.removeFirst()
    pending.addLast(link)
    return true
  }

  @Synchronized
  fun takePending(): String {
    val result = JSONArray(pending.toList()).toString()
    pending.clear()
    return result
  }
}
