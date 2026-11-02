package dev.yumeo.yumusic

import android.app.Activity
import android.os.Handler
import android.os.Looper
import androidx.annotation.Keep
import com.discord.socialsdk.DiscordSocialSdkInit
import org.json.JSONObject

/** All SDK calls and callbacks run on the main thread, including background audio. */
@Keep
object DiscordPresence {
  private val handler = Handler(Looper.getMainLooper())
  private var initialized = false
  private val dispose = Runnable {
    handler.removeCallbacks(callbacks)
    nativeShutdown()
    initialized = false
  }
  private val callbacks = object : Runnable {
    override fun run() {
      if (!initialized) return
      nativeRunCallbacks()
      handler.postDelayed(this, 250)
    }
  }

  fun update(activity: Activity, data: String) {
    handler.removeCallbacks(dispose)
    DiscordSocialSdkInit.setEngineActivity(activity)
    if (!initialized) {
      System.loadLibrary("yumusic_discord")
      initialized = true
      handler.post(callbacks)
    }
    val payload = JSONObject(data)
    val track = payload.getJSONObject("track")
    fun optional(key: String) = if (track.isNull(key)) "" else track.optString(key)
    nativeUpdate(payload.getString("applicationId").toLong(),
      track.getString("title"), track.getString("artist"), optional("album"),
      optional("coverUrl"), track.getString("songUrl"), optional("artistUrl"),
      optional("albumUrl"), track.getBoolean("playing"),
      track.getDouble("elapsedSecs"), track.getDouble("durationSecs"))
  }

  fun clear() {
    if (!initialized) return
    nativeClear()
    handler.removeCallbacks(dispose)
    // Allow the queued clear to reach Discord before disposing the client.
    handler.postDelayed(dispose, 1000)
  }

  fun shutdown() = clear()

  private external fun nativeUpdate(appId: Long, title: String, artist: String,
    album: String, cover: String, songUrl: String, artistUrl: String, albumUrl: String,
    playing: Boolean, elapsed: Double, duration: Double)
  private external fun nativeClear()
  private external fun nativeRunCallbacks()
  private external fun nativeShutdown()
}
