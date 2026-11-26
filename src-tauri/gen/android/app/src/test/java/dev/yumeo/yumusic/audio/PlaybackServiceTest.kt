package dev.yumeo.yumusic.audio

import android.media.audiofx.AudioEffect
import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.RenderersFactory
import androidx.media3.test.utils.FakeRenderer
import java.io.File
import java.time.Duration
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ServiceController
import org.robolectric.annotation.Config

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlaybackServiceTest {
  @Test fun crossfadeWaitsForPlaybackAndKeepsTheOutgoingSessionThroughTheRamp() {
    val players = mutableListOf<ExoPlayer>()
    val renderers = RenderersFactory { _, _, _, _, _ -> arrayOf(FakeRenderer(C.TRACK_TYPE_AUDIO)) }
    val controller = ServiceController.of(PlaybackService { context ->
      ExoPlayer.Builder(context, renderers).build().also { players.add(it) }
    }, null).create()
    val service = controller.get()
    try {
      val session = service.sessions.single()
      val outgoing = session.player
      val incoming = players[1]
      val file = File(service.cacheDir, "crossfade.m4a")
      file.writeBytes(javaClass.getResourceAsStream("/audio/fragmented.m4a")!!.readBytes())
      service.command(JSONObject().put("op", "load").put("deck", 0).put("id", "outgoing")
        .put("path", file.absolutePath).put("duration", 20).put("volume", 0.8).put("autoPlay", true))

      val looper = shadowOf(Looper.getMainLooper())
      fun awaitPlayback(predicate: () -> Boolean) {
        val deadline = System.nanoTime() + 5_000_000_000
        while (!predicate() && System.nanoTime() < deadline) {
          looper.idleFor(Duration.ofMillis(10))
          Thread.sleep(5)
        }
        assertTrue("Expected playback state was not reached", predicate())
      }

      fun startFade(nextId: String) = service.command(JSONObject().put("op", "crossfade")
        .put("deck", 0).put("id", "outgoing").put("nextDeck", 1).put("nextId", nextId).put("seconds", 1.0))

      awaitPlayback { outgoing.isPlaying }
      service.command(JSONObject().put("op", "load").put("deck", 1).put("id", "buffering").put("mime", "audio/mp4"))
      startFade("buffering")
      looper.idleFor(Duration.ofMillis(100))
      assertEquals(0.8f, outgoing.volume, 0f)
      assertEquals(0f, incoming.volume, 0f)
      assertSame(outgoing, session.player)
      service.command(JSONObject().put("op", "stop").put("deck", 1).put("id", "buffering"))

      service.command(JSONObject().put("op", "load").put("deck", 1).put("id", "incoming")
        .put("path", file.absolutePath).put("duration", 20).put("volume", 0.25))
      startFade("incoming")
      awaitPlayback { incoming.isPlaying }
      val playingPosition = outgoing.currentPosition
      awaitPlayback { outgoing.currentPosition >= playingPosition + 400 }
      assertEquals("Keep the outgoing volume until audio output starts", 0.8f, outgoing.volume, 0f)
      assertEquals(0f, incoming.volume, 0f)
      incoming.analyticsCollector.onAudioPositionAdvancing(System.currentTimeMillis())
      awaitPlayback { outgoing.volume in 0.2f..0.6f }
      assertSame(outgoing, session.player)
      assertEquals(0.64f, outgoing.volume * outgoing.volume + incoming.volume * incoming.volume, 0.0001f)
      awaitPlayback { outgoing.volume == 0f }
      service.command(JSONObject().put("op", "stop").put("deck", 0).put("id", "outgoing"))
      assertEquals("incoming", session.player.currentMediaItem!!.mediaId)
      assertEquals(0.8f, session.player.volume, 0f)
      assertTrue(session.player.playWhenReady)

      // A timer can keep the preload and request a handover at the exact end.
      val natural = players[0]
      service.command(JSONObject().put("op", "load").put("deck", 0).put("id", "natural")
        .put("path", file.absolutePath).put("duration", 20).put("volume", 0.25))
      awaitPlayback { natural.playbackState == Player.STATE_READY }
      val handover = JSONObject().put("op", "crossfade").put("deck", 1).put("id", "incoming")
        .put("nextDeck", 0).put("nextId", "natural").put("seconds", 0)
      service.command(handover)
      looper.idleFor(Duration.ofMillis(100))
      assertFalse(natural.playWhenReady)
      assertEquals(0.8f, incoming.volume, 0f)

      service.command(JSONObject().put("op", "seek").put("deck", 1).put("id", "incoming").put("value", 20))
      awaitPlayback { incoming.playbackState == Player.STATE_ENDED }
      service.command(handover)
      awaitPlayback { natural.isPlaying }
      natural.analyticsCollector.onAudioPositionAdvancing(System.currentTimeMillis())
      awaitPlayback { natural.isPlaying && natural.volume == 0.8f }
      service.command(JSONObject().put("op", "stop").put("deck", 1).put("id", "incoming"))
      assertEquals("natural", session.player.currentMediaItem!!.mediaId)
      assertTrue(session.player.isPlaying)
    } finally { controller.destroy() }
  }

  @Test fun sessionAdvertisesQueueControlsAndAnnouncesItsEffectsSession() {
    val controller = Robolectric.buildService(PlaybackService::class.java).create()
    val service = controller.get()
    try {
      // JNI playback has no bound controller to register this session for us.
      // An unregistered session never enters foreground and Android stops it.
      val session = service.sessions.single()
      AudioBridge.metadata(JSONObject().put("canGoNext", true).put("canGoPrevious", false).toString())
      assertTrue(session.player.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM))
      assertFalse(session.player.isCommandAvailable(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM))
      // System play requests follow the UI's room permissions.
      session.player.play()
      assertFalse(session.player.playWhenReady)
	  val file = File(service.cacheDir, "native-audio-test.m4a")
	  file.writeBytes(javaClass.getResourceAsStream("/audio/fragmented.m4a")!!.readBytes())
	  service.metadata(JSONObject().put("title", "Downloaded track").put("artist", "Artist"))
	  service.command(JSONObject().put("op", "load").put("deck", 0).put("id", "local-track").put("path", file.absolutePath))
      val sessionPlayer = session.player
      service.command(JSONObject().put("op", "play").put("deck", 0).put("id", "local-track"))
      assertSame("Repeated play must not rebuild the controller player", sessionPlayer, session.player)
	  assertEquals("Downloaded track", session.player.mediaMetadata.title.toString())
	  service.command(JSONObject().put("op", "stop").put("deck", 0).put("id", "old-track"))
	  assertEquals("local-track", session.player.currentMediaItem!!.mediaId)
	  service.command(JSONObject().put("op", "stop").put("deck", 0).put("id", "local-track"))
	  assertEquals(0, session.player.mediaItemCount)
      val effects = shadowOf(RuntimeEnvironment.getApplication()).broadcastIntents.filter { it.action == AudioEffect.ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION }
      assertEquals(1, effects.size)
      assertTrue(effects.single().getIntExtra(AudioEffect.EXTRA_AUDIO_SESSION, 0) > 0)
    } finally { controller.destroy() }
    assertTrue(shadowOf(RuntimeEnvironment.getApplication()).broadcastIntents.any { it.action == AudioEffect.ACTION_CLOSE_AUDIO_EFFECT_CONTROL_SESSION })
  }
}
