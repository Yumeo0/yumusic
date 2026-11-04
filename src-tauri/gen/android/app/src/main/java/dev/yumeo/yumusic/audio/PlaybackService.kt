package dev.yumeo.yumusic.audio

import android.app.PendingIntent
import android.content.Intent
import android.media.AudioManager
import android.media.audiofx.AudioEffect
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import dev.yumeo.yumusic.MainActivity
import java.io.File
import org.json.JSONObject

/** The service owns Android's decoders, AudioTrack, focus and system media session.
 * Both decks share one audio session so an external equalizer also covers crossfades. */
@UnstableApi
class PlaybackService : MediaSessionService() {
  companion object { var instance: PlaybackService? = null; private set }
  private data class Deck(val player: ExoPlayer, var id: String = "", var source: SabrMediaSource? = null)
  private lateinit var decks: Array<Deck>
  private var session: MediaSession? = null
  private var active = 0
  private var audioSession = 0
  private var snapshot = JSONObject()
  private val main = Handler(Looper.getMainLooper())
  private val clock = object : Runnable {
    override fun run() { decks.forEachIndexed { i, deck -> if (deck.id.isNotEmpty()) publish(i) }; main.postDelayed(this, 250) }
  }

  override fun onCreate() {
    super.onCreate()
    audioSession = (getSystemService(AUDIO_SERVICE) as AudioManager).generateAudioSessionId()
    decks = Array(2) { index ->
      val player = ExoPlayer.Builder(this)
        .setLoadControl(DefaultLoadControl.Builder().setBufferDurationsMs(15000, 45000, 500, 1000).build())
        .build().apply {
          setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), index == 0)
          setAudioSessionId(audioSession)
          setHandleAudioBecomingNoisy(true)
          setWakeMode(C.WAKE_MODE_LOCAL)
          addListener(object : Player.Listener {
            override fun onEvents(player: Player, events: Player.Events) {
              // Volume ramps are not clock ticks. Echoing each volume command
              // into JS timeupdate feeds the crossfade back into itself.
              if (events.containsAny(Player.EVENT_PLAYBACK_STATE_CHANGED,
                  Player.EVENT_PLAY_WHEN_READY_CHANGED, Player.EVENT_IS_PLAYING_CHANGED,
                  Player.EVENT_POSITION_DISCONTINUITY, Player.EVENT_TIMELINE_CHANGED,
                  Player.EVENT_PLAYBACK_SUPPRESSION_REASON_CHANGED)) publish(index)
            }
            override fun onPlayerError(error: PlaybackException) {
              AudioBridge.emit(JSONObject().put("type", "error").put("deck", index).put("id", decks[index].id).put("message", error.message ?: "Native playback failed"))
            }
          })
        }
      Deck(player)
    }
    val activity = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    session = MediaSession.Builder(this, SystemPlayer(decks[0].player))
      .setSessionActivity(activity)
      .setCallback(object : MediaSession.Callback {
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult =
          if (controller.isTrusted || controller.packageName == packageName) super.onConnect(session, controller)
          else MediaSession.ConnectionResult.reject()
      }).build()
    // Playback starts through JNI, without a MediaController binding. Register
    // immediately so MediaSessionService manages the notification/foreground
    // lifetime even when no external controller has connected yet.
    addSession(session!!)
    effects(AudioEffect.ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION)
    instance = this
    AudioBridge.ready(this)
    main.post(clock)
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo) = session

  fun command(value: JSONObject) {
    val index = value.optInt("deck", 0)
    if (index !in decks.indices) return
    val deck = decks[index]
    val op = value.getString("op")
    if (op != "load" && op != "stop" && value.optString("id") != deck.id) return
    when (op) {
      "load" -> {
        deck.source?.queue?.restart()
        deck.player.stop()
        deck.id = value.getString("id")
        deck.source = null
        val path = value.optString("path")
        val item = item(deck.id, if (path.isNotEmpty()) Uri.fromFile(File(path)) else Uri.parse("sabr://audio/${deck.id}"))
        if (path.isNotEmpty()) deck.player.setMediaSource(IndexedAudioFile.create(item, path, (value.optDouble("duration", 0.0) * 1_000_000).toLong()))
        else {
          val id = deck.id
          val source = SabrMediaSource(value.getString("mime"), (value.optDouble("duration", 0.0) * 1_000_000).toLong()) { epoch, time ->
            AudioBridge.emit(JSONObject().put("type", "stream").put("deck", index).put("id", id).put("epoch", epoch).put("position", time / 1000.0))
          }
          deck.source = source
          deck.player.setMediaSource(source.create(item))
        }
        if (index == active || decks[active].id.isEmpty() || value.optBoolean("autoPlay")) activate(index)
        deck.player.prepare()
        deck.player.playWhenReady = value.optBoolean("autoPlay")
      }
      "play" -> {
        activate(index)
        deck.player.play()
      }
      "pause" -> deck.player.pause()
      "seek" -> deck.player.seekTo((value.getDouble("value").coerceAtLeast(0.0) * 1000).toLong())
      "volume" -> deck.player.volume = value.getDouble("value").toFloat().coerceIn(0f, 1f)
      "rate" -> deck.player.playbackParameters = PlaybackParameters(value.getDouble("value").toFloat().coerceIn(0.5f, 2f))
      "end" -> deck.source?.queue?.finish(value.getInt("epoch"), value.optString("error").ifEmpty { null })
      "stop" -> {
        // A late teardown must not stop a newer track mounted on the same deck.
        if (value.optString("id") != deck.id) return
        deck.source?.queue?.restart()
        deck.source = null
        deck.id = ""
        deck.player.stop()
        deck.player.clearMediaItems()
        if (index == active) {
          val other = 1 - index
          if (decks[other].id.isNotEmpty()) activate(other)
        }
      }
    }
    if (op != "volume" && op != "rate") publish(index)
  }

  private fun activate(index: Int) {
    if (active != index) {
      // One focus owner per app: two independent focus requests would pause the
      // outgoing deck just when a native crossfade starts.
      decks[active].player.setAudioAttributes(decks[active].player.audioAttributes, false)
      active = index
      decks[active].player.setAudioAttributes(decks[active].player.audioAttributes, true)
      session?.setPlayer(SystemPlayer(decks[active].player))
    }
  }

  fun append(index: Int, id: String, epoch: Int, bytes: ByteArray): Boolean {
    if (index !in decks.indices) return true
    val deck = decks[index]
    return if (deck.id == id) deck.source?.queue?.append(epoch, bytes) ?: true else true
  }

  private fun item(id: String, uri: Uri): MediaItem = MediaItem.Builder().setMediaId(id).setUri(uri)
    .setMediaMetadata(mediaMetadata()).build()

  private fun text(key: String): String? = if (snapshot.isNull(key)) null else snapshot.optString(key).ifEmpty { null }
  private fun mediaMetadata(): MediaMetadata = MediaMetadata.Builder()
    .setTitle(text("title"))
    .setArtist(text("artist"))
    .setAlbumTitle(text("album"))
    .setArtworkUri(text("coverUrl")?.takeIf { it.startsWith("https://") }?.let(Uri::parse))
    .build()

  fun metadata(value: JSONObject) {
    // Timeline ticks come from the native player; replacing the media item every
    // five seconds would needlessly invalidate artwork and controller timelines.
    val changed = listOf("title", "artist", "album", "coverUrl", "canGoNext", "canGoPrevious").any { snapshot.opt(it) != value.opt(it) }
    snapshot = value
    if (!changed) return
    val player = decks[active].player
    player.currentMediaItem?.let { player.replaceMediaItem(player.currentMediaItemIndex, it.buildUpon().setMediaMetadata(mediaMetadata()).build()) }
  }

  private fun publish(index: Int) {
    if (!::decks.isInitialized) return
    AudioBridge.playback(decks.any {
      it.id.isNotEmpty() && it.player.playWhenReady &&
        (it.player.playbackState == Player.STATE_READY || it.player.playbackState == Player.STATE_BUFFERING)
    })
    val deck = decks[index]
    if (deck.id.isEmpty()) return
    val player = deck.player
    AudioBridge.emit(JSONObject().put("type", "state").put("deck", index).put("id", deck.id)
      .put("position", player.currentPosition / 1000.0)
      .put("duration", if (player.duration > 0) player.duration / 1000.0 else 0)
      .put("buffered", player.bufferedPosition / 1000.0)
      .put("paused", !player.playWhenReady)
      .put("ready", player.playbackState == Player.STATE_READY && player.playbackSuppressionReason == Player.PLAYBACK_SUPPRESSION_REASON_NONE)
      .put("ended", player.playbackState == Player.STATE_ENDED))
  }

  private fun control(action: String, position: Double? = null) {
    AudioBridge.emit(JSONObject().put("type", "control").put("action", action).put("position", position))
  }

  /** System commands take the same permission-aware path as the UI, so a guest
   * cannot change playback locally by using a headset or lock-screen button. */
  private inner class SystemPlayer(player: Player) : ForwardingPlayer(player) {
    override fun play() = control("play")
    override fun pause() = control("pause")
    override fun setPlayWhenReady(value: Boolean) = control(if (value) "play" else "pause")
    override fun stop() = control("stop")
    override fun seekTo(positionMs: Long) = control("set-position", positionMs / 1000.0)
    override fun seekTo(mediaItemIndex: Int, positionMs: Long) = seekTo(positionMs)
    override fun seekToDefaultPosition() = control("set-position", 0.0)
    override fun seekToDefaultPosition(mediaItemIndex: Int) = seekToDefaultPosition()
    override fun seekToNext() = control("next")
    override fun seekToNextMediaItem() = control("next")
    override fun seekToPrevious() = control("previous")
    override fun seekToPreviousMediaItem() = control("previous")
    override fun seekForward() = control("seek-by", seekForwardIncrement / 1000.0)
    override fun seekBack() = control("seek-by", -seekBackIncrement / 1000.0)
    override fun hasNextMediaItem() = snapshot.optBoolean("canGoNext")
    override fun hasPreviousMediaItem() = snapshot.optBoolean("canGoPrevious")
    override fun isCommandAvailable(command: Int) = availableCommands.contains(command)
    override fun getAvailableCommands(): Player.Commands = super.getAvailableCommands().buildUpon()
      .remove(Player.COMMAND_SET_MEDIA_ITEM)
      .remove(Player.COMMAND_CHANGE_MEDIA_ITEMS)
      .remove(Player.COMMAND_SET_REPEAT_MODE)
      .remove(Player.COMMAND_SET_SHUFFLE_MODE)
      .remove(Player.COMMAND_SET_SPEED_AND_PITCH)
      .addIf(Player.COMMAND_SEEK_TO_NEXT, hasNextMediaItem())
      .addIf(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM, hasNextMediaItem())
      .addIf(Player.COMMAND_SEEK_TO_PREVIOUS, hasPreviousMediaItem())
      .addIf(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM, hasPreviousMediaItem()).build()
  }

  private fun effects(action: String) {
    if (audioSession <= 0) return
    sendBroadcast(Intent(action).putExtra(AudioEffect.EXTRA_AUDIO_SESSION, audioSession)
      .putExtra(AudioEffect.EXTRA_PACKAGE_NAME, packageName).putExtra(AudioEffect.EXTRA_CONTENT_TYPE, AudioEffect.CONTENT_TYPE_MUSIC))
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // The SABR producer and queue live in the activity. Explicitly removing the
    // task stops its service too; ordinary backgrounding/locking keeps playback.
    decks.forEach { it.player.pause() }
    stopSelf()
  }

  override fun onDestroy() {
    AudioBridge.playback(false)
    instance = null
    main.removeCallbacksAndMessages(null)
    effects(AudioEffect.ACTION_CLOSE_AUDIO_EFFECT_CONTROL_SESSION)
    decks.forEach { it.source?.queue?.restart(); it.player.release() }
    session?.release()
    session = null
    super.onDestroy()
  }
}
